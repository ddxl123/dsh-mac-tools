/**
 * Wiring tests for the dsh-mac-tools browser half.
 *
 * The client bundle is not importable: it is a plain `window.__ModuleLoader__`
 * registration that expects Browser globals and a `react` module from the
 * shell's module table. These tests recreate exactly that much environment —
 * a fake loader, a fake `document` whose `head` records injected styles, and a
 * minimal React stand-in (never the real package) — then assert the contract
 * shape the Host half and the shell rely on:
 *
 *   - one lazy factory registered under the package id;
 *   - `factory(require)` requires nothing but `'react'` and returns
 *     `{ inject, apply }` with `inject` containing `slots` and `locale`;
 *   - `apply` injects the `main` panel under key `mac-tools`, the
 *     `sidebar.panellist` entry with id `mac-tools`, the zh/en dictionaries,
 *     the single de-duplicated stylesheet, and the two global shortcuts;
 *   - the source obeys the hard constraints (no imports, no JSX, no
 *     `document.body`, no second app, no device pixel ratio);
 *   - the stylesheet uses theme tokens for chrome and the plugin class prefix.
 *
 * Everything here runs with `node --test` and no dependencies.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { test } from 'node:test'

const CLIENT_PATH = fileURLToPath(new URL('../client/index.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

const NS = 'dsh-mac-tools'
const PANEL_ID = 'mac-tools'
const STYLE_ID = `${NS}/panel.css`
const TOGGLE_SHORTCUT = 'mac-tools.toggle'
const SHOT_SHORTCUT = 'mac-tools.screenshot'

/**
 * A React stand-in good enough to materialize the factory and to inspect the
 * elements it builds. It intentionally does not render: the contract only
 * requires the registered components to be functions.
 *
 * @returns {object} the stub module.
 */
function createReactStub() {
  /** @type {Set<string>} */
  const createElementTypes = new Set()
  return {
    createElement(type, props, ...children) {
      createElementTypes.add(typeof type === 'string' ? type : (type && type.name) || 'anonymous')
      return { type, props: props === null || props === undefined ? {} : props, children }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useCallback(callback) {
      return callback
    },
    useMemo(factory) {
      return factory()
    },
    Fragment: Symbol.for('react.fragment'),
    __createElementTypes: createElementTypes,
  }
}

/**
 * A `document` stand-in. Only what the client actually touches is modelled:
 * `createElement('style')`, the `dataset`/`textContent` it writes, and the
 * `head` that records the appended node. `querySelector` returns null so the
 * stylesheet is injected once in these tests.
 *
 * @returns {object} the fake document, including the append log.
 */
function createDocumentStub() {
  const appended = []
  const head = {
    children: appended,
    appendChild(node) {
      appended.push(node)
      node.parentNode = head
      return node
    },
    removeChild(node) {
      const index = appended.indexOf(node)
      if (index >= 0) appended.splice(index, 1)
      return node
    },
  }
  return {
    head,
    appended,
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        dataset: {},
        textContent: '',
        style: {},
        children: [],
        parentNode: null,
        removed: false,
        appendChild(child) {
          this.children.push(child)
        },
        remove() {
          this.removed = true
          const parent = this.parentNode
          if (parent !== null && parent !== undefined && typeof parent.removeChild === 'function') parent.removeChild(this)
        },
      }
    },
    querySelector() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
}

/**
 * Evaluate the client bundle in a fresh VM context and materialize its factory.
 *
 * @returns {{ registrations: object[], factory: object, document: object, requireCalls: string[], React: object }} the loaded module.
 */
function loadClient(options) {
  const settings = options === undefined ? {} : options
  const registrations = []
  const document = createDocumentStub()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registrations.push(entry)
        },
      },
    },
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: settings.fetch,
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, displayErrors: true })

  assert.equal(registrations.length, 1, 'the module loader must receive exactly one registration')
  const registration = registrations[0]
  const requireCalls = []
  const React = createReactStub()
  const factory = registration.factory((name) => {
    requireCalls.push(name)
    if (name === 'react') return React
    throw new Error(`the client factory required an unexpected module: ${name}`)
  })
  return { registrations, factory, document, requireCalls, React }
}

