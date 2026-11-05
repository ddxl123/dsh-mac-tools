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
      const resolved = props === null || props === undefined ? {} : props
      // Mirror React: children also arrive as `props.children`, so a stub
      // renderer can invoke nested function components with their children.
      if (children.length > 0) {
        resolved.children = children.length === 1 ? children[0] : children
      }
      return { type, props: resolved, children }
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
    ...(settings.FileReader === undefined ? {} : { FileReader: settings.FileReader }),
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

/**
 * An inactive `transferStatus` answer, as the Host documents it.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the status object.
 */
function transferStatusValue(overrides) {
  return {
    active: false,
    directory: '/Users/tester/Downloads/DSH 手机互传',
    maxFileMB: 512,
    sessionMinutes: 30,
    autoCopyText: false,
    inboxCount: 0,
    outboxCount: 0,
    url: null,
    urls: [],
    port: null,
    token: null,
    qrPngBase64: null,
    qrError: null,
    startedAt: null,
    expiresAt: null,
    warnings: [],
    ...(overrides === undefined ? {} : overrides),
  }
}

/**
 * An active `transferStatus` answer.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the status object.
 */
function transferActiveValue(overrides) {
  const url = 'http://192.168.1.47:8791/t/token-abc/'
  return transferStatusValue({
    active: true,
    url,
    urls: [url, 'http://tester-mac.local:8791/t/token-abc/'],
    port: 8791,
    token: 'token-abc',
    qrPngBase64: 'QkFTRTY0',
    startedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:30:00.000Z',
    ...(overrides === undefined ? {} : overrides),
  })
}

/**
 * One inbox text item as the Host lists it.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the item.
 */
function inboxTextItem(overrides) {
  return {
    id: 'i-0123456789abcdef',
    kind: 'text',
    name: 'text-20260101-000000.txt',
    size: 5,
    mime: 'text/plain',
    createdAt: '2026-01-01T00:00:00.000Z',
    previewable: false,
    text: 'hello',
    ...(overrides === undefined ? {} : overrides),
  }
}

/**
 * One outbox text item as the Host lists it.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the item.
 */
function outboxTextItem(overrides) {
  return {
    id: 'o-0123456789abcdef',
    kind: 'text',
    name: 'text-20260101-000000.txt',
    size: 5,
    mime: 'text/plain',
    createdAt: '2026-01-01T00:00:00.000Z',
    previewable: false,
    text: 'hello',
    ...(overrides === undefined ? {} : overrides),
  }
}

/**
 * One history point for the monitor sparklines.
 *
 * @param {number} second - the point's offset in seconds.
 * @param {number|null} value - the sampled value.
 * @returns {{t:number,value:number|null}} the point.
 */
function monitorHistoryPoint(second, value) {
  return { t: 1761220000000 + second * 1000, value }
}

/**
 * A complete `monitor` snapshot answer as documented by the contract.
 *
 * @param {object} [overrides] - top-level fields to replace.
 * @returns {object} the snapshot value.
 */
function monitorSnapshotValue(overrides) {
  const value = {
    version: '0.3.0',
    sampledAt: '2026-10-23T11:12:13.000Z',
    capabilities: {
      platform: 'darwin',
      sensors: { supported: true, reason: null },
      fanControl: { supported: true, reason: null },
      battery: false,
      processes: true,
    },
    sample: {
      at: '2026-10-23T11:12:13.000Z',
      host: {
        hostname: 'mac-mini.local',
        modelName: 'Mac mini',
        modelIdentifier: 'Mac16,10',
        cpuModel: 'Apple M4',
        arch: 'arm64',
        osName: 'macOS',
        osVersion: '26.3.1',
        cpuCores: 10,
        performanceCores: 4,
        efficiencyCores: 6,
        uptimeSeconds: 12345,
      },
      cpu: {
        usagePercent: 18.2,
        userPercent: 11.1,
        systemPercent: 5.2,
        idlePercent: 83.7,
        loadAverage: [1.2, 1.5, 1.4],
        perCorePercent: [12.3, 4.5, 51, 0, 3.2, 6.1, 0, 0, 2, 0],
        temperatureCelsius: 73.2,
      },
      memory: {
        totalBytes: 34359738368,
        usedBytes: 21642608640,
        availableBytes: 12717129728,
        usedPercent: 62.9,
        appBytes: 10000000000,
        wiredBytes: 5000000000,
        compressedBytes: 2000000000,
        cachedBytes: 3000000000,
        swapUsedBytes: 0,
        pressure: 'normal',
      },
      disk: {
        name: 'Macintosh HD',
        mount: '/System/Volumes/Data',
        totalBytes: 994662584320,
        usedBytes: 168000000000,
        freeBytes: 826662584320,
        usedPercent: 16.9,
      },
      network: {
        interface: 'en0',
        localIp: '192.168.50.212',
        receivedBytesPerSecond: 5120,
        sentBytesPerSecond: 2048,
        receivedTotalBytes: 1234567890,
        sentTotalBytes: 98765432,
      },
      battery: null,
      sensors: {
        available: true,
        reason: null,
        groups: {
          cpuPerformance: 90.6,
          cpuEfficiency: 66.5,
          gpu: 59.2,
          ssd: 44.5,
          memory: 57.2,
          wifi: 33.7,
          battery: null,
          ambient: 41.2,
        },
        readings: [
          { key: 'Tp01', celsius: 90.6 },
          { key: 'Tp05', celsius: 73.2 },
          { key: 'Te01', celsius: 66.5 },
          { key: 'TH0x', celsius: 40.6 },
        ],
      },
      fans: {
        available: true,
        reason: null,
        items: [{ index: 0, actualRpm: 2220, targetRpm: 2221, minRpm: 1000, maxRpm: 4900, mode: 'forced' }],
      },
      power: {
        available: true,
        cpuW: 13.7,
        gpuW: 3.6,
        aneW: 0,
        dramW: 2.5,
        socW: 19.8,
        energyWh: 0.0421,
        since: '2026-10-23T11:00:00.000Z',
      },
    },
    history: {
      capacity: 60,
      cpu: [monitorHistoryPoint(0, 18.2), monitorHistoryPoint(1, 20.1), monitorHistoryPoint(2, 15.4)],
      memory: [monitorHistoryPoint(0, 62.9), monitorHistoryPoint(1, 63.1), monitorHistoryPoint(2, 62.4)],
      networkDown: [monitorHistoryPoint(0, 512), monitorHistoryPoint(1, 4096), monitorHistoryPoint(2, 8192)],
      networkUp: [monitorHistoryPoint(0, 0), monitorHistoryPoint(1, 1024), monitorHistoryPoint(2, 2048)],
      cpuTemperature: [monitorHistoryPoint(0, 73.2), monitorHistoryPoint(1, null), monitorHistoryPoint(2, 74.1)],
      power: [monitorHistoryPoint(0, 18.4), monitorHistoryPoint(1, 19.1), monitorHistoryPoint(2, 19.8)],
      fanRpm: [monitorHistoryPoint(0, 2100), monitorHistoryPoint(1, 2180), monitorHistoryPoint(2, 2220)],
    },
    energy: {
      todayWh: 12.3,
      totalWh: 456.7,
      days: 42,
      since: '2026-10-01',
      pricePerKwh: 0.56,
      costToday: 0.0069,
      costTotal: 0.2558,
    },
    alerts: {
      settings: {
        enabled: true,
        cpuPercent: 90,
        temperatureCelsius: 95,
        memoryPercent: 90,
        cooldownSeconds: 300,
        notify: true,
      },
      events: [
        {
          id: 'a-1',
          at: '2026-10-23T11:10:00.000Z',
          metric: 'temperature',
          value: 96.2,
          threshold: 95,
        },
      ],
    },
    fanControl: {
      state: 'ready',
      reason: null,
      message: null,
      installed: true,
      running: true,
      otherControllers: [],
      mode: 'auto',
      manualRpm: 2500,
      curve: {
        sensor: 'cpuPerformance',
        points: [
          { celsius: 40, rpm: 1000 },
          { celsius: 60, rpm: 2400 },
          { celsius: 75, rpm: 3600 },
          { celsius: 90, rpm: 4900 },
        ],
      },
      sensorOptions: ['cpuPerformance', 'cpuEfficiency', 'gpu', 'ssd'],
      appliedRpm: null,
      lastAppliedAt: null,
      minRpm: 1000,
      maxRpm: 4900,
      presets: [
        { id: 'auto', name: 'auto', builtin: true, mode: 'auto' },
        { id: 'quiet', name: 'quiet', builtin: true, mode: 'manual', rpm: 1000 },
        {
          id: 'p-prof',
          name: '剪辑模式',
          builtin: false,
          mode: 'curve',
          curve: {
            sensor: 'cpuPerformance',
            points: [{ celsius: 40, rpm: 1000 }, { celsius: 90, rpm: 4900 }],
          },
        },
      ],
    },
  }
  return Object.assign(value, overrides === undefined ? {} : overrides)
}

/**
 * The monitor snapshot's sample block with fields replaced.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the sample block.
 */
function monitorSample(overrides) {
  return Object.assign({}, monitorSnapshotValue().sample, overrides === undefined ? {} : overrides)
}

/**
 * The monitor snapshot's fanControl block with fields replaced.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the fanControl block.
 */
function monitorFanControl(overrides) {
  return Object.assign({}, monitorSnapshotValue().fanControl, overrides === undefined ? {} : overrides)
}

/**
 * The monitor snapshot's sensors block with fields replaced.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the sensors block.
 */
function monitorSensors(overrides) {
  return Object.assign({}, monitorSnapshotValue().sample.sensors, overrides === undefined ? {} : overrides)
}

/**
 * The monitor snapshot's power block with fields replaced.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the power block.
 */
function monitorPower(overrides) {
  return Object.assign({}, monitorSnapshotValue().sample.power, overrides === undefined ? {} : overrides)
}

/**
 * The energy range answer the panel renders (contract §3.9) with fields replaced.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the energy range value.
 */
function monitorEnergyRangeValue(overrides) {
  return Object.assign({
    from: '2026-10-30',
    to: '2026-11-05',
    days: [
      { date: '2026-10-30', wh: 8100 },
      { date: '2026-10-31', wh: 9400 },
      { date: '2026-11-01', wh: 0 },
      { date: '2026-11-02', wh: 12300 },
    ],
    totalWh: 29800,
    averageWh: 7450,
    pricePerKwh: 0.56,
    totalCost: 16.688,
    averageCost: 4.172,
  }, overrides === undefined ? {} : overrides)
}

/**
 * The monitor snapshot's alerts block with fields replaced.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the alerts block.
 */
function monitorAlerts(overrides) {
  return Object.assign({}, monitorSnapshotValue().alerts, overrides === undefined ? {} : overrides)
}

/**
 * The monitor snapshot's history block with fields replaced.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the history block.
 */
function monitorHistory(overrides) {
  return Object.assign({}, monitorSnapshotValue().history, overrides === undefined ? {} : overrides)
}

/**
 * Wait for the next macrotask so queued store promises can settle.
 *
 * @returns {Promise<void>} resolution.
 */
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Collect elements from a rendered element tree without invoking components.
 *
 * @param {any} element - an element returned by `React.createElement`.
 * @param {(candidate: object) => boolean} predicate - the filter.
 * @param {object[]} [found] - the accumulator.
 * @returns {object[]} the matching elements.
 */
function collectElements(element, predicate, found = []) {
  if (element === null || element === undefined) return found
  if (typeof element === 'string' || typeof element === 'number') return found
  if (Array.isArray(element)) {
    for (const child of element) collectElements(child, predicate, found)
    return found
  }
  if (typeof element.type === 'function') return found
  if (predicate(element)) found.push(element)
  for (const child of element.children) collectElements(child, predicate, found)
  return found
}


/**
 * Invoke every function component in an element tree and collect the string
 * children it renders, so a test can assert which localized keys a state shows.
 *
 * @param {any} element - an element returned by `React.createElement`.
 * @param {number} [depth] - recursion guard.
 * @param {string[]} [found] - the accumulator.
 * @returns {string[]} the rendered strings and locale keys.
 */
function renderedStrings(element, depth = 0, found = []) {
  if (depth > 60) throw new Error('element tree is deeper than the panel should be')
  if (element === null || element === undefined) return found
  if (typeof element === 'string' || typeof element === 'number') {
    found.push(String(element))
    return found
  }
  if (Array.isArray(element)) {
    for (const child of element) renderedStrings(child, depth, found)
    return found
  }
  if (typeof element.type === 'function') {
    const props = {
      ...element.props,
      children: element.children.length === 0
        ? undefined
        : (element.children.length === 1 ? element.children[0] : element.children),
    }
    renderedStrings(element.type(props), depth + 1, found)
    return found
  }
  for (const child of element.children) renderedStrings(child, depth, found)
  return found
}

/**
 * Invoke every function component in an element tree and collect the host
 * elements that match a predicate, so a test can count rendered SVG bars.
 *
 * @param {any} element - an element returned by `React.createElement`.
 * @param {(candidate: object) => boolean} predicate - the filter.
 * @param {number} [depth] - recursion guard.
 * @param {object[]} [found] - the accumulator.
 * @returns {object[]} the matching elements.
 */
function renderedElements(element, predicate, depth = 0, found = []) {
  if (depth > 60) throw new Error('element tree is deeper than the panel should be')
  if (element === null || element === undefined) return found
  if (typeof element === 'string' || typeof element === 'number') return found
  if (Array.isArray(element)) {
    for (const child of element) renderedElements(child, predicate, depth, found)
    return found
  }
  if (typeof element.type === 'function') {
    const props = {
      ...element.props,
      children: element.children.length === 0
        ? undefined
        : (element.children.length === 1 ? element.children[0] : element.children),
    }
    renderedElements(element.type(props), predicate, depth + 1, found)
    return found
  }
  if (predicate(element)) found.push(element)
  for (const child of element.children) renderedElements(child, predicate, depth, found)
  return found
}

