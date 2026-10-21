/**
 * Pin-to-screen tests: helper compilation/caching and the manager lifecycle,
 * with a fake child process so no window is opened.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { PinError, PinManager, ensurePinHelperBinary, pinArguments, placementRect } from '../src/pin.js'

/**
 * A child-process stand-in that prints one line and records kills.
 *
 * @param {object} [options] - fake behavior.
 * @param {string} [options.line] - stdout line.
 * @returns {object} the fake child.
 */
function fakeChild({ line = 'READY\n' } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  setImmediate(() => {
    child.stdout.write(line)
  })
  return child
}

test('compiles the pin helper once and reuses the cached binary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-pin-build-'))
  try {
    const sourcePath = join(root, 'pin.swift')
    const cacheDirectory = join(root, 'cache')
    writeFileSync(sourcePath, '// version 1\n')
    const calls = []
    const run = async (_command, args) => {
      calls.push(args)
      writeFileSync(args[args.indexOf('-o') + 1], 'binary')
      return { stdout: '', stderr: '', code: 0 }
    }
    const binary = await ensurePinHelperBinary({ sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.equal(readFileSync(binary, 'utf8'), 'binary')
    assert.equal(calls.length, 1)
    const again = await ensurePinHelperBinary({ sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.equal(again, binary)
    assert.equal(calls.length, 1)
    writeFileSync(sourcePath, '// version 2\n')
    const rebuilt = await ensurePinHelperBinary({ sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.notEqual(rebuilt, binary)
    assert.equal(calls.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pins one image, tracks the window and cleans up on dispose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-pin-'))
  const children = []
  const manager = new PinManager({
    saveDirectory: join(root, 'saves'),
    tempDirectory: join(root, 'pins'),
    compile: async () => '/bin/true',
    spawnProcess: () => {
      const child = fakeChild()
      children.push(child)
      return child
    },
    warn: () => {},
  })
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const result = await manager.pin(png)
    assert.equal(result.ok, true)
    assert.equal(result.count, 1)
    assert.ok(existsSync(result.path), 'the pinned PNG must be written')
    assert.deepEqual(readFileSync(result.path), png)
    assert.equal(manager.count, 1)
    assert.equal(children.length, 1)
  } finally {
    manager.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(children[0].killed, true, 'disposal must close the pinned window')
  assert.equal(manager.count, 0)
})

test('a helper that cannot show the image rejects the pin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-pin-'))
  const manager = new PinManager({
    saveDirectory: join(root, 'saves'),
    tempDirectory: join(root, 'pins'),
    compile: async () => '/bin/true',
    spawnProcess: () => fakeChild({ line: 'ERROR image\n' }),
    warn: () => {},
  })
  try {
    await assert.rejects(manager.pin(Buffer.from('x')), (error) => error instanceof PinError && error.code === 'helper-error')
    assert.equal(manager.count, 0)
  } finally {
    manager.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing spawn is reported as a spawn failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-pin-'))
  const manager = new PinManager({
    saveDirectory: join(root, 'saves'),
    tempDirectory: join(root, 'pins'),
    compile: async () => '/bin/true',
    spawnProcess: () => {
      throw new Error('spawn failed')
    },
    warn: () => {},
  })
  try {
    await assert.rejects(manager.pin(Buffer.from('x')), (error) => error instanceof PinError && error.code === 'spawn-failed')
  } finally {
    manager.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses an empty image', async () => {
  const manager = new PinManager({ saveDirectory: '/tmp', compile: async () => '/bin/true' })
  await assert.rejects(manager.pin(Buffer.alloc(0)), (error) => error.code === 'invalid_request')
  manager.dispose()
})


test('normalizes placement rectangles and builds helper arguments', () => {
  assert.equal(placementRect({ x: 1, y: 2, w: 3, h: 4 }), undefined)
  assert.deepEqual(placementRect({ x: 1, y: 2, w: 30, h: 40 }), { x: 1, y: 2, w: 30, h: 40 })
  assert.deepEqual(pinArguments('/tmp/a.png', '/tmp/saves'), ['/tmp/a.png', '/tmp/saves', '', '', '', '', '', ''])
  assert.deepEqual(pinArguments('/tmp/a.png', '/tmp/saves', { x: 10, y: 20, w: 300, h: 200 }, '/tmp/e.sock', 'p1'), [
    '/tmp/a.png', '/tmp/saves', '10', '20', '300', '200', '/tmp/e.sock', 'p1',
  ])
})

test('the manager passes the capture rectangle to the helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-pin-'))
  const calls = []
  const manager = new PinManager({
    saveDirectory: '/tmp/saves',
    tempDirectory: join(root, 'pins'),
    compile: async () => '/bin/true',
    spawnProcess: (_binary, args) => {
      calls.push(args)
      return fakeChild()
    },
    warn: () => {},
  })
  try {
    const result = await manager.pin(Buffer.from('x'), { rect: { x: 12, y: 34, w: 560, h: 780 } })
    assert.deepEqual(calls[0].slice(2, 6), ['12', '34', '560', '780'])
    assert.equal(typeof calls[0][6], 'string', 'the helper receives the edit socket')
    assert.equal(typeof calls[0][7], 'string', 'the helper receives its pin id')
    assert.deepEqual(result.rect, { x: 12, y: 34, w: 560, h: 780 })
  } finally {
    manager.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})


test('a pinned window asking to edit calls onEdit with its record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-pin-'))
  const edits = []
  const manager = new PinManager({
    saveDirectory: '/tmp/saves',
    tempDirectory: join(root, 'pins'),
    eventSocketPath: join(root, 'events.sock'),
    compile: async () => '/bin/true',
    spawnProcess: () => fakeChild(),
    onEdit: (record) => { edits.push(record) },
    warn: () => {},
  })
  try {
    const result = await manager.pin(pngBuffer(), { rect: { x: 10, y: 20, w: 300, h: 200 } })
    assert.equal(result.ok, true)
    assert.ok(existsSync(manager.eventSocketPath), 'the edit socket must be listening')
    const [id] = [...manager.records.keys()]
    assert.equal(typeof id, 'string')
    await new Promise((resolve, reject) => {
      const socket = net.connect(manager.eventSocketPath, () => {
        socket.write(`edit ${id}\n`)
      })
      socket.on('data', () => {})
      socket.on('close', resolve)
      socket.on('error', reject)
      setTimeout(() => socket.destroy(), 500)
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(edits.length, 1)
    assert.equal(edits[0].id, id)
    assert.deepEqual(edits[0].rect, { x: 10, y: 20, w: 300, h: 200 })
  } finally {
    manager.dispose()
    assert.equal(existsSync(manager.eventSocketPath), false, 'disposal removes the edit socket')
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A tiny valid PNG header for tests that need dimensions.
 * @returns {Buffer} the bytes.
 */
function pngBuffer() {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(120, 16)
  buffer.writeUInt32BE(80, 20)
  return buffer
}