/**
 * A fake Client root context that records every registration and runs each
 * `ctx.effect` callback eagerly, exactly as the real runtime does for setup.
 *
 * @returns {object} `{ ctx, state, setActivePanel }`.
 */
function createApplyContext() {
  const state = {
    effects: [],
    locales: [],
    injects: [],
    slots: [],
    shortcuts: [],
    layoutCalls: [],
    injections: [],
  }
  let activePanelId = null

  const shortcuts = {
    register(options) {
      state.shortcuts.push(options)
      return () => {}
    },
  }
  const layout = {
    selectPanel(panelId) {
      state.layoutCalls.push(panelId)
      activePanelId = panelId
    },
    panelInfo: {
      getSnapshot() {
        return { activePanelId }
      },
    },
  }
  const scope = {
    effect(callback) {
      const cleanup = callback()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    shortcuts,
    layout,
  }
  const ctx = {
    effect(callback, label) {
      const cleanup = callback()
      state.effects.push({ label, cleanup: typeof cleanup === 'function' ? cleanup : () => {} })
      return cleanup
    },
    locale: {
      register(namespace, dictionaries) {
        state.locales.push({ namespace, dictionaries })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(ownerKey, install) {
        state.injects.push(ownerKey)
        return install()
      },
      register(options, component) {
        state.slots.push({ options, component })
        return () => {}
      },
    },
    inject(services, install) {
      state.injections.push(services)
      return install(scope)
    },
  }
  return {
    ctx,
    state,
    setActivePanel(panelId) {
      activePanelId = panelId
    },
  }
}

/**
 * Apply the module to a fresh fake context.
 *
 * @returns {object} `{ load, ctx, state, setActivePanel }`.
 */
function applyClient(options) {
  const load = loadClient(options)
  const applied = createApplyContext()
  load.factory.apply(applied.ctx)
  return { load, ctx: applied.ctx, state: applied.state, setActivePanel: applied.setActivePanel }
}

/**
 * A successful Host envelope as a `fetch` Response stand-in.
 *
 * @param {any} value - the envelope's `value`.
 * @param {number} [status] - the HTTP status.
 * @returns {object} the response.
 */
function jsonResponse(value, status = 200) {
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    async json() {
      return ok ? { ok: true, value } : { ok: false, error: value }
    },
  }
}

/**
 * A refused-envelope response: HTTP 200 with `{ ok: false, error }`, exactly
 * the shape the Host contract uses for a localized failure code.
 *
 * @param {string} code - the failure code.
 * @param {string} [message] - the wire message.
 * @returns {object} the response.
 */
function hostErrorResponse(code, message = '') {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: false, error: { code, message, details: {} } }
    },
  }
}

/**
 * A `fetch` stand-in that records every request and answers through a handler.
 *
 * @param {(body: object, call: number) => any} handler - endpoint handler.
 * @returns {{ fetch: Function, calls: object[] }} the recorder.
 */
function hostRecorder(handler) {
  const calls = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    return handler(body, calls.length)
  }
  return { fetch, calls }
}

/**
 * The store the main slot injects, from an applied module.
 *
 * @param {object} state - the apply-context recorder.
 * @returns {object} the store.
 */
function injectedStore(state) {
  const main = state.slots.find((slot) => slot.options.name === 'main')
  return main.options.inject().store
}

test('registers exactly one lazy factory under the package id', () => {
  const { registrations } = loadClient()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, NS)
  assert.equal(typeof registrations[0].factory, 'function')
})

test('factory requires only react and returns inject/apply', () => {
  const { factory, requireCalls } = loadClient()
  assert.deepEqual(requireCalls, ['react'], 'the factory must require react and nothing else')
  // `factory` lives in the VM realm, so normalize its array into this realm.
  assert.deepEqual([...factory.inject], ['slots', 'locale'])
  assert.equal(typeof factory.apply, 'function')
})