/**
 * Walk a rendered element tree, invoking every function component with the
 * stubbed React, so a crash in a tab's render path surfaces as a test failure
 * (a throwing component blanks its slot in the real panel).
 *
 * @param {any} element - an element returned by `React.createElement`.
 * @param {number} [depth] - recursion guard.
 * @returns {void}
 */
function renderElementTree(element, depth = 0) {
  if (depth > 40) throw new Error('element tree is deeper than the panel should be')
  if (element === null || element === undefined) return
  if (typeof element === 'string' || typeof element === 'number') return
  if (Array.isArray(element)) {
    for (const child of element) renderElementTree(child, depth)
    return
  }
  if (typeof element.type === 'function') {
    renderElementTree(element.type(element.props), depth + 1)
    return
  }
  for (const child of element.children) renderElementTree(child, depth)
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
    'tab.monitor',
    'tab.transfer',
    'transfer.start',
    'transfer.inbox.title',
    'transfer.outbox.title',
    'transfer.kind.text',
    'transfer.error.unsupported',
    'transfer.qrAlt',
    'transfer.copyUrl',
    'transfer.copyFailed',
    'transfer.clipboardUnavailable',
    'transfer.remaining',
    'transfer.inbox.empty',
    'transfer.outbox.empty',
    'transfer.inbox.clearConfirm',
    'transfer.outbox.clearConfirm',
    'transfer.toast.sent',
    'transfer.error.port_unavailable',
    'common.cancel',
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
    'system.os',
    'system.arch',
    'system.hostname',
    'system.model',
    'system.cores',
    'system.coresLabel',
    'system.uptime',
    'system.uptimeValue',
    'system.available',
    'system.unavailable',
    'system.saveDirectory',
    'system.capturedAt',
    'system.unknown',
    'monitor.system.title',
    'monitor.system.hardware',
    'monitor.system.runtime',
    'monitor.system.capabilities',
    'monitor.system.chip',
    'monitor.system.coresDetail',
    'monitor.system.hostPid',
    'monitor.system.sampledAt',
    'monitor.system.interval',
    'monitor.system.polling',
    'monitor.system.capability.screenshot',
    'monitor.system.capability.fanControl',
    'monitor.system.note',
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

test('store reads the window list and reports a missing Host half', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'windows') {
      return jsonResponse({
        windows: [{ id: 'w1', app: 'Safari', title: 'Docs', w: 800, h: 600, frontmost: true }],
        frontmost: { app: 'Safari', title: 'Docs', id: 'w1' },
      })
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

  // The old standalone System IPC and its store slice no longer exist: the
  // status tab renders that data from its own snapshot instead.
  assert.equal(typeof store.loadSystem, 'undefined')
  assert.equal('system' in snapshot, false)

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
  assert.ok(css.includes('.dshMacToolsTransferCard'), 'the phone-transfer session card must be styled')
  assert.ok(css.includes('.dshMacToolsTransferColumns'), 'the two phone-transfer columns must be styled')
  assert.ok(css.includes('.dshMacToolsTransferQrImage'), 'the QR code image must be styled')
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

test('the transfer store exposes every documented action', () => {
  const store = injectedStore(applyClient().state)
  const actions = [
    'loadTransferStatus',
    'startTransfer',
    'stopTransfer',
    'refreshTransferInbox',
    'refreshTransferOutbox',
    'deleteTransferInboxItem',
    'clearTransferInbox',
    'copyTransferText',
    'revealTransferInboxItem',
    'setTransferTextDraft',
    'sendTransferText',
    'sendTransferFile',
    'sendHistoryToPhone',
    'removeTransferOutboxItem',
    'clearTransferOutbox',
    'dismissTransferToast',
    'transferInboxImageUrl',
  ]
  for (const name of actions) {
    assert.equal(typeof store[name], 'function', `the transfer contract needs store.${name}`)
  }
})

test('transfer inbox files get a cache-busted same-origin preview URL', () => {
  const store = injectedStore(applyClient().state)
  assert.equal(
    store.transferInboxImageUrl(inboxTextItem()),
    '/api/dsh-mac-tools?inbox=i-0123456789abcdef&t=1767225600000',
  )
})

test('the transfer store starts, tracks and stops a session', async () => {
  const active = transferActiveValue()
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferStatus') return jsonResponse(transferStatusValue())
    if (body.endpoint === 'transferStart') return jsonResponse(active)
    if (body.endpoint === 'transferStop') return jsonResponse(transferStatusValue())
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  assert.equal(await store.loadTransferStatus(), true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'idle')
  assert.equal(snapshot.transfer.session, null)
  assert.deepEqual(recorder.calls[0].body, { endpoint: 'transferStatus', payload: {} })

  assert.equal(await store.startTransfer(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'active')
  assert.equal(snapshot.transfer.session.url, active.url)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'transferStart'))
  assert.ok(
    recorder.calls.some((call) => call.body.endpoint === 'transferInbox' && call.body.payload.action === 'refresh'),
    'starting a session seeds the inbox',
  )
  assert.ok(
    recorder.calls.some((call) => call.body.endpoint === 'transferOutbox' && call.body.payload.action === 'refresh'),
    'starting a session seeds the outbox',
  )

  assert.equal(await store.stopTransfer(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'idle')
  assert.equal(snapshot.transfer.session, null)
})

test('a refused start reports the error code and a toast', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferStatus') return jsonResponse(transferStatusValue())
    if (body.endpoint === 'transferStart') return hostErrorResponse('port_unavailable', 'no free port')
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  await store.loadTransferStatus()

  assert.equal(await store.startTransfer(), false)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'error')
  assert.equal(snapshot.transfer.session, null)
  assert.equal(snapshot.transfer.error.code, 'port_unavailable')
  assert.equal(snapshot.transfer.toast.kind, 'error')
  assert.equal(snapshot.transfer.toast.error.code, 'port_unavailable')
})

test('a poll sent before a start landed cannot close the new session', async () => {
  let releasePoll = null
  const active = transferActiveValue()
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferStatus') {
      return new Promise((resolve) => {
        releasePoll = () => resolve(jsonResponse(transferStatusValue()))
      })
    }
    if (body.endpoint === 'transferStart') return jsonResponse(active)
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  const poll = store.loadTransferStatus()
  assert.equal(store.getSnapshot().transfer.status, 'loading')
  assert.equal(await store.startTransfer(), true)
  assert.equal(store.getSnapshot().transfer.status, 'active')

  releasePoll()
  assert.equal(await poll, true)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'active', 'a stale inactive poll must not stop the session')
  assert.equal(snapshot.transfer.session.url, active.url)
})

test('a status poll during a slow start keeps the starting card', async () => {
  let releaseStart = null
  let statusCalls = 0
  const active = transferActiveValue({ qrPngBase64: 'QkFTRTY0' })
  // While the Host compiles the QR helper the server already listens, so a
  // status poll answers active without a QR code; the start answer is the one
  // that carries the finished session.
  const unfinished = transferActiveValue({ qrPngBase64: null, expiresAt: null, startedAt: null })
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferStatus') {
      statusCalls += 1
      return jsonResponse(statusCalls === 1 ? transferStatusValue() : unfinished)
    }
    if (body.endpoint === 'transferStart') {
      return new Promise((resolve) => {
        releaseStart = () => resolve(jsonResponse(active))
      })
    }
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  assert.equal(await store.loadTransferStatus(), true)

  const start = store.startTransfer()
  assert.equal(store.getSnapshot().transfer.status, 'starting')
  assert.equal(await store.loadTransferStatus(), true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'starting', 'a poll must not flash the unfinished session card')
  assert.equal(snapshot.transfer.session, null)

  releaseStart()
  assert.equal(await start, true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'active')
  assert.equal(snapshot.transfer.session.qrPngBase64, 'QkFTRTY0')
})

test('a status poll during a stop keeps the stopping state until the Host answers', async () => {
  let releaseStop = null
  let statusCalls = 0
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferStatus') {
      statusCalls += 1
      // The poll that fires while the stop is in flight still sees the session.
      return jsonResponse(statusCalls <= 2 ? transferActiveValue() : transferStatusValue())
    }
    if (body.endpoint === 'transferStop') {
      return new Promise((resolve) => {
        releaseStop = () => resolve(jsonResponse(transferStatusValue()))
      })
    }
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  assert.equal(await store.loadTransferStatus(), true)
  assert.equal(store.getSnapshot().transfer.status, 'active')

  const stop = store.stopTransfer()
  assert.equal(store.getSnapshot().transfer.status, 'stopping')
  assert.equal(await store.loadTransferStatus(), true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'stopping', 'a poll must not flip a stopping session back to active')
  assert.notEqual(snapshot.transfer.session, null, 'the session card stays up while the stop settles')

  releaseStop()
  assert.equal(await stop, true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'idle')
  assert.equal(snapshot.transfer.session, null)
})

test('a list read sent before a delete cannot resurrect the row', async () => {
  const item = inboxTextItem()
  let releaseRead = null
  let readCalls = 0
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferInbox') {
      if (body.payload.action === 'refresh') {
        readCalls += 1
        if (readCalls === 1) return jsonResponse({ items: [item], count: 1 })
        if (readCalls === 2) {
          return new Promise((resolve) => {
            releaseRead = () => resolve(jsonResponse({ items: [item], count: 1 }))
          })
        }
        return jsonResponse({ items: [], count: 0 })
      }
      if (body.payload.action === 'delete') return jsonResponse({ deleted: true, id: item.id })
    }
    if (body.endpoint === 'transferStatus') return jsonResponse(transferStatusValue())
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  assert.equal(await store.refreshTransferInbox(), true)
  assert.equal(store.getSnapshot().transfer.inbox.items.length, 1)

  const staleRead = store.refreshTransferInbox()
  assert.equal(await store.deleteTransferInboxItem(item.id), true)
  assert.equal(store.getSnapshot().transfer.inbox.items.length, 0)
  assert.equal(store.getSnapshot().transfer.inbox.count, 0)

  releaseRead()
  assert.equal(await staleRead, false, 'the pre-delete read must report it was not adopted')
  assert.equal(store.getSnapshot().transfer.inbox.items.length, 0, 'the deleted row must stay gone')

  assert.equal(await store.refreshTransferInbox(), true)
  assert.equal(store.getSnapshot().transfer.inbox.items.length, 0)
})

test('a list read sent before a send cannot hide the queued item', async () => {
  const item = outboxTextItem()
  let releaseRead = null
  let readCalls = 0
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferOutbox') {
      if (body.payload.action === 'refresh') {
        readCalls += 1
        if (readCalls === 1) return jsonResponse({ items: [], count: 0 })
        if (readCalls === 2) {
          return new Promise((resolve) => {
            releaseRead = () => resolve(jsonResponse({ items: [], count: 0 }))
          })
        }
        return jsonResponse({ items: [item], count: 1 })
      }
      if (body.payload.action === 'addText') return jsonResponse({ item })
    }
    if (body.endpoint === 'transferStatus') return jsonResponse(transferStatusValue())
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  store.setTransferTextDraft('hello')

  assert.equal(await store.refreshTransferOutbox(), true)
  const staleRead = store.refreshTransferOutbox()
  assert.equal(await store.sendTransferText(), true)
  assert.equal(store.getSnapshot().transfer.outbox.items.length, 1)
  assert.equal(store.getSnapshot().transfer.outbox.items[0].id, item.id)

  releaseRead()
  assert.equal(await staleRead, false, 'the pre-send read must report it was not adopted')
  assert.equal(store.getSnapshot().transfer.outbox.items.length, 1, 'the sent item must stay listed')
})

test('sending text clears the draft only when it is unchanged', async () => {
  const item = outboxTextItem()
  let releaseSend = null
  let addCalls = 0
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferOutbox' && body.payload.action === 'addText') {
      addCalls += 1
      if (addCalls === 1) {
        return new Promise((resolve) => {
          releaseSend = () => resolve(jsonResponse({ item }))
        })
      }
      return jsonResponse({ item })
    }
    if (body.endpoint === 'transferStatus') return jsonResponse(transferStatusValue())
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  store.setTransferTextDraft('first message')
  const sending = store.sendTransferText()
  // The operator keeps typing while the Host is answering.
  store.setTransferTextDraft('second message')
  const duplicate = store.sendTransferText()
  assert.equal(await duplicate, false, 'a second send must not stack on the in-flight one')
  releaseSend()
  assert.equal(await sending, true)
  assert.equal(store.getSnapshot().transfer.textDraft, 'second message', 'text typed during the send must survive')
  assert.equal(store.getSnapshot().transfer.outbox.items.length, 1)

  store.setTransferTextDraft('only message')
  assert.equal(await store.sendTransferText(), true)
  assert.equal(store.getSnapshot().transfer.textDraft, '', 'an unchanged draft is cleared after the send')
})

