/**
 * Temporary capture registry tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ShotStore } from '../src/store.js'

/** A structurally valid PNG header (signature + IHDR) without real pixel data. */
function pngHeader(width = 10, height = 20) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function makeStore(options = {}) {
  const directory = join(mkdtempSync(join(tmpdir(), 'dsh-mac-tools-test-')), 'shots')
  const store = new ShotStore({ directory, ...options })
  return { directory, store, cleanup: () => { store.dispose(); rmSync(join(directory, '..'), { recursive: true, force: true }) } }
}

function addCapture(store, bytes = pngHeader()) {
  const path = store.createPath()
  writeFileSync(path, bytes)
  return store.add({ path, width: 10, height: 20, bytes: bytes.byteLength, at: new Date().toISOString(), mode: 'full' })
}

test('registers captures, reads them back and prunes the oldest', () => {
  const { store, cleanup } = makeStore({ maxShots: 2 })
  try {
    const first = addCapture(store)
    const second = addCapture(store)
    const third = addCapture(store)
    assert.equal(store.shots.length, 2)
    assert.equal(store.get(first.id), undefined, 'the oldest record is pruned')
    assert.equal(store.get(third.id).width, 10)
    assert.equal(store.latest().id, third.id)
    assert.ok(existsSync(second.path))
    const bytes = store.read(third.id)
    assert.equal(bytes.byteLength, 33)
    assert.throws(() => store.read('smissing'), /unknown screenshot/u)
  } finally {
    cleanup()
  }
})

test('writes edited PNG bytes as a temporary file', () => {
  const { store, cleanup } = makeStore()
  try {
    const buffer = pngHeader(100, 200)
    const path = store.writeTemporary(buffer)
    assert.ok(existsSync(path))
    assert.ok(store.edited.has(path))
  } finally {
    cleanup()
  }
})

test('disposal removes the whole capture directory', () => {
  const { directory, store, cleanup } = makeStore()
  addCapture(store)
  assert.ok(existsSync(directory))
  cleanup()
  assert.equal(existsSync(directory), false)
})

test('refuses an empty capture file', () => {
  const { store, cleanup } = makeStore()
  try {
    const path = store.createPath()
    writeFileSync(path, Buffer.alloc(0))
    assert.throws(() => store.add({ path, width: 1, height: 1, bytes: 0, at: '', mode: 'full' }))
  } finally {
    cleanup()
  }
})