test('apply registers complete zh and en dictionaries', () => {
  const { state } = applyClient()
  assert.equal(state.locales.length, 1, 'the locale service is registered exactly once')
  const registration = state.locales[0]
  assert.equal(registration.namespace, NS)
  const { zh, en } = registration.dictionaries
  assert.equal(typeof zh, 'object')
  assert.equal(typeof en, 'object')

  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.ok(zhKeys.length > 100, `expected a full dictionary, got ${zhKeys.length} keys`)
  assert.deepEqual(zhKeys, enKeys, 'both languages must define the same keys')
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
  }

  const required = [
    'panel',
    'title',
    'subtitle',
    'tab.screenshot',
    'tab.calculator',
    'tab.system',
    'capture.primary',
    'capture.cancel',
    'capture.empty',
    'windows.title',
    'tool.crop',
    'tool.arrow',
    'tool.rect',
    'tool.ellipse',
    'tool.pen',
    'tool.text',
    'tool.mosaic',
    'tool.highlight',
    'editor.copy',
    'editor.save',
    'editor.undo',
    'editor.redo',
    'editor.reset',
    'editor.cropApply',
    'calc.key.equals',
    'calc.history',
    'calc.error.divide_by_zero',
    'system.memory',
    'system.disk',
    'system.uptime',
    'system.capabilityScreenshot',
    'shortcut.toggle',
    'shortcut.screenshot',
  ]
  for (const key of required) assert.ok(key in zh && key in en, `missing dictionary key: ${key}`)

  // The dictionaries are genuinely two languages, not copies.
  assert.notEqual(zh.title, en.title)
  assert.match(zh.title, /[\u4e00-\u9fff]/)
})

test('apply injects the main panel and the sidebar entry with the contract ids', () => {
  const { state } = applyClient()
  assert.deepEqual(state.injects, ['main', 'sidebar.panellist'])

  const main = state.slots.find((slot) => slot.options.name === 'main')
  assert.ok(main, 'a main panel must be registered')
  assert.equal(main.options.key, PANEL_ID)
  assert.equal(main.options.locale, NS)
  assert.equal(typeof main.component, 'function', 'the main panel component must be a function')
  assert.equal(typeof main.options.inject, 'function', 'the main slot must inject the store')
  const injected = main.options.inject()
  assert.equal(typeof injected.store, 'object')
  assert.equal(typeof injected.store.getSnapshot, 'function')
  assert.equal(typeof injected.store.capture, 'function', 'the screenshot shortcut needs the store capture action')

  const sidebar = state.slots.find((slot) => slot.options.name === 'sidebar.panellist')
  assert.ok(sidebar, 'a sidebar entry must be registered')
  assert.equal(sidebar.options.id, PANEL_ID)
  assert.equal(sidebar.options.order, 14)
  assert.equal(sidebar.options.locale, NS)
  assert.equal(typeof sidebar.component, 'function', 'the rail icon must be a function')
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(sidebar.options.label(), 'panel', 'the rail label goes through the bound translator')
})

test('apply injects one stylesheet through ctx.effect and cleans it up', () => {
  const { state, load } = applyClient()
  const labels = state.effects.map((effect) => effect.label)
  assert.ok(labels.includes(`${NS}: dictionaries`), 'the dictionaries must be installed as an effect')
  assert.ok(labels.includes(`${NS}: styles`), 'the stylesheet must be installed as an effect')

  assert.equal(load.document.appended.length, 1, 'exactly one <style> must be appended')
  const tag = load.document.appended[0]
  assert.equal(tag.tagName, 'STYLE')
  assert.equal(tag.dataset.plugin, NS)
  assert.equal(tag.dataset.pluginCss, STYLE_ID)
  assert.ok(tag.textContent.includes('--dsw-alias-'), 'the stylesheet must use theme tokens')
  assert.ok(tag.textContent.includes('.dshMacToolsPage'), 'the stylesheet must be namespaced')

  const stylesEffect = state.effects.find((effect) => effect.label === `${NS}: styles`)
  stylesEffect.cleanup()
  assert.equal(tag.removed, true, 'the effect cleanup must remove the injected style')
  assert.equal(load.document.appended.length, 0)
})