test('inbox and outbox mutations keep the local lists, counts and toasts in step', async () => {
  const first = inboxTextItem()
  const second = inboxTextItem({ id: 'i-fedcba9876543210', text: 'second' })
  const outItem = outboxTextItem()
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferInbox') {
      if (body.payload.action === 'refresh') return jsonResponse({ items: [first, second], count: 2 })
      if (body.payload.action === 'delete') return jsonResponse({ deleted: true, id: body.payload.id })
      if (body.payload.action === 'clear') return jsonResponse({ cleared: 2 })
      if (body.payload.action === 'copyText') return hostErrorResponse('not_found', 'gone')
    }
    if (body.endpoint === 'transferOutbox') {
      if (body.payload.action === 'refresh') return jsonResponse({ items: [outItem], count: 1 })
      if (body.payload.action === 'remove') return jsonResponse({ removed: true, id: body.payload.id })
      if (body.payload.action === 'clear') return jsonResponse({ cleared: 1 })
    }
    if (body.endpoint === 'transferStatus') return jsonResponse(transferStatusValue())
    return jsonResponse({ items: [], count: 0 })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  await store.refreshTransferInbox()
  assert.equal(store.getSnapshot().transfer.inbox.count, 2)
  assert.equal(await store.deleteTransferInboxItem(first.id), true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.inbox.items.length, 1)
  assert.equal(snapshot.transfer.inbox.count, 1)
  assert.equal(snapshot.transfer.inbox.items[0].id, second.id)
  assert.equal(snapshot.transfer.toast.text, 'transfer.toast.deleted')

  assert.equal(await store.copyTransferText(second.id), false)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.toast.kind, 'error')
  assert.equal(snapshot.transfer.toast.error.code, 'not_found')

  assert.equal(await store.clearTransferInbox(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.inbox.items.length, 0)
  assert.equal(snapshot.transfer.inbox.count, 0)
  assert.equal(snapshot.transfer.toast.text, 'transfer.toast.cleared')

  await store.refreshTransferOutbox()
  assert.equal(store.getSnapshot().transfer.outbox.count, 1)
  assert.equal(await store.removeTransferOutboxItem(outItem.id), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.outbox.items.length, 0)
  assert.equal(snapshot.transfer.outbox.count, 0)
  assert.equal(snapshot.transfer.toast.text, 'transfer.toast.removed')

  assert.equal(await store.clearTransferOutbox(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.outbox.items.length, 0)
  assert.equal(snapshot.transfer.toast.text, 'transfer.toast.cleared')
})

test('a failing status poll keeps the error card steady instead of reloading it', async () => {
  const recorder = hostRecorder(() => hostErrorResponse('unsupported', 'phone transfer is not available'))
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  assert.equal(await store.loadTransferStatus(), false)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'error')
  assert.equal(snapshot.transfer.error.code, 'unsupported')

  // The retry that follows an error must not flash the loading card again; the
  // notice stays readable until the Host answers differently.
  const retry = store.loadTransferStatus()
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'error')
  assert.equal(snapshot.transfer.error.code, 'unsupported')
  assert.equal(await retry, false)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.status, 'error')
  assert.equal(snapshot.transfer.error.code, 'unsupported')
})

test('a failing inbox read keeps the error card until the list answers', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'transferInbox') return hostErrorResponse('io_error', 'the inbox could not be read')
    return jsonResponse(transferStatusValue())
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  assert.equal(await store.refreshTransferInbox(), false)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.inbox.status, 'error')
  assert.equal(snapshot.transfer.inbox.error.code, 'io_error')

  const retry = store.refreshTransferInbox()
  snapshot = store.getSnapshot()
  assert.equal(snapshot.transfer.inbox.status, 'error', 'a retry must not replace the error card with a skeleton')
  assert.equal(snapshot.transfer.inbox.error.code, 'io_error')
  assert.equal(await retry, false)
  assert.equal(store.getSnapshot().transfer.inbox.status, 'error')
})

test('the panel renders every transfer state without throwing', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()

  const activeSession = {
    active: true,
    directory: '/Users/tester/Downloads/DSH 手机互传',
    maxFileMB: 512,
    sessionMinutes: 30,
    autoCopyText: false,
    inboxCount: 3,
    outboxCount: 2,
    url: 'http://192.168.1.47:8791/t/token-abc/',
    urls: ['http://192.168.1.47:8791/t/token-abc/', 'http://tester-mac.local:8791/t/token-abc/'],
    port: 8791,
    token: 'token-abc',
    qrPngBase64: 'QkFTRTY0',
    qrError: 'the QR helper failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:30:00.000Z',
    warnings: ['no LAN address was found'],
  }
  const inboxState = {
    status: 'ready',
    count: 3,
    error: null,
    items: [
      inboxTextItem(),
      inboxTextItem({ id: 'i-file-png', kind: 'file', name: 'photo.png', mime: 'image/png', previewable: true, text: undefined }),
      inboxTextItem({ id: 'i-file-pdf', kind: 'file', name: 'scan.pdf', mime: 'application/pdf', previewable: false, text: undefined }),
    ],
  }
  const outboxState = {
    status: 'ready',
    count: 2,
    error: null,
    items: [
      outboxTextItem(),
      outboxTextItem({ id: 'o-history', kind: 'history', name: 'screenshot-20260101-000000.png', mime: 'image/png', previewable: true, text: undefined }),
    ],
  }
  const renderWith = (patch, extra) => {
    const next = JSON.parse(JSON.stringify({
      ...base,
      transfer: { ...base.transfer, ...patch },
      ...(extra === undefined ? {} : extra),
    }))
    store.getSnapshot = () => next
    assert.doesNotThrow(
      () => renderElementTree(main.component({ store, t })),
      `rendering the panel with transfer ${JSON.stringify(Object.keys(patch))} must not throw`,
    )
  }

  renderWith({})
  renderWith({ status: 'loading', session: null })
  renderWith({ status: 'starting', session: null })
  renderWith({ status: 'stopping', session: activeSession, inbox: inboxState, outbox: outboxState })
  renderWith({
    status: 'active',
    session: activeSession,
    inbox: inboxState,
    outbox: outboxState,
    textDraft: 'a draft',
    toast: { kind: 'error', text: 'transfer.toast.failed', error: { code: 'io_error', message: 'disk full', details: {} } },
  })
  renderWith({ status: 'idle', session: null, inbox: inboxState, outbox: outboxState })
  renderWith({
    status: 'error',
    session: null,
    error: { code: 'port_unavailable', message: 'no free port', details: {} },
  })
  renderWith({
    status: 'error',
    session: activeSession,
    inbox: inboxState,
    outbox: outboxState,
    error: { code: 'io_error', message: 'disk full', details: {} },
  })
  renderWith({
    status: 'idle',
    session: null,
    inbox: { status: 'loading', count: 0, error: null, items: [] },
    outbox: { status: 'error', count: 0, error: { code: 'io_error', message: 'cannot read', details: {} }, items: [] },
  })
  renderWith({
    status: 'idle',
    session: null,
    inbox: { status: 'ready', count: 1, error: { code: 'host_unreachable', message: 'gone', details: {} }, items: [inboxTextItem()] },
    outbox: { status: 'ready', count: 0, error: null, items: [] },
  })
  renderWith({
    status: 'active',
    session: { active: true, directory: '', maxFileMB: 512, sessionMinutes: 30, url: '', urls: [], qrPngBase64: null, qrError: null, expiresAt: null, warnings: [] },
    inbox: inboxState,
    outbox: outboxState,
  })
  renderWith({ status: 'idle', session: null }, {
    host: { kind: 'ready', value: { version: '0.2.1', saveDirectory: '/tmp', capabilities: { transfer: false } }, http: 200, message: '' },
  })
  renderWith({ status: 'idle', session: null }, {
    history: {
      status: 'ready',
      error: null,
      items: [{ id: 'h1', at: '2026-01-01T00:00:00.000Z', width: 10, height: 10, bytes: 1 }],
    },
  })
})

test('the five tabs are registered in the documented order without a System tab', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const tree = main.component({ store, t: (key) => key })
  const tabs = collectElements(tree, (element) => element.props !== null && element.props !== undefined && element.props.role === 'tab')
  assert.deepEqual(
    tabs.map((element) => element.props.id),
    [
      'dsh-mac-tools-tab-monitor',
      'dsh-mac-tools-tab-screenshot',
      'dsh-mac-tools-tab-files',
      'dsh-mac-tools-tab-calculator',
      'dsh-mac-tools-tab-transfer',
    ],
    'the status tab leads the bar, the System tab must be gone, and the files browser follows the screenshot tab',
  )
  assert.deepEqual(
    tabs.map((element) => element.children[0]),
    ['tab.monitor', 'tab.screenshot', 'tab.files', 'tab.calculator', 'tab.transfer'],
    'every tab label must go through the locale service',
  )
  assert.equal(tabs.some((element) => element.props.id.endsWith('-system')), false)
  assert.equal(store.getSnapshot().tab, 'monitor', 'the panel lands on the status tab')
  assert.match(CLIENT_SOURCE, /const TABS = \['monitor', 'screenshot', 'files', 'calculator', 'transfer'\]/u)
})

test('the monitor dictionaries are complete in both languages', () => {
  const { state } = applyClient()
  const { zh, en } = state.locales[0].dictionaries
  const zhKeys = Object.keys(zh).filter((key) => key === 'tab.monitor' || key.startsWith('monitor.')).sort()
  const enKeys = Object.keys(en).filter((key) => key === 'tab.monitor' || key.startsWith('monitor.')).sort()
  assert.deepEqual(zhKeys, enKeys, 'both languages must define the same monitor keys')
  assert.ok(zhKeys.length > 150, `expected a complete monitor dictionary, got ${zhKeys.length} keys`)
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
  }

  const required = [
    'tab.monitor',
    'monitor.toolbarAria',
    'monitor.sampledAt',
    'monitor.pause',
    'monitor.resume',
    'monitor.interval.option',
    'monitor.loading',
    'monitor.error.generic',
    'monitor.unsupported.title',
    'monitor.badge.sensors',
    'monitor.cpu.title',
    'monitor.cpu.temperature',
    'monitor.cpu.perCore',
    'monitor.memory.title',
    'monitor.memory.app',
    'monitor.memory.wired',
    'monitor.memory.compressed',
    'monitor.memory.cached',
    'monitor.memory.pressure.normal',
    'monitor.memory.pressure.warning',
    'monitor.memory.pressure.critical',
    'monitor.disk.title',
    'monitor.network.title',
    'monitor.network.down',
    'monitor.network.up',
    'monitor.battery.title',
    'monitor.footer.uptime',
    'monitor.sensors.title',
    'monitor.sensors.showAll',
    'monitor.sensors.reason.smc-unavailable',
    'monitor.sensors.reason.starting',
    'monitor.sensors.group.cpuPerformance',
    'monitor.fan.title',
    'monitor.fan.enable',
    'monitor.fan.install.intro',
    'monitor.fan.install.helper',
    'monitor.fan.install.daemon',
    'monitor.fan.install.prompt',
    'monitor.fan.mode.auto',
    'monitor.fan.mode.manual',
    'monitor.fan.mode.system',
    'monitor.fan.manualHint',
    'monitor.fan.curve.sensor',
    'monitor.fan.curve.hint',
    'monitor.fan.curve.delete',
    'monitor.fan.curve.reset',
    'monitor.fan.curve.apply',
    'monitor.fan.preset.save',
    'monitor.fan.preset.namePlaceholder',
    'monitor.fan.restoreAuto',
    'monitor.fan.uninstall',
    'monitor.fan.uninstallConfirm',
    'monitor.fan.otherControllers',
    'monitor.fan.error.fan_not_ready',
    'monitor.fan.error.fan_apply_failed',
    'monitor.processes.title',
    'monitor.processes.pid',
    'monitor.processes.sortHint',
    'monitor.processes.kill',
    'monitor.processes.killArmed',
    'monitor.processes.killProtected',
    'monitor.processes.error.kill_invalid_pid',
    'monitor.processes.error.kill_not_found',
    'monitor.processes.error.kill_denied',
    'monitor.alerts.title',
    'monitor.alerts.enabled',
    'monitor.alerts.cpu',
    'monitor.alerts.temperature',
    'monitor.alerts.memory',
    'monitor.alerts.cooldown',
    'monitor.alerts.notify',
    'monitor.alerts.save',
    'monitor.alerts.test',
    'monitor.alerts.events',
    'monitor.alerts.metric.cpu',
    'monitor.alerts.metric.temperature',
    'monitor.alerts.metric.memory',
  ]
  for (const key of required) assert.ok(key in zh && key in en, `missing monitor dictionary key: ${key}`)

  // The install copy must disclose what lands on disk and that it is removable.
  assert.match(zh['monitor.fan.install.helper'], /\/Library\/Application Support\/DSH Mac Tools\//u)
  assert.match(en['monitor.fan.install.helper'], /\/Library\/Application Support\/DSH Mac Tools\//u)
  assert.match(zh['monitor.fan.install.prompt'], /管理员密码|卸载/u)
  assert.match(en['monitor.fan.install.prompt'], /administrator password|uninstall/iu)
  assert.match(zh['monitor.fan.install.intro'], /特权/u)
  // The label is Chinese in zh and English in en, not a copy.
  assert.match(zh['tab.monitor'], /[\u4e00-\u9fff]/u)
  assert.notEqual(zh['tab.monitor'], en['tab.monitor'])
})

test('the monitor store polls, dedupes and degrades on failure', async () => {
  const value = monitorSnapshotValue()
  let release = null
  const recorder = hostRecorder((body) => {
    if (body.endpoint !== 'monitor') return jsonResponse({})
    return new Promise((resolve) => {
      release = () => resolve(jsonResponse(value))
    })
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  const first = store.loadMonitor()
  const second = store.loadMonitor()
  assert.equal(first, second, 'a second poll must dedupe onto the in-flight request')
  await flushAsync()
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'monitor').length, 1)
  assert.equal(store.getSnapshot().monitor.status, 'loading', 'the first answer shows the skeleton')

  release()
  assert.equal(await first, true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.monitor.status, 'ready')
  assert.equal(snapshot.monitor.error, null)
  assert.equal(snapshot.monitor.value.sample.cpu.usagePercent, 18.2)
  assert.equal(snapshot.monitor.value.fanControl.state, 'ready')

  // A failed poll keeps the stale snapshot on screen and exposes the failure.
  const failing = hostRecorder(() => hostErrorResponse('host_unreachable', 'gone'))
  const failingStore = injectedStore(applyClient({ fetch: failing.fetch }).state)
  assert.equal(await failingStore.loadMonitor(), false)
  snapshot = failingStore.getSnapshot()
  assert.equal(snapshot.monitor.status, 'error')
  assert.equal(snapshot.monitor.error.code, 'host_unreachable')
  assert.equal(snapshot.monitor.value, null)

  // A failure after a good snapshot keeps the values and only flags the error.
  const mixed = hostRecorder((body, call) => (call === 1 ? jsonResponse(value) : hostErrorResponse('host_unreachable', 'gone')))
  const mixedStore = injectedStore(applyClient({ fetch: mixed.fetch }).state)
  assert.equal(await mixedStore.loadMonitor(), true)
  assert.equal(await mixedStore.loadMonitor(), false)
  snapshot = mixedStore.getSnapshot()
  assert.equal(snapshot.monitor.status, 'ready')
  assert.equal(snapshot.monitor.value.sample.cpu.usagePercent, 18.2)
  assert.equal(snapshot.monitor.error.code, 'host_unreachable')
})

test('the energy store saves the price and patches the snapshot cost block', async () => {
  const snapshotValue = monitorSnapshotValue()
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'energyPriceSave') {
      return jsonResponse(Object.assign({}, snapshotValue.energy, { pricePerKwh: 0.56, costToday: 0.0069, costTotal: 0.2558 }))
    }
    if (body.endpoint === 'monitorEnergy') return jsonResponse(monitorEnergyRangeValue())
    if (body.endpoint === 'monitor') return jsonResponse(snapshotValue)
    return jsonResponse({})
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  assert.equal(await store.loadMonitor(), true)
  store.setMonitorEnergyPriceDraft('0.56')
  assert.equal(await store.saveMonitorEnergyPrice(), true)
  const posted = recorder.calls.filter((call) => call.body.endpoint === 'energyPriceSave')
  assert.equal(posted.length, 1, 'exactly one save request')
  assert.deepEqual(posted[0].body.payload, { pricePerKwh: 0.56 })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.monitor.value.energy.pricePerKwh, 0.56, 'the returned block replaces the snapshot block')
  assert.equal(snapshot.monitor.energy.priceDraft, '', 'the draft clears after a successful save')
  assert.equal(snapshot.monitor.energy.priceSaving, false)
  assert.equal(snapshot.monitor.energy.priceError, null)
})

