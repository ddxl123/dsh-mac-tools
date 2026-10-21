/**
 * Global-hotkey tests: accelerator parsing, helper compilation/caching and the
 * Unix-socket trigger path. The listener itself (Carbon) is a native helper and
 * is exercised only by actually running it; these tests pin everything around
 * it without registering a real shortcut or touching the keyboard.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import {
  DEFAULT_GLOBAL_ACCELERATOR,
  GlobalHotkey,
  HotkeyController,
  HotkeyValidationError,
  MODIFIER_MASKS,
  clearHotkeyOverride,
  ensureHelperBinary,
  helperArguments,
  parseAccelerator,
  readHotkeyOverride,
  validateAcceleratorInput,
  writeHotkeyOverride,
} from '../src/hotkey.js'

test('the default accelerator is QQ-style Ctrl+Alt+A', () => {
  assert.equal(DEFAULT_GLOBAL_ACCELERATOR, 'ctrl+alt+a')
  const parsed = parseAccelerator(DEFAULT_GLOBAL_ACCELERATOR)
  assert.equal(parsed.valid, true)
  assert.equal(parsed.keyCode, 0)
  assert.equal(parsed.modifiers, MODIFIER_MASKS.ctrl | MODIFIER_MASKS.alt)
  assert.equal(parsed.label, '⌃⌥A')
  assert.equal(parsed.accelerator, 'ctrl+alt+a')
})

test('parses modifiers, aliases and special keys', () => {
  const primary = parseAccelerator('primary+shift+KeyA')
  assert.equal(primary.valid, true)
  assert.equal(primary.modifiers, MODIFIER_MASKS.cmd | MODIFIER_MASKS.shift)
  assert.equal(primary.accelerator, 'shift+cmd+a')
  assert.equal(primary.label, '⇧⌘A')

  const fkey = parseAccelerator('ctrl+f5')
  assert.equal(fkey.valid, true)
  assert.equal(fkey.keyCode, 96)
  assert.equal(fkey.label, '⌃F5')

  const command = parseAccelerator('command+option+space')
  assert.equal(command.valid, true)
  assert.equal(command.label, '⌥⌘Space')

  // Modifier order is normalized, duplicates collapse.
  assert.equal(parseAccelerator('alt+ctrl+a').label, '⌃⌥A')
  assert.equal(parseAccelerator('ctrl+control+a').label, '⌃A')
})

test('rejects unusable accelerators with a reason', () => {
  assert.equal(parseAccelerator('').valid, false)
  assert.equal(parseAccelerator('ctrl').error, 'missing-modifier-or-key')
  assert.equal(parseAccelerator('a').error, 'missing-modifier-or-key')
  assert.equal(parseAccelerator('ctrl+alt+zzz').error, 'unknown-key')
  assert.equal(parseAccelerator('hyper+a').error, 'unknown-modifier')
})

test('helper arguments carry the key code, modifier mask and socket', () => {
  const parsed = parseAccelerator('ctrl+alt+a')
  assert.deepEqual(helperArguments(parsed, '/tmp/x.sock'), ['0', '6144', '/tmp/x.sock'])
})

test('compiles the helper once and reuses the cached binary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-hotkey-build-'))
  try {
    const sourcePath = join(root, 'hotkey.swift')
    const cacheDirectory = join(root, 'cache')
    writeFileSync(sourcePath, '// version 1\n')
    const calls = []
    const run = async (_command, args) => {
      calls.push(args)
      const output = args[args.indexOf('-o') + 1]
      writeFileSync(output, 'binary')
      return { stdout: '', stderr: '', code: 0 }
    }
    const binary = await ensureHelperBinary({ sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.ok(existsSync(binary))
    assert.equal(readFileSync(binary, 'utf8'), 'binary')
    assert.equal(calls.length, 1)

    const again = await ensureHelperBinary({ sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.equal(again, binary)
    assert.equal(calls.length, 1, 'a cached helper must not recompile')

    writeFileSync(sourcePath, '// version 2\n')
    const rebuilt = await ensureHelperBinary({ sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.notEqual(rebuilt, binary, 'a changed source must produce a new binary')
    assert.equal(calls.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A child-process stand-in that reports READY and records kills.
 * @returns {object} the fake child.
 */
function fakeHelperChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  setImmediate(() => {
    child.stdout.write('READY\n')
  })
  return child
}

