/**
 * Fan control tests: the curve math, installed-file generation and preset store
 * are pure; the daemon protocol is exercised against a local fake socket server
 * (no root, no writes to the real SMC).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildAppleScript,
  buildDaemonPlist,
  buildInstallScript,
  buildUninstallScript,
  builtinPresets,
  curveRpm,
  defaultCurve,
  FanController,
  FanError,
  findOtherControllers,
  normalizeCurve,
  normalizePresetName,
  shellQuote,
} from '../src/fans.js'

const FAN_SAMPLE = Object.freeze({
  at: 1761220333000,
  fanCount: 1,
  fans: [{ index: 0, actualRpm: 2400, targetRpm: 2400, minRpm: 1000, maxRpm: 4900, mode: 'auto' }],
  temperatures: [{ key: 'Tp01', celsius: 75 }],
  groups: { cpuPerformance: 75, cpuEfficiency: 61, gpu: 55, ssd: 40, memory: 47 },
})

test('curveRpm interpolates, clamps and refuses an empty curve', () => {
  const curve = [
    { celsius: 40, rpm: 1000 },
    { celsius: 60, rpm: 2400 },
    { celsius: 90, rpm: 4900 },
  ]
  assert.equal(curveRpm(curve, 30), 1000)
  assert.equal(curveRpm(curve, 40), 1000)
  assert.equal(curveRpm(curve, 50), 1700)
  assert.equal(curveRpm(curve, 70), 3233)
  assert.equal(curveRpm(curve, 120), 4900)
  assert.equal(curveRpm([], 70), null)
  assert.equal(curveRpm(curve, null), null)
})

test('normalizeCurve sorts, dedupes, clamps and caps the point count', () => {
  assert.deepEqual(normalizeCurve([
    { celsius: 90, rpm: 4900 },
    { celsius: 40, rpm: 1000 },
    { celsius: 60, rpm: 2400 },
  ]), [
    { celsius: 40, rpm: 1000 },
    { celsius: 60, rpm: 2400 },
    { celsius: 90, rpm: 4900 },
  ])
  assert.deepEqual(normalizeCurve([
    { celsius: 60, rpm: 2400 },
    { celsius: 60, rpm: 2600 },
    { celsius: -10, rpm: -5 },
    { celsius: 'warm', rpm: 2000 },
  ]), [
    { celsius: 0, rpm: 0 },
    { celsius: 60, rpm: 2600 },
  ])
  const many = Array.from({ length: 12 }, (_, index) => ({ celsius: 30 + index, rpm: 1000 + index * 100 }))
  assert.equal(normalizeCurve(many).length, 8)
})

test('default curve and built-in presets follow the fan range', () => {
  const curve = defaultCurve(1000, 4900)
  assert.equal(curve.length, 4)
  assert.equal(curve[0].rpm, 1000)
  assert.equal(curve[curve.length - 1].rpm, 4900)
  const presets = builtinPresets(1000, 4900)
  assert.deepEqual(presets.map((preset) => preset.id), ['auto', 'quiet', 'balanced', 'performance', 'max'])
  assert.equal(presets[0].mode, 'auto')
  assert.equal(presets[1].rpm, 1000)
  assert.equal(presets[4].rpm, 4900)
  assert.ok(presets[2].rpm > presets[1].rpm && presets[2].rpm < presets[3].rpm)
})

test('preset names are trimmed and bounded', () => {
  assert.equal(normalizePresetName('  剪辑  模式 '), '剪辑 模式')
  assert.equal(normalizePresetName('x'.repeat(80)).length, 40)
  assert.equal(normalizePresetName(null), '')
})

test('shell and AppleScript escaping survives quotes and spaces', () => {
  assert.equal(shellQuote("/tmp/a b/c'd.sh"), `'/tmp/a b/c'\\''d.sh'`)
  assert.equal(buildAppleScript('/bin/bash /tmp/x y.sh'), 'do shell script "/bin/bash /tmp/x y.sh" with administrator privileges')
  assert.equal(buildAppleScript('echo "hi"'), 'do shell script "echo \\"hi\\"" with administrator privileges')
})

test('installer artifacts carry the fixed privileged surface', () => {
  const installDirectory = '/Library/Application Support/DSH Mac Tools/fan'
  const installBinary = `${installDirectory}/fan-daemon`
  const socketPath = `${installDirectory}/fan.sock`
  const plistPath = '/Library/LaunchDaemons/local.dsh.mac-tools.fan.plist'
  const label = 'local.dsh.mac-tools.fan'
  const plist = buildDaemonPlist({ label, binaryPath: installBinary, socketPath, ownerUid: 501 })
  assert.match(plist, /<string>local\.dsh\.mac-tools\.fan<\/string>/u)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u)
  assert.match(plist, /<string>501<\/string>/u)
  const install = buildInstallScript({
    sourceBinary: '/tmp/bin',
    installDirectory,
    installBinary,
    socketPath,
    plistPath,
    label,
    ownerUid: 501,
  })
  assert.match(install, /^#!\/bin\/bash/u)
  assert.match(install, /chown root:wheel/u)
  assert.match(install, /launchctl bootstrap system/u)
  assert.match(install, /DSH_FAN_PLIST/u)
  assert.match(install, /DSH_FAN_INSTALLED/u)
  assert.match(install, /--owner-uid/u)
  const uninstall = buildUninstallScript({ installDirectory, plistPath, label })
  assert.match(uninstall, /launchctl bootout system/u)
  assert.match(uninstall, /rm -rf/u)
  assert.match(uninstall, /DSH_FAN_UNINSTALLED/u)
})

test('other fan controllers are detected through pgrep', async () => {
  const calls = []
  const run = async (command, args) => {
    calls.push([command, ...args])
    if (args[1] === 'Macs Fan Control') return { stdout: '1035\n', stderr: '', code: 0 }
    throw Object.assign(new Error('no match'), { code: 'process_failed' })
  }
  const found = await findOtherControllers({ run })
  assert.deepEqual(found, [{ name: 'Macs Fan Control', pid: 1035 }])
  assert.ok(calls.some((call) => call[0] === '/usr/bin/pgrep'))
})

/**
 * A minimal stand-in for `fan-daemon` so the socket protocol and mode
 * transitions can be tested without root or a real SMC write.
 *
 * @param {string} socketPath - where to listen.
 * @param {{ failWrites?: boolean }} [options] - behaviour switches.
 * @returns {Promise<{ close: () => Promise<void>, seen: object[] }>} server handle.
 */
