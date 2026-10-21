/**
 * Harness-window visibility tests: app detection and the hide/restore decision
 * table, with the JXA runner injected so no window is ever touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AppVisibility, buildStatusScript, buildVisibilityScript, resolveHostApp } from '../src/visibility.js'

test('resolveHostApp identifies the packaged desktop app', () => {
  assert.deepEqual(
    resolveHostApp({
      platform: 'darwin',
      bundleId: 'com.deepseek.dsh',
      execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    }),
    { bundleId: 'com.deepseek.dsh', name: 'DeepSeek Harness' },
  )
  assert.deepEqual(
    resolveHostApp({ platform: 'darwin', execPath: '/Applications/Example.app/Contents/MacOS/Example' }),
    { name: 'Example' },
  )
  assert.equal(resolveHostApp({ platform: 'darwin', execPath: '/usr/local/bin/node', bundleId: '' }), undefined)
  assert.equal(resolveHostApp({ platform: 'linux', bundleId: 'com.deepseek.dsh' }), undefined)
})

test('scripts target the app by bundle id or by name', () => {
  const byBundle = buildStatusScript({ bundleId: 'com.deepseek.dsh', name: 'DeepSeek Harness' })
  assert.match(byBundle, /runningApplicationsWithBundleIdentifier\("com\.deepseek\.dsh"\)/u)
  assert.match(byBundle, /kCGWindowOwnerPID/u)
  assert.match(byBundle, /kCGWindowLayer/u)

  const hide = buildVisibilityScript({ name: 'DeepSeek Harness' }, 'hide')
  assert.match(hide, /localizedName/u)
  assert.match(hide, /app\.hide/u)
  assert.match(buildVisibilityScript({ name: 'DeepSeek Harness' }, 'show'), /app\.unhide/u)
})

/**
 * Build an AppVisibility whose JXA runner answers from a scripted state.
 *
 * @param {object} options - scripted answers.
 * @param {Array<object>} options.statuses - successive status documents.
 * @param {boolean} [options.throwOnHide] - make the hide call fail.
 * @returns {{ visibility: AppVisibility, calls: string[], waits: number[] }} the adapter and its log.
 */
function fakeVisibility({ statuses, throwOnHide = false }) {
  const calls = []
  const waits = []
  let statusIndex = 0
  const run = async (_command, args) => {
    const script = args[args.length - 1]
    if (script.includes('kCGWindowOwnerPID')) {
      calls.push('status')
      const answer = statuses[Math.min(statusIndex, statuses.length - 1)]
      statusIndex += 1
      return { stdout: JSON.stringify(answer), stderr: '', code: 0 }
    }
    if (script.includes('app.hide')) {
      calls.push('hide')
      if (throwOnHide) throw new Error('hide failed')
      return { stdout: JSON.stringify({ found: true, action: 'hide' }), stderr: '', code: 0 }
    }
    if (script.includes('app.unhide')) {
      calls.push('show')
      return { stdout: JSON.stringify({ found: true, action: 'show' }), stderr: '', code: 0 }
    }
    throw new Error(`unexpected script: ${script.slice(0, 40)}`)
  }
  const visibility = new AppVisibility({
    target: { bundleId: 'com.deepseek.dsh', name: 'DeepSeek Harness' },
    run,
    wait: async (ms) => { waits.push(ms) },
    hideDelayMs: 600,
  })
  return { visibility, calls, waits }
}

test('hides a visible, frontmost app and waits for its windows to disappear', async () => {
  const { visibility, calls, waits } = fakeVisibility({
    statuses: [
      { found: true, hidden: false, active: true, windows: 1 },
      { found: true, hidden: true, active: false, windows: 0 },
    ],
  })
  assert.deepEqual(await visibility.hide(), { hidden: true, reason: 'hidden' })
  assert.deepEqual(calls, ['status', 'hide', 'status'])
  assert.ok(waits.length > 0)
})

test('leaves an already hidden or windowless app alone', async () => {
  const hidden = fakeVisibility({ statuses: [{ found: true, hidden: true, windows: 1 }] })
  assert.deepEqual(await hidden.visibility.hide(), { hidden: false, reason: 'already-hidden' })
  assert.deepEqual(hidden.calls, ['status'])

  const windowless = fakeVisibility({ statuses: [{ found: true, hidden: false, windows: 0 }] })
  assert.deepEqual(await windowless.visibility.hide(), { hidden: false, reason: 'no-window' })
  assert.deepEqual(windowless.calls, ['status'])

  const absent = fakeVisibility({ statuses: [{ found: false }] })
  assert.deepEqual(await absent.visibility.hide(), { hidden: false, reason: 'not-running' })
})

test('reports unsupported when no app identity was detected', async () => {
  const visibility = new AppVisibility({ target: undefined })
  assert.equal(visibility.supported, false)
  assert.deepEqual(await visibility.hide(), { hidden: false, reason: 'unsupported' })
  await visibility.show()
})

test('restores via unhide and survives an unconfirmed hide animation', async () => {
  const confirmed = fakeVisibility({
    statuses: [
      { found: true, hidden: false, windows: 2 },
      { found: true, hidden: true, windows: 0 },
    ],
  })
  await confirmed.visibility.hide()
  await confirmed.visibility.show()
  assert.deepEqual(confirmed.calls, ['status', 'hide', 'status', 'show'])

  const unconfirmed = new AppVisibility({
    target: { name: 'DeepSeek Harness' },
    run: async (_command, args) => {
      const script = args[args.length - 1]
      if (script.includes('kCGWindowOwnerPID')) return { stdout: JSON.stringify({ found: true, hidden: false, windows: 1 }), stderr: '', code: 0 }
      return { stdout: JSON.stringify({ found: true }), stderr: '', code: 0 }
    },
    wait: async () => {},
    hideDelayMs: 0,
  })
  assert.deepEqual(await unconfirmed.hide(), { hidden: true, reason: 'hidden-unconfirmed' })
})
