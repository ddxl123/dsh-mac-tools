/**
 * Selection-rectangle watcher tests: report parsing plus a tracker driven by a
 * fake watcher process that writes the report file itself.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { SelectionTracker, isUsableSelection, parseSelectionReport } from '../src/selection.js'

test('parses ready, done and unusable watcher reports', () => {
  assert.deepEqual(parseSelectionReport(JSON.stringify({ status: 'ready' })), { status: 'ready', rect: undefined })
  assert.deepEqual(parseSelectionReport(JSON.stringify({ status: 'done', rect: { x: 10, y: 20, w: 300, h: 200 } })), {
    status: 'done',
    rect: { x: 10, y: 20, w: 300, h: 200 },
  })
  // A click without a drag (window picking) yields no rectangle.
  assert.deepEqual(parseSelectionReport(JSON.stringify({ status: 'done', rect: { x: 10, y: 20, w: 0, h: 0 } })), { status: 'done', rect: undefined })
  assert.deepEqual(parseSelectionReport(JSON.stringify({ status: 'done', rect: null })), { status: 'done', rect: undefined })
  assert.deepEqual(parseSelectionReport('{oops'), { status: 'unknown', rect: undefined })
  assert.deepEqual(parseSelectionReport(''), { status: 'unknown', rect: undefined })
})

test('recognizes usable selections', () => {
  assert.equal(isUsableSelection({ x: 0, y: 0, w: 10, h: 10 }), true)
  assert.equal(isUsableSelection({ x: 0, y: 0, w: 3, h: 10 }), false)
  assert.equal(isUsableSelection({ x: 'a', y: 0, w: 10, h: 10 }), false)
  assert.equal(isUsableSelection(null), false)
})

/**
 * A fake watcher child whose report file the test controls.
 *
 * @param {string} outputPath - report path.
 * @returns {object} the fake child.
 */
function fakeWatcher(outputPath) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    child.killed = true
  }
  child.writeReport = (document) => {
    writeFileSync(outputPath, JSON.stringify(document))
  }
  return child
}

test('returns the dragged rectangle and cleans up its directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-selection-test-'))
  const tracker = new SelectionTracker({
    directory,
    readyTimeoutMs: 200,
    finishTimeoutMs: 300,
    spawnProcess: () => {
      const child = fakeWatcher(join(directory, 'rect.json'))
      setImmediate(() => {
        child.writeReport({ status: 'ready' })
        child.writeReport({ status: 'done', rect: { x: 100, y: 150, w: 640, h: 480 } })
        child.emit('exit', 0, null)
      })
      return child
    },
  })
  await tracker.start()
  const result = await tracker.finish()
  assert.deepEqual(result, { rect: { x: 100, y: 150, w: 640, h: 480 } })
  assert.equal(existsSync(directory), false, 'the report directory must be removed')
  rmSync(directory, { recursive: true, force: true })
})

test('a cancelled selector yields no rectangle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-selection-test-'))
  let child
  const tracker = new SelectionTracker({
    directory,
    readyTimeoutMs: 200,
    finishTimeoutMs: 150,
    spawnProcess: () => {
      child = fakeWatcher(join(directory, 'rect.json'))
      setImmediate(() => {
        child.writeReport({ status: 'ready' })
      })
      return child
    },
  })
  await tracker.start()
  const result = await tracker.finish()
  assert.deepEqual(result, {})
  assert.equal(child.killed, true, 'the watcher must be terminated when no selection came')
  rmSync(directory, { recursive: true, force: true })
})
