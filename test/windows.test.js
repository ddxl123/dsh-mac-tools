/**
 * Window enumeration tests: parsing and target selection are pure, so they are
 * tested without a display; one live query is exercised on macOS.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listWindows, parseWindowList, selectWindow } from '../src/windows.js'

const DOCUMENT = JSON.stringify({
  windows: [
    { id: 101, app: 'Safari', title: 'Apple', x: 10, y: 20, w: 1200, h: 800, frontmost: true },
    { id: 102, app: 'Safari', title: '', x: 30, y: 40, w: 900, h: 600, frontmost: false },
    { id: 103, app: 'Visual Studio Code', title: 'main.ts', x: 0, y: 0, w: 1400, h: 900, frontmost: false },
  ],
})

test('parses the window document', () => {
  const { windows } = parseWindowList(DOCUMENT)
  assert.equal(windows.length, 3)
  assert.deepEqual(windows[0], { id: 101, app: 'Safari', title: 'Apple', x: 10, y: 20, w: 1200, h: 800, frontmost: true })
  assert.equal(windows.filter((window) => window.frontmost).length, 1)
})

test('drops malformed entries instead of failing the list', () => {
  const { windows } = parseWindowList(JSON.stringify({
    windows: [
      { id: 0, app: 'Broken' },
      { id: 5, app: '' },
      { id: 6, app: 'Good', title: 'ok', x: 0, y: 0, w: 400, h: 300 },
      { nope: true },
    ],
  }))
  assert.equal(windows.length, 1)
  assert.equal(windows[0].app, 'Good')
})

test('rejects output that is not the expected document', () => {
  assert.throws(() => parseWindowList(''), /returned nothing/u)
  assert.throws(() => parseWindowList('{oops'), /malformed JSON/u)
  assert.throws(() => parseWindowList('{"windows": 3}'), /unexpected document/u)
})

test('selects windows by id and by application name', () => {
  const { windows } = parseWindowList(DOCUMENT)
  assert.equal(selectWindow(windows, { windowId: 103 }).app, 'Visual Studio Code')
  assert.equal(selectWindow(windows, { windowId: 999 }), undefined)
  assert.equal(selectWindow(windows, { app: 'safari' }).id, 101, 'prefers the titled window')
  assert.equal(selectWindow(windows, { app: 'Visual Studio' }).id, 103, 'accepts a unique substring')
  assert.equal(selectWindow(windows, { app: 'Finder' }), undefined)
  assert.equal(selectWindow(windows, {}), undefined)
})

test('lists live on-screen windows on this Mac', { skip: process.platform !== 'darwin' }, async () => {
  const { windows, frontmost } = await listWindows()
  assert.ok(Array.isArray(windows))
  if (windows.length > 0) {
    assert.equal(typeof windows[0].id, 'number')
    assert.equal(typeof windows[0].app, 'string')
    assert.equal(frontmost?.id, windows[0].id)
  }
})
