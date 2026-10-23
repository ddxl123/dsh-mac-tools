/**
 * dsh-mac-tools — Host half.
 *
 * One local macOS toolbox, in one plugin:
 *
 * - **Screenshot** (the main feature): native region/window capture through
 *   the system `screencapture` utility, an authenticated image route the Web
 *   panel loads the capture from, and the global-hotkey capture path.
 * - **Calculator**: one expression engine behind the panel's calculator tab.
 * - **Clipboard** and **system information**: panel endpoints.
 *
 * This project is panel-only: it registers no model-facing tools. The browser
 * half (`client/index.js`) is a plain-JavaScript bundle loaded by the web
 * module loader; this half owns the route it posts to, the temporary capture
 * registry and the global-hotkey helper. The row is host-plane: one instance
 * serves every browser window and every session.
 *
 * ## Failure posture
 *
 * Capture failures are recoverable and reported through the operation
 * envelope: a cancelled selection, a missing Screen Recording permission or a
 * disappeared window each carry a stable code the panel localizes. The one
 * thing that fails loudly is route registration — the route is the panel's only
 * data path, so a connection that refuses it must report as a failed row
 * instead of activating a panel that errors on every read.
 *
 * @module dsh-mac-tools
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as captureModule from './capture.js'
import { Config, resolveConfig } from './config.js'
import { HotkeyController } from './hotkey.js'
import { HistoryStore } from './history.js'
import { createOps, expandHome } from './ops.js'
import { PinManager } from './pin.js'
import { API_PATH, createRoute } from './route.js'
import { ShotStore } from './store.js'
import { TransferServer } from './transfer.js'
import { renderTransferPage } from './transfer-page.js'
import { generateQrPng } from './transfer-qr.js'
import { AppVisibility, resolveHostApp } from './visibility.js'

/** Stable Cordis plugin name; the bundle row's package is `dsh-mac-tools`. */
export const name = 'dsh-mac-tools'

/**
 * Directory for plugin-owned state (the user's custom shortcut).
 *
 * @param {any} ctx - plugin context.
 * @returns {string} absolute directory.
 */
function pluginStateDirectory(ctx) {
  const profileHome = ctx?.profileContext?.home
  if (typeof profileHome === 'string' && profileHome !== '') return join(profileHome, 'dsh-mac-tools')
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'dsh-mac-tools')
}

/** Row configuration schema, validated by the Loader before `apply`. */
export { Config }

/** Plugin version reported by the panel's status read. */
function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