async function startFakeDaemon(socketPath, { failWrites = false } = {}) {
  const seen = []
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.trim() === '') continue
        const command = JSON.parse(line)
        seen.push(command)
        let response
        if (command.op === 'ping') response = { ok: true, protocol: 1, pid: 1, fanCount: 1 }
        else if (command.op === 'set' && !failWrites) response = { ok: true, fan: command.fan, rpm: command.rpm, minRpm: 1000, maxRpm: 4900 }
        else if (command.op === 'set') response = { ok: false, error: 'smc-write-failed' }
        else if (command.op === 'auto' || command.op === 'autoAll' || command.op === 'status') response = { ok: true }
        else response = { ok: false, error: 'unknown-op' }
        socket.write(`${JSON.stringify(response)}\n`)
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    seen,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Build a controller wired to temp paths plus a fake installed helper.
 *
 * @param {object} [options] - test options.
 * @returns {Promise<{ controller: FanController, cleanup: () => void, state: object }>} fixture.
 */
async function createFixture({ withDaemon = true, failWrites = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fan-test-'))
  const plistPath = join(root, 'daemon.plist')
  const installBinary = join(root, 'fan-daemon')
  writeFileSync(plistPath, 'plist')
  writeFileSync(installBinary, 'binary')
  const socketPath = join(root, 'fan.sock')
  let daemon = null
  if (withDaemon) daemon = await startFakeDaemon(socketPath, { failWrites })
  const controller = new FanController({
    stateDirectory: join(root, 'state'),
    sampleProvider: () => FAN_SAMPLE,
    plistPath,
    installBinary,
    socketPath,
    installDirectory: root,
    label: 'test.local.dsh.fan',
    run: async () => {
      throw Object.assign(new Error('no match'), { code: 'process_failed' })
    },
  })
  return {
    controller,
    daemon,
    root,
    cleanup: async () => {
      controller.dispose()
      if (daemon !== null) await daemon.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('a controller without the helper reports not-installed and refuses control', async () => {
  const controller = new FanController({
    stateDirectory: undefined,
    sampleProvider: () => FAN_SAMPLE,
    plistPath: '/nonexistent/dsh-fan/daemon.plist',
    installBinary: '/nonexistent/dsh-fan/fan-daemon',
    socketPath: '/nonexistent/dsh-fan/fan.sock',
    run: async () => {
      throw new Error('no match')
    },
  })
  const status = controller.status()
  assert.equal(status.state, 'not-installed')
  assert.equal(status.installed, false)
  assert.equal(status.mode, 'auto')
  assert.ok(status.presets.some((preset) => preset.id === 'auto'))
  assert.equal(controller.dispose(), undefined)
  await assert.rejects(() => controller.apply({ mode: 'manual', rpm: 2000 }), (error) => {
    assert.ok(error instanceof FanError)
    assert.equal(error.code, 'fan_not_ready')
    return true
  })
})

test('the socket protocol drives manual, curve and auto modes', async () => {
  const fixture = await createFixture()
  const { controller, daemon, cleanup } = fixture
  try {
    await controller.start()
    const status = controller.status()
    assert.equal(status.state, 'ready')
    assert.equal(status.running, true)
    assert.equal(status.minRpm, 1000)
    assert.equal(status.maxRpm, 4900)

    const manual = await controller.apply({ mode: 'manual', rpm: 12345 })
    assert.equal(manual.mode, 'manual')
    assert.equal(manual.manualRpm, 4900, 'rpm is clamped to the fan maximum')
    assert.equal(manual.appliedRpm, 4900)

    const curve = await controller.apply({
      mode: 'curve',
      sensor: 'cpuPerformance',
      points: [{ celsius: 40, rpm: 1000 }, { celsius: 90, rpm: 4900 }],
    })
    assert.equal(curve.mode, 'curve')
    assert.equal(curve.curve.sensor, 'cpuPerformance')
    assert.ok(curve.curve.points.length >= 2)

    const auto = await controller.apply({ mode: 'auto' })
    assert.equal(auto.mode, 'auto')
    assert.equal(auto.appliedRpm, null)
    assert.ok(daemon.seen.some((command) => command.op === 'autoAll'))
  } finally {
    await cleanup()
  }
})

test('a daemon write refusal surfaces as fan_apply_failed', async () => {
  const fixture = await createFixture({ failWrites: true })
  try {
    await fixture.controller.start()
    await assert.rejects(() => fixture.controller.apply({ mode: 'manual', rpm: 2400 }), (error) => {
      assert.ok(error instanceof FanError)
      assert.equal(error.code, 'fan_apply_failed')
      assert.equal(error.details.reason, 'smc-write-failed')
      return true
    })
  } finally {
    await fixture.cleanup()
  }
})

test('custom presets persist, list and delete', async () => {
  const fixture = await createFixture({ withDaemon: false })
  const { controller, cleanup } = fixture
  try {
    const saved = controller.savePreset({ name: '  剪辑  ', mode: 'manual', rpm: 3000 })
    const preset = saved.presets.find((entry) => entry.name === '剪辑')
    assert.notEqual(preset, undefined)
    assert.equal(preset.mode, 'manual')
    assert.equal(preset.rpm, 3000)
    assert.throws(() => controller.savePreset({ name: '剪辑', mode: 'manual', rpm: 2000 }), (error) => {
      assert.equal(error.code, 'preset_duplicate')
      return true
    })
    assert.throws(() => controller.savePreset({ name: '', mode: 'manual', rpm: 2000 }), (error) => {
      assert.equal(error.code, 'preset_invalid')
      return true
    })
    const deleted = controller.deletePreset(preset.id)
    assert.equal(deleted.presets.some((entry) => entry.id === preset.id), false)
    assert.throws(() => controller.deletePreset('auto'), (error) => {
      assert.equal(error.code, 'preset_not_found')
      return true
    })
  } finally {
    await cleanup()
  }
})

test('missing socket leads to daemon-unreachable instead of a throw', async () => {
  const fixture = await createFixture({ withDaemon: false })
  try {
    await fixture.controller.start()
    const status = fixture.controller.status()
    assert.equal(status.state, 'error')
    assert.equal(status.reason, 'daemon-unreachable')
  } finally {
    await fixture.cleanup()
  }
})