test('apply registers both global shortcuts with the required defaults', () => {
  const { state } = applyClient()
  assert.deepEqual(state.injections.map((services) => [...services]), [['layout'], ['shortcuts', 'layout']])
  assert.equal(state.shortcuts.length, 2)
  const ids = state.shortcuts.map((shortcut) => shortcut.id)
  assert.deepEqual(ids, [TOGGLE_SHORTCUT, SHOT_SHORTCUT])

  const toggle = state.shortcuts[0]
  const screenshot = state.shortcuts[1]
  // The defaults map is built inside the VM realm; copy it before comparing.
  const toggleDefaults = JSON.parse(JSON.stringify(toggle.defaults))
  const screenshotDefaults = JSON.parse(JSON.stringify(screenshot.defaults))
  assert.deepEqual(toggleDefaults['desktop:macos'], { code: 'KeyM', modifiers: ['primary', 'alt'] })
  assert.deepEqual(screenshotDefaults['desktop:macos'], { code: 'KeyA', modifiers: ['primary', 'shift'] })
  assert.deepEqual(toggleDefaults['web:macos'], { code: 'KeyM', modifiers: ['primary', 'alt'] })
  assert.deepEqual(screenshotDefaults['web:macos'], { code: 'KeyA', modifiers: ['primary', 'shift'] })
  assert.equal('web:linux' in toggleDefaults, false, 'a rejected web:linux default would break registration')
  assert.equal('web:linux' in screenshotDefaults, false)
  assert.equal(typeof toggle.label, 'function')
  assert.equal(typeof screenshot.label, 'function')
  assert.equal(toggle.label(), 'shortcut.toggle')
  assert.equal(screenshot.label(), 'shortcut.screenshot')
  assert.equal(typeof toggle.resolve, 'function')
  assert.equal(typeof screenshot.resolve, 'function')
})

test('the toggle shortcut opens and closes the panel', () => {
  const { state, setActivePanel } = applyClient()
  const toggle = state.shortcuts.find((shortcut) => shortcut.id === TOGGLE_SHORTCUT)
  setActivePanel(null)
  toggle.resolve().run()
  assert.deepEqual(state.layoutCalls, [PANEL_ID], 'the shortcut must select the panel')
  toggle.resolve().run()
  assert.deepEqual(state.layoutCalls, [PANEL_ID, null], 'a second invocation must close it again')
})

test('the quick-screenshot shortcut selects the panel and drives the store', async () => {
  const { state } = applyClient()
  const screenshot = state.shortcuts.find((shortcut) => shortcut.id === SHOT_SHORTCUT)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const store = main.options.inject().store

  screenshot.resolve().run()
  assert.deepEqual(state.layoutCalls, [PANEL_ID], 'the quick action must bring the panel forward')
  assert.equal(store.getSnapshot().tab, 'screenshot', 'the quick action must select the screenshot tab')
  assert.equal(store.getSnapshot().capture.status, 'running', 'the quick action must start a capture through the store')

  // There is no Host route in this test process, so the capture settles as a
  // normalized transport failure. What matters is that the store owns the
  // in-flight state and unlocks itself instead of throwing into the shortcut.
  await new Promise((resolve) => setImmediate(resolve))
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.capture.status, 'idle')
  assert.equal(snapshot.capture.error.code, 'host_unreachable')
})

test('store adopts a successful capture and builds a cache-busted image URL', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'capture') {
      return jsonResponse({
        shot: { id: 'shot-9', width: 1200, height: 800, bytes: 2048, mode: 'interactive', at: 1700000000000 },
        url: '/api/dsh-mac-tools?shot=shot-9',
      })
    }
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)

  const accepted = await store.capture({ mode: 'interactive' })
  assert.equal(accepted, true)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.capture.status, 'idle')
  assert.equal(snapshot.capture.error, null)
  assert.equal(snapshot.shot.id, 'shot-9')
  assert.equal(snapshot.shot.imageUrl, '/api/dsh-mac-tools?shot=shot-9&t=1700000000000')
  const captureCall = recorder.calls.find((call) => call.body.endpoint === 'capture')
  assert.ok(captureCall, 'the store must post capture')
  assert.equal(captureCall.body.payload.mode, 'interactive')
  assert.equal(captureCall.init.method, 'POST')
  assert.equal(captureCall.init.credentials, 'same-origin')
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'history'), 'a successful capture refreshes the history')
})