/**
 * Mount the toolbox.
 *
 * @param {any} ctx - the Loader-provided plugin context.
 * @param {unknown} rawConfig - the validated composition entry.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const saveDirectory = expandHome(config.saveDirectory)
  const version = readVersion()

  /** Report a recoverable problem without turning it into a failed row. */
  const warn = (message, error) => {
    const detail = error === undefined
      ? ''
      : `: ${error instanceof Error ? error.message : String(error)}`
    try {
      ctx.logger?.warn?.(`[dsh-mac-tools] ${message}${detail}`)
    } catch {
      console.warn(`[dsh-mac-tools] ${message}${detail}`)
    }
  }

  try {
    mkdirSync(saveDirectory, { recursive: true })
  } catch (error) {
    warn(`could not create the screenshot directory ${saveDirectory}`, error)
  }

  let directory
  try {
    directory = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-'))
  } catch (error) {
    warn('could not create the temporary capture directory', error)
    directory = join(tmpdir(), `dsh-mac-tools-${process.pid}`)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const store = new ShotStore({ directory, maxShots: config.maxShots, warn })
  // The app this process belongs to, when it runs as the packaged desktop app.
  // A headless/CLI boot has no window to hide, so the capability simply stays
  // unsupported and the panel hides its toggle.
  const visibility = new AppVisibility({
    target: resolveHostApp({
      bundleId: process.env.__CFBundleIdentifier,
      execPath: process.execPath,
    }),
  })
  // The system-wide screenshot shortcut. The controller is created before the
  // dispatcher because `status` and the customization endpoints report it, while
  // its trigger needs the dispatcher — captured lazily through `ops`.
  /** @type {{ dispatch: Function, captureFromHotkey: Function, cancelCapture: Function, status: Function, dispose: Function } | null} */
  let ops = null
  const hotkey = process.platform === 'darwin'
    ? new HotkeyController({
      defaultAccelerator: config.globalHotkey,
      statePath: join(pluginStateDirectory(ctx), 'hotkey.json'),
      onTrigger: () => (ops === null ? undefined : ops.captureFromHotkey()),
      warn,
    })
    : null
  // Durable screenshot history, shared by panel captures and the shortcut.
  const history = new HistoryStore({
    directory: join(pluginStateDirectory(ctx), 'history'),
    maxItems: config.historyLimit,
    warn,
  })

  // Phone transfer is a temporary LAN listener the panel starts on demand. It
  // is macOS-only because the receive side uses the native notification,
  // clipboard and file-picker helpers this toolbox already owns.
  //
  // The service is built eagerly so the panel can show the persisted inbox as
  // soon as it opens, but its constructor touches the receiving directory and
  // the persisted index. A failure there (unwritable folder, corrupt state)
  // must cost only the transfer tab — never the whole panel, which is why the
  // construction below is contained instead of failing the plugin row.
  const transferDirectory = expandHome(
    config.transferDirectory !== '' ? config.transferDirectory : '~/Downloads/DSH 手机互传',
  )
  /** @type {TransferServer | null} */
  let transfer = null
  if (process.platform === 'darwin') {
    try {
      transfer = new TransferServer({
        directory: transferDirectory,
        stateDirectory: join(pluginStateDirectory(ctx), 'transfer'),
        port: config.transferPort,
        sessionMinutes: config.transferSessionMinutes,
        maxFileBytes: config.transferMaxFileMB * 1024 * 1024,
        autoCopyText: config.transferAutoCopyText,
        history,
        page: renderTransferPage,
        qr: (text) => generateQrPng(text),
        notify: (message) => captureModule.showNotification(message),
        copyText: (text) => captureModule.copyTextToClipboard(text),
        warn,
      })
    } catch (error) {
      warn('phone transfer is unavailable because its service could not be created', error)
      transfer = null
    }
  }

  // Pinned images need a native always-on-top window; macOS only. A pinned
  // window's "Edit" action raises the app and hands the image to the panel.
  const pins = process.platform === 'darwin'
    ? new PinManager({
      saveDirectory,
      warn,
      onEdit: (record) => {
        void visibility.activate()
        if (ops !== null) ops.addPinnedEditor(record)
      },
    })
    : null
  ops = createOps({
    config: { ...config, saveDirectory },
    store,
    capture: captureModule,
    visibility,
    warn,
    version,
    history,
    ...(hotkey === null ? {} : { hotkey }),
    ...(pins === null ? {} : { pins }),
    ...(transfer === null ? {} : { transfer }),
  })

  // The temporary capture directory belongs to the row: unloading or
  // replacing the row removes the captures with it. A saved file stays.
  ctx.effect(() => () => {
    ops.dispose()
  }, 'dsh-mac-tools: temporary captures')

  // An open phone-transfer session belongs to the row too: unloading closes
  // the LAN listener instead of leaving an unauthenticated port behind.
  if (transfer !== null) {
    ctx.effect(() => () => {
      transfer.dispose()
    }, 'dsh-mac-tools: phone transfer')
  }

  // Pinned windows and their edit socket belong to the row: unloading closes
  // every pin instead of leaving floating windows behind.
  if (pins !== null) {
    ctx.effect(() => () => {
      pins.dispose()
    }, 'dsh-mac-tools: pinned images')
  }

  // The browser half posts here. `connection.fetch` rather than
  // `connection.rpc.handle`, because a consumer plugin's service resolution
  // cannot reach `webServer` from inside the rpc mount; an exact Fetch route
  // adds itself to the `/api` channel Connection already mounted, and the
  // browser reaches it with an ordinary same-origin authenticated fetch.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register(createRoute({
        dispatch: ops.dispatch,
        readImage: (shotId) => store.read(shotId),
        readHistoryImage: (historyId) => history.read(historyId),
        ...(transfer === null ? {} : { readInboxFile: (inboxId) => transfer.readInboxFile(inboxId) }),
        warn,
      })),
      'dsh-mac-tools: api route',
    )
    connectionCtx.logger?.info?.(`Mac Tools endpoint published on ${API_PATH}`)
  })

  // Arm the global shortcut from the stored user choice (or the configured
  // default). The compiled helper listens for the key; this process owns the
  // socket it calls and the capture it triggers. Unloading disposes both.
  if (hotkey !== null) {
    ctx.effect(() => () => {
      hotkey.dispose()
    }, 'dsh-mac-tools: global hotkey')
    void hotkey.start().then((state) => {
      if (state.active) {
        ctx.logger?.info?.(`Global screenshot hotkey armed: ${state.label} (${state.accelerator}, ${state.source})`)
      } else {
        ctx.logger?.warn?.(`Global screenshot hotkey unavailable: ${state.reason}`)
      }
    }).catch((error) => {
      warn('the global screenshot hotkey failed to start', error)
    })
  }

  ctx.logger?.info?.(
    `Mac Tools ${version} active: captures in ${store.directory}, saves in ${saveDirectory}`
    + `, history ${history.indexPath}`
    + (transfer === null ? '' : `, phone transfer inbox ${transferDirectory}`)
    + (visibility.supported ? `, hide-app ${visibility.appName ?? 'unknown'}` : ', hide-app unsupported'),
  )
}