/**
 * Wait until a predicate holds.
 *
 * @param {() => boolean} predicate - condition.
 * @param {number} [timeoutMs] - deadline.
 * @returns {Promise<void>} resolves when true.
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition was not met in time')
}

test('a socket trigger calls the capture flow and disposal stops the helper', async () => {
  const socketPath = join(tmpdir(), `dshmac-hotkey-test-${process.pid}-${Date.now()}.sock`)
  const triggers = []
  let child = null
  const service = new GlobalHotkey({
    accelerator: 'ctrl+alt+a',
    socketPath,
    onTrigger: () => {
      triggers.push(Date.now())
    },
    compile: async () => '/bin/true',
    spawnProcess: () => {
      child = fakeHelperChild()
      return child
    },
  })
  try {
    const state = await service.start()
    assert.equal(state.enabled, true)
    assert.equal(state.active, true)
    assert.equal(state.reason, 'active')
    assert.equal(state.label, '⌃⌥A')

    await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath, () => {
        socket.write('screenshot\n')
      })
      socket.on('close', resolve)
      socket.on('error', reject)
      setTimeout(() => socket.destroy(), 500)
    })
    await waitFor(() => triggers.length === 1)
    assert.equal(triggers.length, 1)
  } finally {
    service.dispose()
  }
  assert.ok(child !== null && child.killed, 'disposing must terminate the helper')
  assert.equal(existsSync(socketPath), false, 'the socket file must be removed')
  assert.equal(service.status().reason, 'disposed')
})

test('an invalid accelerator is reported instead of started', async () => {
  const service = new GlobalHotkey({ accelerator: 'hyper+a', onTrigger: () => {} })
  const state = await service.start()
  assert.equal(state.enabled, false)
  assert.equal(state.active, false)
  assert.equal(state.reason, 'invalid-accelerator')
  service.dispose()
})

test('an empty accelerator disables the feature', () => {
  const service = new GlobalHotkey({ accelerator: '', onTrigger: () => {} })
  assert.equal(service.status().reason, 'disabled')
  service.dispose()
})


/**
 * A GlobalHotkey stand-in that records lifecycle calls.
 *
 * @param {{ created: string[], disposed: string[] }} log - shared call log.
 * @returns {typeof GlobalHotkey} the fake class.
 */
function fakeServiceClass(log) {
  return class FakeService {
    constructor(options) {
      this.options = options
      log.created.push(options.accelerator)
    }

    async start() {
      return this.status()
    }

    status() {
      return {
        enabled: this.options.accelerator !== '',
        active: this.options.accelerator !== '',
        accelerator: this.options.accelerator,
        label: this.options.accelerator.toUpperCase(),
        reason: 'active',
      }
    }

    dispose() {
      log.disposed.push(this.options.accelerator)
    }
  }
}

test('validates a user shortcut before it is applied', () => {
  assert.equal(validateAcceleratorInput('ctrl+shift+a').accelerator, 'ctrl+shift+a')
  assert.throws(() => validateAcceleratorInput(''), (error) => error instanceof HotkeyValidationError && error.reason === 'empty')
  assert.throws(() => validateAcceleratorInput('a'), (error) => error.reason === 'missing-modifier-or-key')
  assert.throws(() => validateAcceleratorInput('shift+a'), (error) => error.reason === 'missing-primary-modifier')
  assert.throws(() => validateAcceleratorInput('ctrl+hyper+a'), (error) => error.reason === 'unknown-modifier')
})

test('stores, applies, persists and resets a custom shortcut', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-hotkey-state-'))
  try {
    const statePath = join(root, 'hotkey.json')
    const log = { created: [], disposed: [] }
    const Service = fakeServiceClass(log)
    const controller = new HotkeyController({
      defaultAccelerator: 'ctrl+alt+a',
      statePath,
      onTrigger: () => {},
      warn: () => {},
      Service,
    })
    assert.equal(controller.status().source, 'config')
    assert.equal(controller.status().customized, false)

    await controller.start()
    assert.equal(controller.status().active, true)
    assert.deepEqual(log.created, ['ctrl+alt+a'])

    const updated = await controller.setAccelerator('ctrl+shift+a')
    assert.equal(updated.accelerator, 'ctrl+shift+a')
    assert.equal(updated.source, 'user')
    assert.equal(updated.customized, true)
    assert.deepEqual(log.created, ['ctrl+alt+a', 'ctrl+shift+a'])
    assert.deepEqual(log.disposed, ['ctrl+alt+a'])
    assert.equal(readHotkeyOverride(statePath), 'ctrl+shift+a')

    // A fresh controller (Harness restart) picks the stored choice up.
    const restarted = new HotkeyController({
      defaultAccelerator: 'ctrl+alt+a',
      statePath,
      onTrigger: () => {},
      warn: () => {},
      Service,
    })
    assert.equal(restarted.status().source, 'user')
    await restarted.start()
    assert.equal(restarted.status().accelerator, 'ctrl+shift+a')

    const reset = await restarted.reset()
    assert.equal(reset.source, 'config')
    assert.equal(reset.accelerator, 'ctrl+alt+a')
    assert.equal(reset.customized, false)
    assert.equal(readHotkeyOverride(statePath), undefined)
    restarted.dispose()
    controller.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an invalid stored shortcut is ignored and cannot be persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-hotkey-state-'))
  try {
    const statePath = join(root, 'hotkey.json')
    writeFileSync(statePath, JSON.stringify({ accelerator: 'hyper+a' }))
    assert.equal(readHotkeyOverride(statePath), undefined)

    const controller = new HotkeyController({
      defaultAccelerator: 'ctrl+alt+a',
      statePath,
      onTrigger: () => {},
      warn: () => {},
      Service: fakeServiceClass({ created: [], disposed: [] }),
    })
    assert.equal(controller.status().source, 'config')
    await assert.rejects(controller.setAccelerator('a'), HotkeyValidationError)
    controller.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('override helpers write atomically and clear', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-hotkey-state-'))
  try {
    const statePath = join(root, 'nested', 'hotkey.json')
    writeHotkeyOverride(statePath, 'ctrl+shift+a')
    assert.equal(readHotkeyOverride(statePath), 'ctrl+shift+a')
    clearHotkeyOverride(statePath)
    assert.equal(existsSync(statePath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