test('the energy store refuses an out-of-range price without a request', async () => {
  const recorder = hostRecorder((body) => (body.endpoint === 'monitor' ? jsonResponse(monitorSnapshotValue()) : jsonResponse({})))
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  await store.loadMonitor()
  store.setMonitorEnergyPriceDraft('250')
  assert.equal(await store.saveMonitorEnergyPrice(), false)
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'energyPriceSave').length, 0, 'no request for an invalid price')
  assert.equal(store.getSnapshot().monitor.energy.priceError.code, 'invalid_price')
})

test('the monitor toolbar state only accepts offered intervals and toggles pause', () => {
  const store = injectedStore(applyClient().state)
  assert.equal(store.getSnapshot().monitor.intervalMs, 1000)
  assert.equal(store.getSnapshot().monitor.paused, false)

  store.setMonitorInterval(2000)
  assert.equal(store.getSnapshot().monitor.intervalMs, 2000)
  store.setMonitorInterval(1500)
  assert.equal(store.getSnapshot().monitor.intervalMs, 2000, 'unsupported intervals are ignored')
  store.setMonitorInterval(5000)
  assert.equal(store.getSnapshot().monitor.intervalMs, 5000)

  store.setMonitorPaused(true)
  assert.equal(store.getSnapshot().monitor.paused, true)
  store.setMonitorPaused(false)
  assert.equal(store.getSnapshot().monitor.paused, false)
})

test('the process section polls the documented endpoints and guards kills', async () => {
  const rows = [
    {
      pid: 1035,
      name: 'Macs Fan Control',
      cpuPercent: 12.3,
      memoryPercent: 1.2,
      rssBytes: 132512512,
      user: 'tester',
      killable: true,
    },
    { pid: 1, name: 'launchd', cpuPercent: 0, memoryPercent: 0.1, rssBytes: 1024, user: 'root', killable: false },
    { pid: 4242, name: 'stubborn', cpuPercent: 3, memoryPercent: 0.2, rssBytes: 2048, user: 'root', killable: true },
  ]
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'monitorProcesses') {
      return jsonResponse({
        sampledAt: '2026-10-23T11:12:13.000Z',
        sort: body.payload.sort,
        count: rows.length,
        processes: rows,
      })
    }
    if (body.endpoint === 'monitorKill') {
      if (body.payload.pid === 4242) return hostErrorResponse('kill_denied', 'EPERM')
      return jsonResponse({ pid: body.payload.pid, name: 'Macs Fan Control', signal: 'SIGTERM' })
    }
    return jsonResponse({})
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  assert.equal(await store.loadMonitorProcesses(), false, 'a closed section must not poll')
  assert.equal(recorder.calls.length, 0)

  store.toggleMonitorProcesses()
  assert.equal(store.getSnapshot().monitor.processes.open, true)
  await flushAsync()
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.monitor.processes.value.processes.length, 3)
  assert.equal(recorder.calls[0].body.endpoint, 'monitorProcesses')
  assert.equal(recorder.calls[0].body.payload.sort, 'cpu')
  assert.equal(snapshot.monitor.processes.status, 'ready')

  store.setMonitorProcessSort('memory')
  assert.equal(store.getSnapshot().monitor.processes.sort, 'memory')
  await flushAsync()
  const sortCalls = recorder.calls.filter((call) => call.body.endpoint === 'monitorProcesses')
  assert.equal(sortCalls[sortCalls.length - 1].body.payload.sort, 'memory')

  assert.equal(await store.killMonitorProcess(1035), false, 'an unarmed kill must be refused')
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'monitorKill').length, 0)

  store.armProcessKill(1035)
  assert.equal(store.getSnapshot().monitor.processes.armedPid, 1035)
  assert.equal(await store.killMonitorProcess(1035), true)
  const killCall = recorder.calls.find((call) => call.body.endpoint === 'monitorKill')
  assert.ok(killCall, 'the kill must post monitorKill')
  assert.deepEqual(killCall.body.payload, { pid: 1035 })
  snapshot = store.getSnapshot()
  assert.equal(snapshot.monitor.processes.armedPid, null)
  assert.equal(snapshot.monitor.processes.killingPid, null)

  store.armProcessKill(4242)
  assert.equal(await store.killMonitorProcess(4242), false)
  assert.equal(store.getSnapshot().monitor.processes.actionError.code, 'kill_denied')

  store.toggleMonitorProcesses()
  assert.equal(store.getSnapshot().monitor.processes.open, false)
  const callsBefore = recorder.calls.length
  assert.equal(await store.loadMonitorProcesses(), false, 'closing the section stops the polling helper')
  assert.equal(recorder.calls.length, callsBefore)
})

test('fan actions post the contract payloads and adopt the returned block', async () => {
  const ready = monitorFanControl()
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'monitor') return jsonResponse(monitorSnapshotValue())
    if (body.endpoint === 'fanInstall' || body.endpoint === 'fanUninstall' || body.endpoint === 'fanApply') {
      return jsonResponse(ready)
    }
    if (body.endpoint === 'fanPreset') {
      if (body.payload.op === 'save') {
        return jsonResponse({
          presets: [{ id: 'p-new', name: body.payload.name, builtin: false, mode: body.payload.mode, rpm: body.payload.rpm }],
        })
      }
      return jsonResponse({ presets: [] })
    }
    return jsonResponse({})
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  await store.loadMonitor()
  assert.equal(store.getSnapshot().monitor.value.fanControl.state, 'ready')

  assert.equal(await store.fanInstall(), true)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'fanInstall'))
  assert.equal(store.getSnapshot().monitor.fan.pending, null)
  assert.equal(store.getSnapshot().monitor.fan.error, null)

  assert.equal(await store.fanApply({ mode: 'manual', rpm: 2500 }), true)
  const applyCall = recorder.calls.find((call) => call.body.endpoint === 'fanApply')
  assert.ok(applyCall)
  assert.deepEqual(applyCall.body.payload, { mode: 'manual', rpm: 2500 })

  assert.equal(await store.fanApply({ mode: 'auto' }), true)
  assert.deepEqual(
    recorder.calls.filter((call) => call.body.endpoint === 'fanApply')[1].body.payload,
    { mode: 'auto' },
  )

  assert.equal(await store.fanSavePreset({ name: '剪辑', mode: 'manual', rpm: 2500 }), true)
  const savePresetCall = recorder.calls.find((call) => call.body.endpoint === 'fanPreset' && call.body.payload.op === 'save')
  assert.ok(savePresetCall)
  assert.deepEqual(savePresetCall.body.payload, { op: 'save', name: '剪辑', mode: 'manual', rpm: 2500 })
  assert.equal(store.getSnapshot().monitor.value.fanControl.presets[0].id, 'p-new')

  assert.equal(await store.fanDeletePreset('p-new'), true)
  const deletePresetCall = recorder.calls.find((call) => call.body.endpoint === 'fanPreset' && call.body.payload.op === 'delete')
  assert.ok(deletePresetCall)
  assert.deepEqual(deletePresetCall.body.payload, { op: 'delete', id: 'p-new' })
  assert.deepEqual(store.getSnapshot().monitor.value.fanControl.presets, [])

  assert.equal(await store.fanUninstall(), true)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'fanUninstall'))
})

test('the fan slider queue keeps only the newest pending write', async () => {
  const ready = monitorFanControl()
  let releaseFirst = null
  let applyCount = 0
  const recorder = hostRecorder((body) => {
    if (body.endpoint !== 'fanApply') return jsonResponse(monitorSnapshotValue())
    applyCount += 1
    if (applyCount === 1) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve(jsonResponse(ready))
      })
    }
    return jsonResponse(ready)
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  await store.loadMonitor()

  const first = store.fanApply({ mode: 'manual', rpm: 2400 })
  assert.equal(await store.fanApply({ mode: 'manual', rpm: 2600 }), false, 'the second write is queued, not stacked')
  releaseFirst()
  assert.equal(await first, true)
  await flushAsync()
  const payloads = recorder.calls.filter((call) => call.body.endpoint === 'fanApply').map((call) => call.body.payload)
  assert.deepEqual(payloads, [{ mode: 'manual', rpm: 2400 }, { mode: 'manual', rpm: 2600 }])
  assert.equal(store.getSnapshot().monitor.fan.pending, null)
})

test('alert settings and the test notification go through the Host', async () => {
  const saved = {
    settings: {
      enabled: false,
      cpuPercent: 80,
      temperatureCelsius: 100,
      memoryPercent: 85,
      cooldownSeconds: 600,
      notify: false,
    },
    events: [],
  }
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'monitor') return jsonResponse(monitorSnapshotValue())
    if (body.endpoint === 'monitorAlertSave') return jsonResponse(saved)
    if (body.endpoint === 'monitorAlertTest') return jsonResponse({ notified: true })
    return jsonResponse({})
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  await store.loadMonitor()

  const result = await store.saveMonitorAlerts({ enabled: false, cpuPercent: 80 })
  assert.equal(result.ok, true)
  assert.equal(result.settings.cpuPercent, 80)
  const saveCall = recorder.calls.find((call) => call.body.endpoint === 'monitorAlertSave')
  assert.ok(saveCall)
  assert.deepEqual(saveCall.body.payload, { enabled: false, cpuPercent: 80 })
  assert.equal(store.getSnapshot().monitor.value.alerts.settings.cpuPercent, 80)
  assert.equal(store.getSnapshot().monitor.alerts.saving, false)

  const testResult = await store.testMonitorAlerts()
  assert.equal(testResult.ok, true)
  assert.equal(testResult.notified, true)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'monitorAlertTest'))
  assert.equal(store.getSnapshot().monitor.alerts.testing, false)
})