test('a cancelled capture is a normal outcome, not an error', async () => {
  const recorder = hostRecorder(() => hostErrorResponse('cancelled', 'the operator cancelled'))
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)

  const accepted = await store.capture({ mode: 'interactive-region' })
  assert.equal(accepted, false)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.capture.status, 'idle')
  assert.equal(snapshot.capture.error, null, 'cancelled must not render as an error')
  assert.equal(snapshot.shot, null)
})

test('an in-flight interactive capture can be cancelled from the panel', async () => {
  let settleCapture = null
  const captureAnswer = new Promise((resolve) => {
    settleCapture = resolve
  })
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'capture') return captureAnswer
    if (body.endpoint === 'cancelCapture') return jsonResponse({ cancelled: true })
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)

  const pending = store.capture({ mode: 'interactive' })
  assert.equal(store.getSnapshot().capture.status, 'running')
  assert.equal(recorder.calls[0].body.endpoint, 'capture')

  const cancelled = await store.cancelCapture()
  assert.equal(cancelled, true)
  assert.equal(recorder.calls[1].body.endpoint, 'cancelCapture')
  assert.equal(store.getSnapshot().capture.cancelling, true)

  settleCapture(hostErrorResponse('cancelled', 'cancelled'))
  assert.equal(await pending, false)
  assert.equal(store.getSnapshot().capture.status, 'idle')
  assert.equal(store.getSnapshot().capture.error, null)
})

test('calculator evaluations go through the Host and fill the session history', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint !== 'calc') return jsonResponse({})
    if (body.payload.expression === '1/0') return hostErrorResponse('divide_by_zero', 'division by zero')
    const expression = body.payload.expression
    const value = expression === '1+1' ? 2 : 81
    return jsonResponse({ expression, value, formatted: String(value), angles: body.payload.angles })
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)

  store.setCalcExpression('1+1')
  assert.equal(await store.evaluateCalc(), true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.calc.result.formatted, '2')
  assert.equal(snapshot.calc.history.length, 1)
  assert.equal(snapshot.calc.history[0].expression, '1+1')
  assert.equal(recorder.calls[0].body.payload.angles, 'deg')

  store.setCalcExpression('9*9')
  assert.equal(await store.evaluateCalc(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.calc.history.length, 2)
  assert.equal(snapshot.calc.history[0].expression, '9*9', 'newest evaluation comes first')

  store.setCalcExpression('1/0')
  assert.equal(await store.evaluateCalc(), false)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.calc.error.code, 'divide_by_zero')
  assert.equal(snapshot.calc.history.length, 2, 'a failed evaluation is not added to the history')
})

test('store reads the window list, system facts and reports a missing Host half', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'windows') {
      return jsonResponse({
        windows: [{ id: 'w1', app: 'Safari', title: 'Docs', w: 800, h: 600, frontmost: true }],
        frontmost: { app: 'Safari', title: 'Docs', id: 'w1' },
      })
    }
    if (body.endpoint === 'system') {
      return jsonResponse({ os: { name: 'macOS', version: '15.1', arch: 'arm64', hostname: 'mac.local' }, uptimeSeconds: 42 })
    }
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)

  assert.equal(await store.loadWindows(), true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.windows.status, 'ready')
  assert.equal(snapshot.windows.list.length, 1)
  assert.equal(snapshot.windows.list[0].app, 'Safari')
  assert.equal(snapshot.windows.frontmost.id, 'w1')

  assert.equal(await store.loadSystem(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.system.status, 'ready')
  assert.equal(snapshot.system.refreshing, false)
  assert.equal(snapshot.system.value.os.name, 'macOS')

  const missing = hostRecorder(() => ({ ok: false, status: 404, async json() { return { ok: false, error: { code: 'not_found', message: 'no route' } } } }))
  const missingStore = injectedStore(applyClient({ fetch: missing.fetch }).state)
  assert.equal(await missingStore.loadHost(), false)
  snapshot = missingStore.getSnapshot()
  assert.equal(snapshot.host.kind, 'missing')
  assert.equal(snapshot.host.http, 404)
})

