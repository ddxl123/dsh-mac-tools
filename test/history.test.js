/**
 * Durable screenshot history: add/read/prune/remove/clear and index reload.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HistoryStore } from '../src/history.js'

/**
 * @param {string} root - parent temp directory.
 * @param {object} [options] - store options.
 * @returns {HistoryStore} the store.
 */
function makeStore(root, options = {}) {
  return new HistoryStore({ directory: join(root, 'history'), warn: () => {}, ...options })
}

test('stores captures newest first and reads them back', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-history-'))
  try {
    const store = makeStore(root)
    const first = store.add({ buffer: Buffer.from('one'), width: 100, height: 50, mode: 'full', at: '2026-01-01T00:00:00.000Z' })
    const second = store.add({ buffer: Buffer.from('two'), width: 200, height: 100, mode: 'window', rect: { x: 1, y: 2, w: 3, h: 4 } })
    assert.equal(store.list().length, 2)
    assert.equal(store.list()[0].id, second.id, 'newest first')
    assert.deepEqual(store.get(first.id).width, 100)
    assert.deepEqual(store.list()[0].rect, { x: 1, y: 2, w: 3, h: 4 })
    assert.equal(store.read(first.id).toString(), 'one')
    assert.ok(existsSync(join(root, 'history', `${first.id}.png`)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prunes the oldest entries beyond the limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-history-'))
  try {
    const store = makeStore(root, { maxItems: 2 })
    const first = store.add({ buffer: Buffer.from('a'), width: 1, height: 1 })
    const second = store.add({ buffer: Buffer.from('b'), width: 1, height: 1 })
    const third = store.add({ buffer: Buffer.from('c'), width: 1, height: 1 })
    assert.equal(store.list().length, 2)
    assert.equal(store.get(first.id), undefined)
    assert.equal(existsSync(join(root, 'history', `${first.id}.png`)), false, 'the pruned file must be deleted')
    assert.deepEqual(store.list().map((entry) => entry.id), [third.id, second.id])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('persists the index across instances and tolerates a corrupt one', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-history-'))
  try {
    const store = makeStore(root)
    const entry = store.add({ buffer: Buffer.from('persisted'), width: 10, height: 20, mode: 'app' })
    const reopened = makeStore(root)
    assert.equal(reopened.list().length, 1)
    assert.equal(reopened.list()[0].id, entry.id)
    assert.equal(reopened.read(entry.id).toString(), 'persisted')

    writeFileSync(join(root, 'history', 'index.json'), '{oops')
    const recovered = makeStore(root)
    assert.equal(recovered.list().length, 0, 'a corrupt index starts empty instead of throwing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removes one entry and clears everything', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-history-'))
  try {
    const store = makeStore(root)
    const first = store.add({ buffer: Buffer.from('a'), width: 1, height: 1 })
    const second = store.add({ buffer: Buffer.from('b'), width: 1, height: 1 })
    assert.equal(store.remove(first.id), true)
    assert.equal(store.remove('nope'), false)
    assert.equal(store.list().length, 1)
    assert.equal(existsSync(join(root, 'history', `${first.id}.png`)), false)
    store.clear()
    assert.equal(store.list().length, 0)
    assert.equal(existsSync(join(root, 'history', `${second.id}.png`)), false)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'history', 'index.json'), 'utf8')).entries, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