test('the monitor tab renders every documented state without throwing', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()

  const renderWith = (monitorPatch, label) => {
    const next = Object.assign({}, base, {
      monitor: Object.assign({}, base.monitor, monitorPatch),
    })
    store.getSnapshot = () => next
    assert.doesNotThrow(
      () => renderElementTree(main.component({ store, t })),
      `rendering the status tab with ${label} must not throw`,
    )
  }

  const readyValue = monitorSnapshotValue()
  renderWith({}, 'the first-answer skeleton')
  renderWith({ status: 'loading', value: null, error: null }, 'loading')
  renderWith({
    status: 'error',
    value: null,
    error: { code: 'host_unreachable', message: 'gone', details: {} },
  }, 'the first-answer error')
  renderWith({ status: 'ready', value: readyValue }, 'a ready snapshot')
  renderWith({ status: 'ready', value: readyValue, paused: true, intervalMs: 2000 }, 'paused at 2 s')
  renderWith({
    status: 'ready',
    value: readyValue,
    error: { code: 'host_unreachable', message: 'went away', details: {} },
  }, 'a stale-snapshot error')

  // Non-macOS: the whole tab collapses to the unsupported card.
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      capabilities: {
        platform: 'other',
        sensors: { supported: false, reason: 'unsupported-platform' },
        fanControl: { supported: false, reason: 'unsupported-platform' },
        battery: false,
        processes: false,
      },
    }),
  }, 'a non-macOS platform')

  // Defensive nulls: SMC unavailable, no battery, null temperature history.
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      sample: monitorSample({
        cpu: Object.assign({}, monitorSample().cpu, { temperatureCelsius: null, perCorePercent: [] }),
        sensors: monitorSensors({
          available: true,
          reason: 'starting',
          groups: {},
          readings: [],
        }),
        battery: null,
      }),
      history: monitorHistory({ cpuTemperature: [monitorHistoryPoint(0, null), monitorHistoryPoint(1, null)] }),
    }),
  }, 'sensors still starting up')
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      sample: monitorSample({
        cpu: Object.assign({}, monitorSample().cpu, { temperatureCelsius: null }),
        sensors: monitorSensors({
          available: false,
          reason: 'smc-unavailable',
          groups: {
            cpuPerformance: null,
            cpuEfficiency: null,
            gpu: null,
            ssd: null,
            memory: null,
            wifi: null,
            battery: null,
            ambient: null,
          },
          readings: [],
        }),
      }),
    }),
  }, 'SMC unavailable')

  // Battery present, including nullable health/cycle fields.
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      sample: monitorSample({
        battery: {
          percent: 72,
          charging: true,
          pluggedIn: true,
          timeRemainingMinutes: null,
          healthPercent: null,
          cycleCount: null,
        },
      }),
    }),
  }, 'a battery with unknown health')
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      sample: monitorSample({
        battery: {
          percent: 31,
          charging: false,
          pluggedIn: false,
          timeRemainingMinutes: 95,
          healthPercent: 88,
          cycleCount: 210,
        },
      }),
    }),
  }, 'a discharging battery')

  // Fan control: every documented state.
  for (const fanState of ['not-installed', 'installing', 'unavailable', 'error', 'ready']) {
    const fanControl = monitorFanControl({
      state: fanState,
      installed: fanState === 'ready' || fanState === 'error',
      running: fanState === 'ready',
      reason: fanState === 'unavailable'
        ? 'swift-missing'
        : (fanState === 'error' ? 'cancelled' : (fanState === 'not-installed' ? 'not-installed' : null)),
      message: fanState === 'error' ? 'the operator cancelled the dialog' : null,
      mode: fanState === 'ready' ? 'manual' : 'auto',
      appliedRpm: fanState === 'ready' ? 2600 : null,
      lastAppliedAt: fanState === 'ready' ? '2026-10-23T11:11:00.000Z' : null,
      otherControllers: fanState === 'ready'
        ? [{ name: 'Macs Fan Control', pid: 1035 }]
        : [],
    })
    renderWith({
      status: 'ready',
      value: monitorSnapshotValue({ fanControl }),
    }, `fanControl.state=${fanState}`)
  }
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      fanControl: monitorFanControl({ state: 'error', installed: true, reason: 'daemon-unreachable', message: 'socket timeout' }),
    }),
  }, 'a daemon-unreachable error')
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      fanControl: { state: 'ready', installed: true, running: true, error: null, presets: [] },
    }),
  }, 'a sparse fanControl block')
  renderWith({ status: 'ready', value: monitorSnapshotValue({ fanControl: null }) }, 'a missing fanControl block')

  // Process ranking: expanded with rows, then failed, then empty.
  const processRows = {
    sampledAt: '2026-10-23T11:12:13.000Z',
    sort: 'cpu',
    count: 3,
    processes: [
      { pid: 1035, name: 'Macs Fan Control', cpuPercent: 12.3, memoryPercent: 1.2, rssBytes: 132512512, user: 'tester', killable: true },
      { pid: 1, name: 'launchd', cpuPercent: 0, memoryPercent: 0.1, rssBytes: 1024, user: 'root', killable: false },
      { pid: 300, name: 'kernel_task', cpuPercent: 5, memoryPercent: 0.4, rssBytes: 4096, user: 'root' },
    ],
  }
  renderWith({
    status: 'ready',
    value: readyValue,
    processes: Object.assign({}, base.monitor.processes, {
      open: true,
      status: 'ready',
      value: processRows,
      sort: 'cpu',
      armedPid: 1035,
      killingPid: null,
      actionError: null,
      error: null,
    }),
  }, 'an expanded ranking with an armed kill')
  renderWith({
    status: 'ready',
    value: readyValue,
    processes: Object.assign({}, base.monitor.processes, {
      open: true,
      status: 'ready',
      value: processRows,
      actionError: { code: 'kill_denied', message: 'EPERM', details: {} },
      error: { code: 'host_unreachable', message: 'stale read', details: {} },
    }),
  }, 'a ranking with action and list errors')
  renderWith({
    status: 'ready',
    value: readyValue,
    processes: Object.assign({}, base.monitor.processes, {
      open: true,
      status: 'error',
      value: null,
      error: { code: 'host_unreachable', message: 'gone', details: {} },
    }),
  }, 'a failed ranking')
  renderWith({
    status: 'ready',
    value: readyValue,
    processes: Object.assign({}, base.monitor.processes, {
      open: true,
      status: 'ready',
      value: Object.assign({}, processRows, { processes: [], count: 0 }),
    }),
  }, 'an empty ranking')

  // Alerts: every metric in the event list, plus a missing block.
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      alerts: monitorAlerts({
        events: [
          { id: 'e1', at: '2026-10-23T11:10:00.000Z', metric: 'cpu', value: 96.2, threshold: 90 },
          { id: 'e2', at: '2026-10-23T11:09:00.000Z', metric: 'temperature', value: 99.1, threshold: 95 },
          { id: 'e3', at: '2026-10-23T11:08:00.000Z', metric: 'memory', value: 91, threshold: 90 },
        ],
      }),
    }),
  }, 'alert events for all three metrics')
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({ alerts: null }),
  }, 'a missing alerts block')

  // A Host that predates the power block (or a Mac without IOReport) must
  // still render: the card disappears and the section explains the gap.
  renderWith({
    status: 'ready',
    value: monitorSnapshotValue({
      sample: monitorSample({ power: null }),
      history: monitorHistory({ power: undefined, fanRpm: undefined }),
    }),
  }, 'a sample without the power block')
})

test('the power card renders SoC wattage, the cluster breakdown and the session energy', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key, params) => (params === undefined ? key : `${key}(${Object.values(params).join('|')})`)
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: { ...base.monitor, status: 'ready', value: monitorSnapshotValue() },
  })
  const strings = renderedStrings(main.component({ store, t }))
  for (const expected of [
    'monitor.power.title',
    'monitor.power.unit',
    'monitor.power.cpu',
    'monitor.power.gpu',
    'monitor.power.dram',
    'monitor.power.ane',
    '19.8 W',
    '13.7 W',
    '3.6 W',
    '2.5 W',
    '0.0 W',
    'monitor.power.energy(0.042 Wh)',
  ]) {
    assert.ok(strings.includes(expected), `expected the power card to render ${expected}`)
  }
})

test('the power section renders the correlation readouts and scatter charts', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: { ...base.monitor, sub: 'sensors', status: 'ready', value: monitorSnapshotValue() },
  })
  const strings = renderedStrings(main.component({ store, t }))
  for (const expected of [
    'monitor.power.section.title',
    'monitor.power.section.meta',
    'monitor.power.resistance',
    'monitor.power.efficiency',
    'monitor.power.resistanceValue',
    'monitor.power.efficiencyValue',
    'monitor.power.scatter.temperature',
    'monitor.power.scatter.fan',
    'monitor.power.scatter.range',
  ]) {
    assert.ok(strings.includes(expected), `expected the power section to render ${expected}`)
  }
})

test('the power section degrades to the unavailable hint without IOReport', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: {
      ...base.monitor, sub: 'sensors',
      status: 'ready',
      value: monitorSnapshotValue({
        sample: monitorSample({
          power: monitorPower({
            available: false,
            cpuW: null,
            gpuW: null,
            aneW: null,
            dramW: null,
            socW: null,
            energyWh: 0,
            since: null,
          }),
        }),
      }),
    },
  })
  const strings = renderedStrings(main.component({ store, t }))
  assert.ok(strings.includes('monitor.power.section.title'), 'the section title still renders')
  assert.ok(strings.includes('monitor.power.unavailable'), 'the unavailable hint must explain the gap')
  assert.equal(strings.includes('monitor.power.energy'), false, 'no power card without a reading')
  assert.equal(strings.includes('monitor.power.scatter.range'), false, 'no charts without a reading')
})

test('the energy section renders the range total, the daily bars and the ledger totals', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key, params) => (params === undefined ? key : `${key}(${Object.values(params).join('|')})`)
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: {
      ...base.monitor, sub: 'energy',
      status: 'ready',
      value: monitorSnapshotValue(),
      energy: {
        range: '7d',
        from: '',
        to: '',
        status: 'ready',
        value: monitorEnergyRangeValue(),
        error: null,
        fetchedAt: 0,
      },
    },
  })
  const strings = renderedStrings(main.component({ store, t }))
  for (const expected of [
    'monitor.energy.title',
    'monitor.energy.range.7d',
    'monitor.energy.unit',
    '29.8',
    'monitor.energy.totals(0.01|0.46)',
  ]) {
    assert.ok(strings.includes(expected), `expected the energy section to render ${expected}`)
  }
  assert.ok(strings.some((entry) => entry.startsWith('2026-10-30 · ')), 'the bar tooltip carries the date and kWh')
})

test('the energy section renders the custom date controls', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: {
      ...base.monitor, sub: 'energy',
      status: 'ready',
      value: monitorSnapshotValue(),
      energy: {
        range: 'custom',
        from: '2026-10-01',
        to: '2026-10-31',
        status: 'ready',
        value: monitorEnergyRangeValue(),
        error: null,
        fetchedAt: 0,
      },
    },
  })
  const strings = renderedStrings(main.component({ store, t }))
  for (const expected of ['monitor.energy.from', 'monitor.energy.apply']) {
    assert.ok(strings.includes(expected), `expected the custom range control ${expected}`)
  }
})

test('the energy section localizes an invalid custom range', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: {
      ...base.monitor, sub: 'energy',
      status: 'ready',
      value: monitorSnapshotValue(),
      energy: {
        range: 'custom',
        from: '',
        to: '',
        status: 'error',
        value: null,
        error: { code: 'invalid_range', message: 'the custom range is incomplete', details: {} },
        fetchedAt: 0,
      },
    },
  })
  const strings = renderedStrings(main.component({ store, t }))
  assert.ok(strings.includes('monitor.energy.invalidRange'), 'the invalid-range hint must be localized')
})

test('the energy section renders the price editor, the cost line and the grouping selector', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key, params) => (params === undefined ? key : `${key}(${Object.values(params).join('|')})`)
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: {
      ...base.monitor, sub: 'energy',
      status: 'ready',
      value: monitorSnapshotValue(),
      energy: {
        range: '7d',
        from: '',
        to: '',
        groupBy: 'week',
        status: 'ready',
        value: monitorEnergyRangeValue(),
        error: null,
        fetchedAt: 0,
        priceDraft: '',
        priceSaving: false,
        priceError: null,
      },
    },
  })
  const strings = renderedStrings(main.component({ store, t }))
  for (const expected of [
    'monitor.energy.priceLabel',
    'monitor.energy.priceUnit',
    'monitor.energy.priceSave',
    'monitor.energy.cost(16.69|0.56)',
    'monitor.energy.group.auto',
    'monitor.energy.group.day',
    'monitor.energy.group.week',
    'monitor.energy.group.month',
  ]) {
    assert.ok(strings.includes(expected), `expected the energy controls to render ${expected}`)
  }
})

test('the energy chart groups daily samples into Monday-based weeks', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  const days = []
  for (let index = 0; index < 14; index += 1) {
    const date = new Date(2026, 9, 1 + index, 12)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    days.push({ date: key, wh: 1000 })
  }
  const renderBars = (groupBy) => {
    store.getSnapshot = () => ({
      ...base,
      monitor: {
        ...base.monitor, sub: 'energy',
        status: 'ready',
        value: monitorSnapshotValue(),
        energy: {
          range: '30d',
          from: '',
          to: '',
          groupBy,
          status: 'ready',
          value: {
            from: '2026-10-01',
            to: '2026-10-14',
            days,
            totalWh: 14000,
            averageWh: 1000,
            pricePerKwh: 0.5,
            totalCost: 7,
            averageCost: 0.5,
          },
          error: null,
          fetchedAt: 0,
          priceDraft: '',
          priceSaving: false,
          priceError: null,
        },
      },
    })
    return renderedElements(main.component({ store, t }), (element) => element.props?.className === 'dshMacToolsMonitorEnergyBar')
  }
  // 2026-10-01 is a Thursday: Sep 28, Oct 5 and Oct 12 are the three Mondays.
  assert.equal(renderBars('day').length, 14, 'daily grouping keeps one bar per day')
  assert.equal(renderBars('week').length, 3, 'weekly grouping collapses to three Monday-based buckets')
})

test('the status page renders a left sub-page rail and only the selected page', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  const renderPage = (sub) => {
    store.getSnapshot = () => ({
      ...base,
      monitor: { ...base.monitor, sub, status: 'ready', value: monitorSnapshotValue() },
    })
    return renderedStrings(main.component({ store, t }))
  }
  const overview = renderPage('overview')
  for (const key of [
    'monitor.subnav.overview',
    'monitor.subnav.sensors',
    'monitor.subnav.energy',
    'monitor.subnav.fan',
    'monitor.subnav.processes',
    'monitor.subnav.alerts',
    'monitor.subnav.system',
  ]) {
    assert.ok(overview.includes(key), `the rail must render ${key}`)
  }
  assert.ok(overview.includes('monitor.cpu.title'), 'the overview page shows the CPU card')
  assert.equal(overview.includes('monitor.sensors.title'), false, 'the overview page must not render the sensors section')
  assert.equal(overview.includes('monitor.energy.title'), false, 'the overview page must not render the energy section')

  const sensors = renderPage('sensors')
  assert.ok(sensors.includes('monitor.sensors.title'), 'the sensors page shows the temperature section')
  assert.ok(sensors.includes('monitor.power.section.title'), 'the sensors page shows power and cooling')
  assert.equal(sensors.includes('monitor.cpu.title'), false, 'the sensors page must not render the overview cards')

  const energy = renderPage('energy')
  assert.ok(energy.includes('monitor.energy.title'))
  assert.equal(energy.includes('monitor.sensors.title'), false)

  const fan = renderPage('fan')
  assert.ok(fan.includes('monitor.fan.title'))
  assert.equal(fan.includes('monitor.energy.title'), false)

  const alerts = renderPage('alerts')
  assert.ok(alerts.includes('monitor.alerts.title'))

  const system = renderPage('system')
  assert.ok(system.includes('monitor.system.title'))
  assert.equal(system.includes('monitor.fan.title'), false)

  store.getSnapshot = () => ({
    ...base,
    monitor: { ...base.monitor, sub: 'overview', status: 'ready', value: monitorSnapshotValue() },
  })
  const tree = main.component({ store, t })
  const railButtons = renderedElements(tree, (element) => String(element.props?.className ?? '').includes('dshMacToolsMonitorSubnavItem'))
  assert.equal(railButtons.length, 7, 'one rail button per sub-page')
  const rail = renderedElements(tree, (element) => element.props?.className === 'dshMacToolsMonitorSubnav')
  assert.equal(rail.length, 1, 'the rail is one labelled nav element')
  assert.equal(rail[0].props['aria-label'], 'monitor.subnav.aria')
})