test('source obeys the hard client constraints', () => {
  assert.equal(CLIENT_SOURCE.includes('document.body'), false, 'never touch document.body')
  assert.equal(CLIENT_SOURCE.includes("require('@deepseek-ai"), false, 'no Harness Client package imports')
  assert.equal(CLIENT_SOURCE.includes('innerHTML ='), false, 'no innerHTML writes')
  assert.equal(CLIENT_SOURCE.includes('devicePixelRatio'), false, 'canvas mapping must not rely on the device pixel ratio')
  assert.equal((CLIENT_SOURCE.match(/require\('/g) || []).length, 1, "only require('react') is allowed")
  assert.equal((CLIENT_SOURCE.match(/^\s*(import|export)\b/gm) || []).length, 0, 'no ESM syntax inside the bundle')
  assert.equal(/=>\s*<[A-Za-z]/.test(CLIENT_SOURCE), false, 'no JSX')
  assert.ok(CLIENT_SOURCE.includes("toDataURL('image/png')"), 'export must produce a PNG data URL')
  assert.ok(CLIENT_SOURCE.includes("dataUrl.split(',')"), 'export must send raw base64 without the data: prefix')
  assert.ok(CLIENT_SOURCE.includes('canvas.width'), 'the canvas backing store must be sized from the capture')
  assert.ok(CLIENT_SOURCE.includes('getBoundingClientRect'), 'pointer coordinates must be mapped through the element rect')
})

test('stylesheet keeps chrome on theme tokens and the plugin prefix', () => {
  const match = CLIENT_SOURCE.match(/const css = `([\s\S]*?)`\n\n    \/\*\* The `<style>` element id/)
  assert.ok(match, 'the stylesheet template must be present')
  const css = match[1]

  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'no literal hex colors in chrome styles')
  assert.equal(/\b(?:rgb|rgba|hsl|hsla)\(/.test(css), false, 'no raw color functions in chrome styles')

  const variables = [...new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((entry) => entry[1]))]
  assert.ok(variables.length > 10, 'the stylesheet must be theme-token driven')
  for (const name of variables) {
    assert.ok(
      name.startsWith('--dsw-') || name.startsWith('--dsh-'),
      `unexpected CSS variable in chrome styles: ${name}`,
    )
  }

  const classes = [...new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((entry) => entry[1]))]
  assert.ok(classes.length > 50, `expected a complete stylesheet, got ${classes.length} classes`)
  for (const name of classes) {
    assert.ok(name.startsWith('dshMacTools'), `CSS class must be prefixed with dshMacTools: ${name}`)
  }

  assert.ok(css.includes('prefers-reduced-motion:reduce'), 'motion must respect prefers-reduced-motion')
  assert.ok(css.includes('.dshMacToolsCanvas'), 'the annotation canvas must be styled')
  assert.ok(css.includes('.dshMacToolsCalcKeypad'), 'the calculator keypad must be styled')
  assert.ok(css.includes('.dshMacToolsSysGrid'), 'the system cards must be styled')
})

test('customizing the global shortcut posts the accelerator and adopts the answer', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'status') {
      return jsonResponse({
        globalHotkey: {
          enabled: true, active: true, accelerator: 'ctrl+alt+a', label: '⌃⌥A',
          reason: 'active', source: 'config', defaultAccelerator: 'ctrl+alt+a', customized: false,
        },
      })
    }
    if (body.endpoint === 'setHotkey') {
      return jsonResponse({
        enabled: true, active: true, accelerator: body.payload.accelerator, label: '⌃⇧A',
        reason: 'active', source: 'user', defaultAccelerator: 'ctrl+alt+a', customized: true,
      })
    }
    if (body.endpoint === 'resetHotkey') {
      return jsonResponse({
        enabled: true, active: true, accelerator: 'ctrl+alt+a', label: '⌃⌥A',
        reason: 'active', source: 'config', defaultAccelerator: 'ctrl+alt+a', customized: false,
      })
    }
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)
  await store.loadHost()
  assert.equal(store.getSnapshot().hotkey.recording, false)

  store.beginHotkeyRecord()
  assert.equal(store.getSnapshot().hotkey.recording, true)

  const accepted = await store.setHotkey('ctrl+shift+a')
  assert.equal(accepted, true)
  const setCall = recorder.calls.find((call) => call.body.endpoint === 'setHotkey')
  assert.ok(setCall, 'the store must post setHotkey')
  assert.equal(setCall.body.payload.accelerator, 'ctrl+shift+a')
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.hotkey.recording, false)
  assert.equal(snapshot.host.value.globalHotkey.accelerator, 'ctrl+shift+a')
  assert.equal(snapshot.host.value.globalHotkey.source, 'user')

  assert.equal(await store.resetHotkey(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.host.value.globalHotkey.source, 'config')
  assert.equal(snapshot.host.value.globalHotkey.accelerator, 'ctrl+alt+a')
})