test('selecting the processes sub-page opens the ranking and leaving it stops the poll', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'monitor') return jsonResponse(monitorSnapshotValue())
    if (body.endpoint === 'monitorProcesses') return jsonResponse({ sampledAt: '2026-11-05T06:00:00.000Z', sort: 'cpu', count: 0, processes: [] })
    return jsonResponse({})
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  assert.equal(await store.loadMonitor(), true)
  store.setMonitorSub('processes')
  await flushAsync()
  assert.equal(store.getSnapshot().monitor.sub, 'processes')
  assert.equal(store.getSnapshot().monitor.processes.open, true, 'the ranking opens with its sub-page')
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'monitorProcesses').length, 1, 'the first ranking read is seeded')
  store.setMonitorSub('overview')
  assert.equal(store.getSnapshot().monitor.processes.open, false, 'leaving the page stops the 3 s poll')
})

test('the overview renders the compact fan card with a slider and quick actions', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  store.getSnapshot = () => ({
    ...base,
    monitor: { ...base.monitor, sub: 'overview', status: 'ready', value: monitorSnapshotValue() },
  })
  const tree = main.component({ store, t })
  const strings = renderedStrings(tree)
  for (const expected of ['monitor.fan.title', 'monitor.fan.quick.rpm', 'monitor.fan.quick.full', 'monitor.fan.mode.auto', '2220']) {
    assert.ok(strings.includes(expected), `expected the fan card to render ${expected}`)
  }
  const sliders = renderedElements(tree, (element) => element.type === 'input' && element.props?.type === 'range')
  assert.equal(sliders.length, 1, 'the compact card owns one RPM slider')
  assert.equal(sliders[0].props.min, 1000)
  assert.equal(sliders[0].props.max, 4900)

  // Control not installed yet: the card explains and links to the fan sub-page.
  const fixtureFanControl = monitorSnapshotValue().fanControl
  store.getSnapshot = () => ({
    ...base,
    monitor: {
      ...base.monitor,
      sub: 'overview',
      status: 'ready',
      value: monitorSnapshotValue({
        fanControl: Object.assign({}, fixtureFanControl, { state: 'not-installed', installed: false, running: false }),
      }),
    },
  })
  const notReady = renderedStrings(main.component({ store, t }))
  assert.ok(notReady.includes('monitor.fan.quick.open'), 'the card links to the fan sub-page')
  assert.equal(notReady.includes('monitor.fan.quick.full'), false, 'no quick action without control')
})

test('every chart carries a timeline', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  const setSnapshot = (monitorPatch) => {
    store.getSnapshot = () => ({ ...base, monitor: { ...base.monitor, status: 'ready', ...monitorPatch } })
    return main.component({ store, t })
  }

  const overview = setSnapshot({ sub: 'overview', value: monitorSnapshotValue() })
  const timelines = renderedElements(overview, (element) => element.props?.className === 'dshMacToolsMonitorTimeline')
  assert.equal(timelines.length, 4, 'the four overview sparklines carry a clock timeline')
  assert.equal(timelines[0].props.children.length, 3, 'the timeline shows start / middle / end clocks')

  const sensors = setSnapshot({ sub: 'sensors', value: monitorSnapshotValue() })
  const sensorStrings = renderedStrings(sensors)
  assert.ok(
    sensorStrings.includes('monitor.power.scatter.timeRange'),
    'the correlation scatters carry the sample time window',
  )

  const energy = setSnapshot({
    sub: 'energy',
    value: monitorSnapshotValue(),
    energy: {
      range: '7d',
      from: '',
      to: '',
      groupBy: 'day',
      status: 'ready',
      value: monitorEnergyRangeValue(),
      error: null,
      fetchedAt: 0,
      priceDraft: '',
      priceSaving: false,
      priceError: null,
    },
  })
  const energyStrings = renderedStrings(energy)
  assert.ok(energyStrings.includes('2026-10-30'), 'the energy timeline starts at the first bucket')
  assert.ok(energyStrings.includes('2026-11-02'), 'the energy timeline ends at the last bucket')
})

test('the process ranking sorts by clicking a column header', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'monitor') return jsonResponse(monitorSnapshotValue())
    if (body.endpoint === 'monitorProcesses') {
      return jsonResponse({ sampledAt: 'now', sort: body.payload.sort, order: body.payload.order, count: 0, processes: [] })
    }
    return jsonResponse({})
  })
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)
  assert.equal(await store.loadMonitor(), true)
  store.setMonitorSub('processes')
  await flushAsync()
  const first = recorder.calls.find((call) => call.body.endpoint === 'monitorProcesses')
  assert.deepEqual(first.body.payload, { sort: 'cpu', order: 'desc' }, 'the sub-page seeds the default ranking')

  // A second click on the active column reverses the direction.
  store.setMonitorProcessSort('cpu')
  assert.equal(store.getSnapshot().monitor.processes.order, 'asc')
  await flushAsync()
  // A different column starts in its natural direction.
  store.setMonitorProcessSort('name')
  assert.equal(store.getSnapshot().monitor.processes.sort, 'name')
  assert.equal(store.getSnapshot().monitor.processes.order, 'asc')
  store.setMonitorProcessSort('rss')
  assert.equal(store.getSnapshot().monitor.processes.sort, 'rss')
  assert.equal(store.getSnapshot().monitor.processes.order, 'desc')
})

test('the process ranking exposes sortable column headers and a PID column', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  const processRows = {
    sampledAt: 'now',
    sort: 'cpu',
    order: 'desc',
    count: 2,
    processes: [
      { pid: 1035, name: 'Macs Fan Control', cpuPercent: 12.3, memoryPercent: 1.2, rssBytes: 132512512, user: 'tester', killable: true },
      { pid: 1, name: 'launchd', cpuPercent: 0, memoryPercent: 0.1, rssBytes: 1024, user: 'root', killable: false },
    ],
  }
  store.getSnapshot = () => ({
    ...base,
    monitor: {
      ...base.monitor,
      sub: 'processes',
      status: 'ready',
      value: monitorSnapshotValue(),
      processes: { ...base.monitor.processes, open: true, status: 'ready', value: processRows },
    },
  })
  const tree = main.component({ store, t })
  const headers = renderedElements(tree, (element) => String(element.props?.className ?? '').includes('dshMacToolsMonitorProcessSortButton'))
  assert.equal(headers.length, 5, 'name / pid / cpu / memory / rss are sortable')
  assert.equal(headers.filter((element) => element.props['aria-pressed'] === true).length, 1, 'exactly one active sort column')
  assert.ok(renderedStrings(tree).includes('1035'), 'the PID column renders the pid')
})

test('the fan 自动 control applies the temperature curve, not the system auto', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'monitor') return jsonResponse(monitorSnapshotValue())
    if (body.endpoint === 'fanApply') return jsonResponse(Object.assign({}, monitorSnapshotValue().fanControl, { mode: body.payload.mode }))
    return jsonResponse({})
  })
  const applied = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(applied.state)
  assert.equal(await store.loadMonitor(), true)
  store.setMonitorSub('fan')
  const main = applied.state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const render = () => main.component({ store, t })
  const buttons = renderedElements(render(), (element) => element.type === 'button')
  const byLabel = (label) => buttons.find((element) => element.children[0] === label)

  const autoButton = byLabel('monitor.fan.mode.auto')
  assert.ok(autoButton, 'the 自动 mode button is rendered')
  autoButton.props.onClick()
  await flushAsync()
  let posted = recorder.calls.filter((call) => call.body.endpoint === 'fanApply')
  assert.equal(posted.length, 1, '自动 posts exactly one fan apply')
  assert.equal(posted[0].body.payload.mode, 'curve', '自动 is the temperature curve')
  assert.equal(posted[0].body.payload.sensor, 'cpuPerformance')
  assert.equal(posted[0].body.payload.points.length, 4)

  const manualButton = byLabel('monitor.fan.mode.manual')
  assert.ok(manualButton, 'the 手动 mode button is rendered')
  manualButton.props.onClick()
  await flushAsync()
  posted = recorder.calls.filter((call) => call.body.endpoint === 'fanApply')
  assert.equal(posted[1].body.payload.mode, 'manual')

  const restoreButton = byLabel('monitor.fan.restoreAuto')
  assert.ok(restoreButton, '恢复系统自动 is still offered')
  restoreButton.props.onClick()
  await flushAsync()
  posted = recorder.calls.filter((call) => call.body.endpoint === 'fanApply')
  assert.equal(posted[2].body.payload.mode, 'auto', '恢复系统自动 hands the fan back to the SMC')
})

test('the overview fan card 自动 applies the temperature curve', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'monitor') return jsonResponse(monitorSnapshotValue())
    if (body.endpoint === 'fanApply') return jsonResponse(monitorSnapshotValue().fanControl)
    return jsonResponse({})
  })
  const applied = applyClient({ fetch: recorder.fetch })
  const store = injectedStore(applied.state)
  assert.equal(await store.loadMonitor(), true)
  const main = applied.state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const tree = main.component({ store, t })
  const buttons = renderedElements(tree, (element) => element.type === 'button')
  const autoButton = buttons.find((element) => element.children[0] === 'monitor.fan.mode.auto')
  assert.ok(autoButton, 'the compact card renders the 自动 action')
  autoButton.props.onClick()
  await flushAsync()
  const posted = recorder.calls.filter((call) => call.body.endpoint === 'fanApply')
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body.payload.mode, 'curve', 'the compact 自动 follows the temperature curve')
  assert.equal(posted[0].body.payload.sensor, 'cpuPerformance')
  assert.equal(posted[0].body.payload.points.length, 4)
})

test('the monitor source and stylesheet keep the bundle constraints', () => {
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorOverview'), 'the overview grid must be styled')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorSubnav'), 'the sub-page rail must be styled')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorTimeline'), 'the chart timelines must be styled')
  assert.ok(CLIENT_SOURCE.includes('function MonitorFanQuickCard'), 'the compact fan card must exist')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorProcessSortButton'), 'the sortable process headers must be styled')
  assert.ok(CLIENT_SOURCE.includes('function MonitorEnergySection'), 'the energy section must exist')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorPowerCharts'), 'the power charts must be styled')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorScatterDot'), 'the scatter dots must be styled')
  assert.ok(CLIENT_SOURCE.includes('function MonitorPowerSection'), 'the power section must exist')
  assert.ok(CLIENT_SOURCE.includes('h(MonitorPowerSection'), 'the power section must be mounted')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorCurveSvg'), 'the curve editor must be styled')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorProcessRow'), 'the process ranking must be styled')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorAlertGrid'), 'the alert form must be styled')
  assert.ok(CLIENT_SOURCE.includes('.dshMacToolsMonitorSection'), 'the status sections must be styled')
  assert.ok(CLIENT_SOURCE.includes('prefers-reduced-motion:reduce'), 'the status tab must respect reduced motion')

  for (const endpoint of [
    'monitor',
    'monitorProcesses',
    'monitorKill',
    'monitorAlertSave',
    'monitorAlertTest',
    'fanInstall',
    'fanUninstall',
    'fanApply',
    'fanPreset',
  ]) {
    assert.ok(CLIENT_SOURCE.includes(`'${endpoint}'`), `the status tab must consume the ${endpoint} endpoint`)
  }
  assert.ok((CLIENT_SOURCE.match(/new AbortController\(/gu) || []).length >= 4, 'polling effects must own an AbortController')
  assert.ok(CLIENT_SOURCE.includes('killable'), 'the Host computed killable flag must guard the kill action')
  assert.equal(CLIENT_SOURCE.includes('setInterval'), true)
  assert.equal(CLIENT_SOURCE.includes('document.body'), false)
  assert.equal((CLIENT_SOURCE.match(/require\('/gu) || []).length, 1)
})

test('the System tab machinery and its old locale keys are gone', () => {
  const { state } = applyClient()
  const { zh, en } = state.locales[0].dictionaries

  // Source: no standalone system loader/tab/polling or store slice.
  for (const token of [
    'loadSystem',
    'SYSTEM_POLL_MS',
    'function SystemTab',
    'snapshot.system',
    "tab.system",
  ]) {
    assert.equal(CLIENT_SOURCE.includes(token), false, `the client still mentions ${token}`)
  }
  assert.equal(CLIENT_SOURCE.includes("host.post('system'"), false, 'the standalone system endpoint must not be polled')
  assert.ok(CLIENT_SOURCE.includes('function MonitorSystemSection'), 'the merged section must exist')
  assert.ok(CLIENT_SOURCE.includes('h(MonitorSystemSection'), 'the merged section must be mounted')
  assert.ok(CLIENT_SOURCE.includes('dshMacToolsSysGrid'), 'the old card style must be reused')
  assert.ok(CLIENT_SOURCE.includes('function SystemCard'), 'the card helper must be kept for the merged section')

  // Dictionaries: removed keys are absent in both languages.
  const removed = [
    'tab.system',
    'system.refresh',
    'system.refreshing',
    'system.loading',
    'system.error',
    'system.cpu',
    'system.memory',
    'system.disk',
    'system.battery',
    'system.host',
    'system.used',
    'system.level',
    'system.memoryUsed',
    'system.diskUsed',
    'system.diskFree',
    'system.mount',
    'system.usedPercent',
    'system.batteryCharging',
    'system.batteryRemaining',
    'system.batteryCharged',
    'system.batteryUnknown',
    'system.capabilityScreenshot',
    'system.empty',
  ]
  for (const key of removed) {
    assert.equal(key in zh, false, `zh.${key} should be removed`)
    assert.equal(key in en, false, `en.${key} should be removed`)
  }

  // The surviving keys still used by the merged section exist in both.
  const kept = [
    'system.os',
    'system.arch',
    'system.hostname',
    'system.model',
    'system.version',
    'system.cores',
    'system.coresLabel',
    'system.uptime',
    'system.uptimeValue',
    'system.available',
    'system.unavailable',
    'system.saveDirectory',
    'system.capturedAt',
    'system.unknown',
  ]
  for (const key of kept) assert.ok(key in zh && key in en, `missing kept dictionary key: ${key}`)

  // Every new merged-section key is present in both languages with parity.
  const zhMerged = Object.keys(zh).filter((key) => key.startsWith('monitor.system.')).sort()
  const enMerged = Object.keys(en).filter((key) => key.startsWith('monitor.system.')).sort()
  assert.deepEqual(zhMerged, enMerged, 'the merged section keys must be complete in both languages')
  assert.ok(zhMerged.length >= 18, `expected a complete merged-section dictionary, got ${zhMerged.length}`)
  for (const key of zhMerged) {
    assert.equal(typeof zh[key], 'string')
    assert.notEqual(zh[key].trim(), '')
    assert.notEqual(en[key].trim(), '')
  }
  assert.match(zh['monitor.system.title'], /[\u4e00-\u9fff]/u)
  assert.notEqual(zh['monitor.system.title'], en['monitor.system.title'])
})

test('the merged system-information section renders hardware, runtime and capabilities', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  const hostValue = {
    version: '0.3.0',
    platform: 'darwin',
    saveDirectory: '/Users/tester/Pictures/DSH Mac Tools',
    hostPid: 4242,
    capabilities: {
      screenshot: true,
      calculator: true,
      clipboard: true,
      system: true,
      hideApp: false,
      pin: true,
      history: true,
      transfer: true,
      monitor: true,
      fanControl: true,
    },
  }
  const renderTexts = (snapshot) => {
    store.getSnapshot = () => snapshot
    return renderedStrings(main.component({ store, t }))
  }

  const ready = renderTexts({
    ...base,
    host: { kind: 'ready', value: hostValue, http: 200, message: '' },
    monitor: { ...base.monitor, sub: 'system', status: 'ready', value: monitorSnapshotValue() },
  })
  for (const key of [
    'monitor.system.title',
    'monitor.system.hardware',
    'monitor.system.runtime',
    'monitor.system.capabilities',
    'monitor.system.chip',
    'monitor.system.coresDetail',
    'monitor.system.hostPid',
    'monitor.system.sampledAt',
    'monitor.system.interval',
    'monitor.system.polling',
    'monitor.system.pollingActive',
    'monitor.system.capability.screenshot',
    'monitor.system.capability.hideApp',
    'monitor.system.capability.pin',
    'monitor.system.capability.history',
    'monitor.system.capability.transfer',
    'monitor.system.capability.monitor',
    'monitor.system.capability.fanControl',
    'monitor.system.note',
    'system.os',
    'system.arch',
    'system.hostname',
    'system.model',
    'system.coresLabel',
    'system.uptime',
    'system.uptimeValue',
    'system.version',
    'system.saveDirectory',
    'system.capturedAt',
  ]) {
    assert.ok(ready.includes(key), `the merged section must render ${key}`)
  }
  assert.ok(ready.includes('system.available'), 'capabilities must render as available')
  assert.ok(ready.includes('system.unavailable'), 'the disabled hideApp capability must render as unavailable')
  assert.equal(ready.filter((entry) => entry === 'system.available').length >= 6, true)
  // The values themselves (not only their labels) reach the render tree.
  assert.ok(ready.includes('Apple M4'))
  assert.ok(ready.includes('Mac16,10'))
  assert.ok(ready.includes('4242'))
  assert.ok(ready.includes(hostValue.saveDirectory))
  assert.ok(ready.includes('0.3.0'))
  // Memory / disk / battery stay in the overview cards only: the old system
  // card labels are gone, and the note points at the cards above.
  for (const gone of ['system.memory', 'system.disk', 'system.battery', 'system.cpu', 'system.capabilityScreenshot']) {
    assert.equal(ready.includes(gone), false, `the merged section must not render ${gone}`)
  }
  // The overview cards live on their own sub-page now; the system sub-page
  // must not duplicate them.
  const overviewTexts = renderTexts({
    ...base,
    host: { kind: 'ready', value: hostValue, http: 200, message: '' },
    monitor: { ...base.monitor, sub: 'overview', status: 'ready', value: monitorSnapshotValue() },
  })
  for (const overviewKey of ['monitor.cpu.title', 'monitor.memory.title', 'monitor.disk.title', 'monitor.network.title']) {
    assert.ok(overviewTexts.includes(overviewKey), `the overview card ${overviewKey} must stay`)
    assert.equal(ready.includes(overviewKey), false, `the system sub-page must not render ${overviewKey}`)
  }
})

test('the system-information section degrades when Host status is unavailable', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()

  const renderTexts = (snapshot) => {
    store.getSnapshot = () => snapshot
    return renderedStrings(main.component({ store, t }))
  }

  // Host still loading: capability rows say "connecting", nothing throws.
  const loading = renderTexts({
    ...base,
    host: { kind: 'loading', value: null, http: 0, message: '' },
    monitor: { ...base.monitor, sub: 'system', status: 'ready', value: monitorSnapshotValue() },
  })
  assert.ok(loading.includes('monitor.system.title'))
  assert.ok(loading.includes('host.loading'), 'capability rows must degrade to the loading copy')
  assert.ok(loading.includes('system.unknown'), 'runtime facts must degrade to the unknown copy')

  // Host missing entirely: credentials/permission rows fall back to 未知.
  const missing = renderTexts({
    ...base,
    host: { kind: 'missing', value: null, http: 404, message: 'no route' },
    monitor: { ...base.monitor, sub: 'system', status: 'ready', value: monitorSnapshotValue() },
  })
  assert.ok(missing.includes('monitor.system.title'))
  assert.ok(missing.includes('system.unknown'))
  assert.equal(missing.includes('system.available'), false, 'no capability can be claimed without Host facts')

  // No snapshot yet: the status tab shows its skeleton, not the merged section.
  const skeleton = renderTexts({
    ...base,
    host: { kind: 'ready', value: { version: '0.3.0', capabilities: {} }, http: 200, message: '' },
    monitor: { ...base.monitor, status: 'loading', value: null, error: null },
  })
  assert.equal(skeleton.includes('monitor.system.title'), false, 'the merged section waits for the first status snapshot')
  assert.ok(skeleton.includes('monitor.loading'))
})

test('the files dictionaries are complete in both languages', () => {
  const { state } = applyClient()
  const { zh, en } = state.locales[0].dictionaries
  const zhKeys = Object.keys(zh).filter((key) => key === 'tab.files' || key.startsWith('files.')).sort()
  const enKeys = Object.keys(en).filter((key) => key === 'tab.files' || key.startsWith('files.')).sort()
  assert.deepEqual(zhKeys, enKeys, 'both languages must define the same files keys')
  assert.ok(zhKeys.length > 80, `expected a complete files dictionary, got ${zhKeys.length} keys`)
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
  }
  for (const required of [
    'tab.files',
    'files.toolbar.newFolder',
    'files.action.trash',
    'files.preview.title',
    'files.dialog.trashMessage',
    'files.error.unavailable',
    'files.dropActive',
    'files.kind.directory',
    'files.toast.compressed',
    'files.view.list',
    'files.view.icons',
    'files.view.gallery',
    'files.view.aria',
  ]) {
    assert.ok(zhKeys.includes(required), `the files dictionary must define ${required}`)
  }
})

test('the files store loads places, lists folders and applies mutations through the Host', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'filesPlaces') {
      return jsonResponse({
        startDirectory: '/Users/tester',
        favorites: [{ id: 'home', name: 'Home', path: '/Users/tester' }],
        volumes: [{ name: 'Macintosh HD', path: '/', totalBytes: 1000, freeBytes: 400, isRoot: true }],
        recents: [],
      })
    }
    if (body.endpoint === 'filesList') {
      return jsonResponse({
        path: body.payload.path,
        name: body.payload.path === '/' ? '/' : 'tester',
        parent: body.payload.path === '/' ? null : '/Users',
        writable: true,
        system: false,
        freeBytes: 400,
        totalBytes: 1000,
        total: 2,
        truncated: false,
        entries: [
          { name: 'Downloads', path: `${body.payload.path}/Downloads`, kind: 'directory', size: 0, mtime: '2026-01-01T00:00:00.000Z', ext: '', hidden: false, directory: true },
          { name: 'notes.md', path: `${body.payload.path}/notes.md`, kind: 'file', size: 12, mtime: '2026-01-01T00:00:00.000Z', ext: 'md', hidden: false },
        ],
      })
    }
    if (body.endpoint === 'filesRead') {
      return jsonResponse({ path: body.payload.path, name: 'notes.md', text: '# hi', bytes: 4, truncated: false, lines: 1 })
    }
    if (body.endpoint === 'filesTrash') {
      return jsonResponse({ trashed: body.payload.paths.map((path) => ({ path, trashPath: `/Users/tester/.Trash/${path}` })), failed: [] })
    }
    if (body.endpoint === 'filesMkdir') {
      return jsonResponse({ path: `${body.payload.path}/${body.payload.name}`, name: body.payload.name })
    }
    if (body.endpoint === 'filesRename') {
      return jsonResponse({ path: body.payload.path, name: body.payload.name })
    }
    if (body.endpoint === 'filesCompress') return jsonResponse({ path: '/Users/tester/notes.zip', bytes: 128 })
    if (body.endpoint === 'filesSend') return jsonResponse({ items: body.payload.paths.map((path, index) => ({ id: `o${index}`, path })), count: body.payload.paths.length })
    if (body.endpoint === 'clipboard') return jsonResponse({ action: 'write', text: body.payload.text, bytes: 1 })
    if (body.endpoint === 'filesOpen') return jsonResponse({ opened: true, path: body.payload.path })
    return jsonResponse({})
  })
  const calls = recorder.calls
  const store = injectedStore(applyClient({ fetch: recorder.fetch }).state)

  assert.equal(await store.loadFilesPlaces(), true)
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.files.places.status, 'ready')
  assert.equal(snapshot.files.places.favorites[0].id, 'home')
  assert.equal(snapshot.files.places.volumes[0].freeBytes, 400)
  assert.equal(snapshot.files.places.startDirectory, '/Users/tester')

  assert.equal(await store.listFiles('/Users/tester'), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.files.path, '/Users/tester')
  assert.equal(snapshot.files.listing.status, 'ready')
  assert.equal(snapshot.files.listing.entries.length, 2)
  assert.equal(snapshot.files.listing.writable, true)
  assert.equal(snapshot.files.listing.freeBytes, 400)

  // Navigating pushes the previous folder onto the back stack.
  assert.equal(await store.listFiles('/Users/tester/Downloads'), true)
  snapshot = store.getSnapshot()
  assert.deepEqual(Array.from(snapshot.files.back), ['/Users/tester'])
  assert.deepEqual(Array.from(snapshot.files.forward), [])
  await store.filesGoBack()
  snapshot = store.getSnapshot()
  assert.equal(snapshot.files.path, '/Users/tester')
  assert.deepEqual(Array.from(snapshot.files.forward), ['/Users/tester/Downloads'])

  // A single click selects and previews a text file.
  const rows = snapshot.files.listing.entries
  store.filesSelect(rows[1].path, 'single', rows)
  assert.deepEqual(Array.from(store.getSnapshot().files.selection), [rows[1].path])
  assert.equal(await store.filesPreview(rows[1]), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.files.preview.kind, 'text')
  assert.equal(snapshot.files.preview.text, '# hi')

  // An image row is previewed through the authenticated file URL.
  const imageEntry = { name: 'a.png', path: '/Users/tester/a.png', kind: 'file', size: 10, mtime: '2026-01-01T00:00:00.000Z', ext: 'png', hidden: false }
  await store.filesPreview(imageEntry)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.files.preview.kind, 'image')
  assert.match(snapshot.files.preview.url, /\/api\/dsh-mac-tools\?file=/u)

  // New folder and rename dialogs post their endpoints and refresh the listing.
  store.filesOpenDialog('newFolder')
  store.filesSetDialogValue('photos')
  assert.equal(store.getSnapshot().files.dialog.value, 'photos')
  assert.equal(await store.filesConfirmDialog(), true)
  snapshot = store.getSnapshot()
  assert.equal(snapshot.files.dialog, null)
  assert.equal(snapshot.files.toast.key, 'files.toast.created')
  assert.ok(calls.some((call) => call.body.endpoint === 'filesMkdir' && call.body.payload.name === 'photos'))

  store.filesOpenDialog('rename', { path: '/Users/tester/notes.md', value: 'todo.md' })
  assert.equal(await store.filesConfirmDialog(), true)
  assert.ok(calls.some((call) => call.body.endpoint === 'filesRename' && call.body.payload.name === 'todo.md'))

  // Trash, compress and send-to-phone are one round-trip each with a toast.
  store.filesOpenDialog('trash', { paths: ['/Users/tester/notes.md'] })
  assert.equal(await store.filesConfirmDialog(), true)
  assert.equal(store.getSnapshot().files.toast.key, 'files.toast.trashed')
  assert.ok(calls.some((call) => call.body.endpoint === 'filesTrash'))

  assert.equal(await store.filesCompress(['/Users/tester/notes.md']), true)
  assert.equal(store.getSnapshot().files.toast.key, 'files.toast.compressed')
  assert.equal(await store.filesSend(['/Users/tester/notes.md']), true)
  assert.equal(store.getSnapshot().files.toast.key, 'files.toast.sent')

  assert.equal(await store.filesCopyPath(['/Users/tester/notes.md']), true)
  const clipboard = calls.filter((call) => call.body.endpoint === 'clipboard').pop()
  assert.equal(clipboard.body.payload.text, '/Users/tester/notes.md')

  assert.equal(await store.filesOpenPath('/Users/tester/notes.md'), true)
  assert.ok(calls.some((call) => call.body.endpoint === 'filesOpen'))
})