test('the shortcut recorder cancels without posting anything', async () => {
  const recorder = hostRecorder(() => jsonResponse({}))
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)
  store.beginHotkeyRecord()
  store.cancelHotkeyRecord()
  assert.equal(store.getSnapshot().hotkey.recording, false)
  assert.equal(recorder.calls.length, 0)
})


test('the hide-while-capturing toggle is shared with the Host', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'status') return jsonResponse({ canHideApp: true, hideAppDuringCapture: true })
    if (body.endpoint === 'setHideApp') return jsonResponse({ enabled: body.payload.enabled })
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)
  await store.loadHost()
  assert.equal(store.getSnapshot().hideAppAvailable, true)
  assert.equal(store.getSnapshot().hideApp, true)

  const accepted = await store.setHideApp(false)
  assert.equal(accepted, true)
  const call = recorder.calls.find((entry) => entry.body.endpoint === 'setHideApp')
  assert.ok(call, 'the toggle must be reported to the Host')
  assert.equal(call.body.payload.enabled, false)
  assert.equal(store.getSnapshot().hideApp, false)
})

test('pinning posts the flattened PNG to the Host', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'pin') return jsonResponse({ ok: true, path: '/tmp/pinned.png', count: 2 })
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)
  const result = await store.pinShot('AAAA', 'shot-7')
  assert.equal(result.ok, true)
  assert.equal(result.count, 2)
  const call = recorder.calls.find((entry) => entry.body.endpoint === 'pin')
  assert.ok(call, 'the store must post pin')
  assert.equal(call.body.payload.pngBase64, 'AAAA')
  assert.equal(call.body.payload.shotId, 'shot-7', 'the shot id lets the Host place the pin where it was captured')
})


test('history loads, builds thumbnail URLs and opens a capture in the editor', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'history') {
      return jsonResponse({
        items: [{ id: 'h1', width: 640, height: 480, bytes: 2048, at: '2026-01-01T00:00:00.000Z', mode: 'full' }],
        total: 1,
        maxItems: 60,
      })
    }
    if (body.endpoint === 'historyOpen') {
      return jsonResponse({
        shot: { id: 'shot-h1', width: 640, height: 480, bytes: 2048, mode: 'full', at: '2026-01-01T00:00:00.000Z' },
        url: '/api/dsh-mac-tools?shot=shot-h1',
      })
    }
    if (body.endpoint === 'status') return jsonResponse({})
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)
  await store.loadHost()
  assert.equal(await store.loadHistory(), true)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.history.items.length, 1)
  assert.match(store.historyImageUrl(snapshot.history.items[0]), /\?history=h1/u)
  assert.equal(await store.openHistory('h1'), true)
  assert.equal(store.getSnapshot().shot.id, 'shot-h1')
  assert.equal(store.getSnapshot().tab, 'screenshot')
  assert.match(store.getSnapshot().shot.imageUrl, /\?shot=shot-h1/u)
})

test('a pending pinned-window edit is adopted by polling', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'status') return jsonResponse({})
    if (body.endpoint === 'pendingEditor') {
      return jsonResponse({ shot: { id: 'shot-pin', width: 300, height: 200, bytes: 10, mode: 'pin-edit', at: 1700000000000 } })
    }
    return jsonResponse({})
  })
  const { state } = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(state)
  await store.loadHost()
  assert.equal(await store.pollPendingEditor(), true)
  assert.equal(store.getSnapshot().shot.id, 'shot-pin')
  assert.equal(store.getSnapshot().tab, 'screenshot')
})