test('the files store imports dropped files through filesDrop', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'filesList') {
      return jsonResponse({ path: body.payload.path, parent: '/', writable: true, system: false, freeBytes: 1, totalBytes: 2, total: 0, truncated: false, entries: [] })
    }
    if (body.endpoint === 'filesDrop') {
      return jsonResponse({ saved: body.payload.files.map((file) => ({ name: file.name, path: `${body.payload.directory}/${file.name}`, bytes: 3 })), failed: [] })
    }
    return jsonResponse({})
  })
  const calls = recorder.calls
  class FakeFileReader {
    readAsDataURL() {
      this.result = 'data:text/plain;base64,QUJD'
      if (typeof this.onload === 'function') this.onload()
    }
  }
  const store = injectedStore(applyClient({ fetch: recorder.fetch, FileReader: FakeFileReader }).state)
  await store.listFiles('/Users/tester')

  assert.equal(await store.filesDropFiles([{ name: 'dropped.txt' }]), true)
  const drop = calls.find((call) => call.body.endpoint === 'filesDrop')
  assert.equal(drop.body.payload.directory, '/Users/tester')
  assert.equal(drop.body.payload.files[0].name, 'dropped.txt')
  assert.equal(drop.body.payload.files[0].dataBase64, 'QUJD')
  assert.equal(store.getSnapshot().files.toast.key, 'files.toast.dropped')
})

test('the files tab renders every documented state without throwing', () => {
  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()

  const entries = [
    { name: 'Downloads', path: '/Users/tester/Downloads', kind: 'directory', size: 0, mtime: '2026-01-01T00:00:00.000Z', ext: '', hidden: false, directory: true },
    { name: 'notes.md', path: '/Users/tester/notes.md', kind: 'file', size: 12, mtime: '2026-01-01T00:00:00.000Z', ext: 'md', hidden: false },
    { name: 'photo.png', path: '/Users/tester/photo.png', kind: 'file', size: 2048, mtime: '2026-01-01T00:00:00.000Z', ext: 'png', hidden: false },
    { name: 'scan.pdf', path: '/Users/tester/scan.pdf', kind: 'file', size: 4096, mtime: '2026-01-01T00:00:00.000Z', ext: 'pdf', hidden: false },
  ]
  const places = {
    status: 'ready',
    error: null,
    favorites: [{ id: 'home', name: 'Home', path: '/Users/tester' }],
    volumes: [{ name: 'Macintosh HD', path: '/', totalBytes: 1000, freeBytes: 400, isRoot: true }],
    recents: [{ name: 'tester', path: '/Users/tester', at: '2026-01-01T00:00:00.000Z' }],
    startDirectory: '/Users/tester',
  }
  const listing = (patch) => ({
    status: 'ready',
    entries,
    parent: '/Users',
    writable: true,
    system: false,
    freeBytes: 400,
    totalBytes: 1000,
    truncated: false,
    total: entries.length,
    error: null,
    ...patch,
  })
  const preview = (patch) => ({
    status: 'ready',
    entry: entries[1],
    kind: 'text',
    text: '# hi',
    truncated: false,
    url: '',
    error: null,
    ...patch,
  })
  const renderWith = (filesPatch, extra) => {
    const next = JSON.parse(JSON.stringify({
      ...base,
      files: { ...base.files, places, path: '/Users/tester', listing: listing({}), ...filesPatch },
      ...(extra === undefined ? {} : extra),
    }))
    store.getSnapshot = () => next
    assert.doesNotThrow(
      () => renderElementTree(main.component({ store, t })),
      `rendering the panel with files ${JSON.stringify(Object.keys(filesPatch))} must not throw`,
    )
  }

  renderWith({})
  renderWith({ places: { ...places, status: 'loading' } })
  renderWith({ listing: listing({ status: 'loading', entries: [] }) })
  renderWith({ listing: listing({ status: 'error', entries: [], error: { code: 'files_not_found', message: 'gone', details: {} } }) })
  renderWith({ listing: listing({ entries: [] }) })
  renderWith({ listing: listing({ writable: false, system: true }), selection: ['/Users/tester/notes.md'] })
  renderWith({ preview: preview({ kind: 'image', url: '/api/dsh-mac-tools?file=x' }) })
  renderWith({ preview: preview({ kind: 'thumb', url: '/api/dsh-mac-tools?thumb=x' }) })
  renderWith({ preview: preview({ kind: 'text', truncated: true, bytes: 256 * 1024 }) })
  renderWith({ preview: preview({ kind: 'directory', entry: entries[0] }) })
  renderWith({ preview: preview({ status: 'loading', kind: 'none', entry: null }) })
  renderWith({ preview: preview({ status: 'error', error: { code: 'files_binary', message: 'binary', details: {} } }) })
  renderWith({ dialog: { kind: 'newFolder', value: 'photos' } })
  renderWith({ dialog: { kind: 'rename', value: 'todo.md', path: '/Users/tester/notes.md' } })
  renderWith({ dialog: { kind: 'trash', paths: ['/Users/tester/notes.md'] } })
  renderWith({ toast: { key: 'files.toast.compressed', params: { path: '/Users/tester/a.zip' }, kind: 'success' } })
  renderWith({ toast: { key: 'files.error.action', params: { message: 'nope' }, kind: 'error' }, actionError: { code: 'files_failed', message: 'nope', details: {} } })
  renderWith({ upload: { active: true, done: 1, total: 3 } })
  renderWith({}, { host: { kind: 'ready', value: { version: '0.3.2', capabilities: { files: true } }, http: 200, message: '' } })
  assert.doesNotThrow(
    () => renderElementTree(main.component({ store: Object.assign({}, store, { getSnapshot: () => ({
      ...base,
      host: { kind: 'ready', value: { version: '0.3.2', capabilities: { files: false } }, http: 200, message: '' },
      files: { ...base.files, places, path: '/Users/tester', listing: listing({}) },
    }) }), t })),
    'rendering an unavailable Files tab must not throw',
  )
})

test('the files store switches layouts and builds image URLs', () => {
  const store = injectedStore(applyClient().state)
  assert.equal(store.getSnapshot().files.view, 'list')
  store.filesSetView('icons')
  assert.equal(store.getSnapshot().files.view, 'icons')
  store.filesSetView('gallery')
  assert.equal(store.getSnapshot().files.view, 'gallery')
  store.filesSetView('carousel')
  assert.equal(store.getSnapshot().files.view, 'gallery', 'unsupported layouts are ignored')
  store.filesSetView('list')
  assert.equal(store.getSnapshot().files.view, 'list')

  const url = store.filesImageUrl({ path: '/Users/tester/a b.png', mtime: '2026-01-01T00:00:00.000Z' })
  assert.match(url, /^\/api\/dsh-mac-tools\?file=/u)
  assert.match(url, /a%20b\.png/u)
  assert.match(url, /&t=\d+/u)
  assert.equal(store.filesImageUrl(null), '')
  assert.equal(store.filesImageUrl({}), '')
})

test('the files layouts render the expected containers and colored icons', () => {
  /** Expand function components so a test can inspect host elements. */
  const expand = (element, depth = 0) => {
    if (depth > 40) throw new Error('element tree is deeper than the panel should be')
    if (element === null || element === undefined) return []
    if (typeof element === 'string' || typeof element === 'number') return [String(element)]
    if (Array.isArray(element)) return element.flatMap((child) => expand(child, depth + 1))
    if (typeof element.type === 'function') return expand(element.type(element.props), depth + 1)
    return [element, ...element.children.flatMap((child) => expand(child, depth + 1))]
  }
  const classNames = (element) => expand(element)
    .map((node) => (node !== null && typeof node === 'object' && node.props !== null && typeof node.props === 'object'
      ? node.props.className
      : undefined))
    .filter((name) => typeof name === 'string')
  const hasClass = (names, className) => names.some((name) => name.split(' ').indexOf(className) >= 0)

  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  const entries = [
    { name: 'Downloads', path: '/Users/tester/Downloads', kind: 'directory', size: 0, mtime: '2026-01-01T00:00:00.000Z', ext: '', hidden: false, directory: true },
    { name: 'photo.png', path: '/Users/tester/photo.png', kind: 'file', size: 2048, mtime: '2026-01-01T00:00:00.000Z', ext: 'png', hidden: false },
    { name: 'notes.md', path: '/Users/tester/notes.md', kind: 'file', size: 12, mtime: '2026-01-01T00:00:00.000Z', ext: 'md', hidden: false },
  ]
  const places = {
    status: 'ready',
    error: null,
    favorites: [{ id: 'home', name: 'Home', path: '/Users/tester' }],
    volumes: [],
    recents: [],
    startDirectory: '/Users/tester',
  }
  const render = (view) => {
    const next = JSON.parse(JSON.stringify({
      ...base,
      files: {
        ...base.files,
        view,
        places,
        path: '/Users/tester',
        listing: {
          status: 'ready',
          entries,
          parent: '/Users',
          writable: true,
          system: false,
          freeBytes: 400,
          totalBytes: 1000,
          truncated: false,
          total: entries.length,
          error: null,
        },
      },
    }))
    store.getSnapshot = () => next
    return classNames(main.component({ store, t }))
  }

  const list = render('list')
  assert.equal(hasClass(list, 'dshMacToolsFilesList'), true)
  assert.equal(hasClass(list, 'dshMacToolsFilesGrid'), false)
  assert.equal(hasClass(list, 'dshMacToolsFilesIcon-directory'), true, 'folders get their own accent color')
  assert.equal(hasClass(list, 'dshMacToolsFilesIcon-image'), true, 'images get their own accent color')

  const icons = render('icons')
  assert.equal(hasClass(icons, 'dshMacToolsFilesGrid'), true)
  assert.equal(hasClass(icons, 'dshMacToolsFilesTile'), true)
  assert.equal(hasClass(icons, 'dshMacToolsFilesTileName'), true)
  assert.equal(hasClass(icons, 'dshMacToolsFilesThumbWrap'), true, 'raster images show a thumbnail tile')

  const gallery = render('gallery')
  assert.equal(hasClass(gallery, 'dshMacToolsFilesGallery'), true)
  assert.equal(hasClass(gallery, 'dshMacToolsFilesGalleryStage'), true)
  assert.equal(hasClass(gallery, 'dshMacToolsFilesStripItem'), true)
  assert.equal(hasClass(gallery, 'dshMacToolsFilesBodyGallery'), true)
})

test('the files action row is always visible and arms once something is selected', () => {
  /** Expand function components so a test can inspect host elements. */
  const expand = (element, depth = 0) => {
    if (depth > 40) throw new Error('element tree is deeper than the panel should be')
    if (element === null || element === undefined) return []
    if (typeof element === 'string' || typeof element === 'number') return [String(element)]
    if (Array.isArray(element)) return element.flatMap((child) => expand(child, depth + 1))
    if (typeof element.type === 'function') return expand(element.type(element.props), depth + 1)
    return [element, ...element.children.flatMap((child) => expand(child, depth + 1))]
  }

  const { state } = applyClient()
  const store = injectedStore(state)
  const main = state.slots.find((slot) => slot.options.name === 'main')
  const t = (key) => key
  const base = store.getSnapshot()
  const entries = [
    { name: 'Downloads', path: '/Users/tester/Downloads', kind: 'directory', size: 0, mtime: '2026-01-01T00:00:00.000Z', ext: '', hidden: false, directory: true },
    { name: 'notes.md', path: '/Users/tester/notes.md', kind: 'file', size: 12, mtime: '2026-01-01T00:00:00.000Z', ext: 'md', hidden: false },
  ]
  const places = {
    status: 'ready',
    error: null,
    favorites: [{ id: 'home', name: 'Home', path: '/Users/tester' }],
    volumes: [],
    recents: [],
    startDirectory: '/Users/tester',
  }
  const render = (selection) => {
    const next = JSON.parse(JSON.stringify({
      ...base,
      files: {
        ...base.files,
        view: 'list',
        places,
        path: '/Users/tester',
        selection,
        listing: {
          status: 'ready',
          entries,
          parent: '/Users',
          writable: true,
          system: false,
          freeBytes: 400,
          totalBytes: 1000,
          truncated: false,
          total: entries.length,
          error: null,
        },
      },
    }))
    store.getSnapshot = () => next
    return expand(main.component({ store, t }))
  }
  const findButton = (nodes, label) => nodes.find((node) => node !== null && typeof node === 'object'
    && node.props !== null && typeof node.props === 'object'
    && typeof node.props.className === 'string'
    && node.props.className.indexOf('dshMacToolsButtonCompact') >= 0
    && node.children[0] === label)
  const hasClassContaining = (nodes, fragment) => nodes.some((node) => node !== null && typeof node === 'object'
    && node.props !== null && typeof node.props === 'object'
    && typeof node.props.className === 'string'
    && node.props.className.indexOf(fragment) >= 0)

  const idle = render([])
  assert.equal(hasClassContaining(idle, 'dshMacToolsFilesSelectionBar'), true, 'the action row is always rendered')
  assert.equal(hasClassContaining(idle, 'dshMacToolsFilesSelectionBarIdle'), true, 'it renders idle with no selection')
  assert.equal(idle.includes('files.status.none'), true)
  for (const label of ['files.action.open', 'files.action.copyPath', 'files.action.reveal', 'files.action.rename', 'files.action.compress', 'files.action.send', 'files.action.trash']) {
    const button = findButton(idle, label)
    assert.ok(button !== undefined, `${label} must stay visible when nothing is selected`)
    assert.equal(button.props.disabled, true, `${label} must be disabled without a selection`)
  }

  const armed = render(['/Users/tester/notes.md'])
  assert.equal(hasClassContaining(armed, 'dshMacToolsFilesSelectionBarIdle'), false)
  assert.equal(armed.includes('files.status.selected'), true)
  assert.equal(findButton(armed, 'files.action.open').props.disabled, false)
  assert.equal(findButton(armed, 'files.action.rename').props.disabled, false)
  assert.equal(findButton(armed, 'files.action.trash').props.disabled, false)
})
