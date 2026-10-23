/**
 * Row configuration for dsh-mac-tools.
 *
 * The harness validates a row's `config` against this schema before `apply`
 * runs, and hands `apply` the validated value with defaults filled in. Every
 * documented key therefore appears in the Config inspector, and a row that
 * leaves a key out keeps the default below.
 *
 * `@deepseek-ai/schemastery` ships with dsh; the package declares it as a peer
 * dependency and the launcher routes the name to the running installation, so
 * nothing is installed beside this plugin.
 *
 * @module dsh-mac-tools/config
 */

import Schema from '@deepseek-ai/schemastery'

import { DEFAULT_GLOBAL_ACCELERATOR } from './hotkey.js'

/** Defaults used when a row is applied without a validated config (tests, direct composition). */
export const CONFIG_DEFAULTS = Object.freeze({
  saveDirectory: '',
  maxShots: 20,
  interactiveTimeoutMs: 180_000,
  hideAppDuringCapture: true,
  globalHotkey: DEFAULT_GLOBAL_ACCELERATOR,
  globalHotkeySound: true,
  pinAfterGlobalCapture: true,
  historyLimit: 60,
  transferPort: 8791,
  transferDirectory: '',
  transferSessionMinutes: 30,
  transferMaxFileMB: 512,
  transferAutoCopyText: false,
})

/**
 * The composition entry schema for this plugin.
 */
export const Config = Schema.object({
  saveDirectory: Schema.string()
    .default('')
    .description(
      'Directory screenshots are saved to, with `~` expanded. Empty means `~/Pictures/DSH Mac Tools`. The panel save action and the global-hotkey capture both write here.',
    ),
  maxShots: Schema.number()
    .min(1)
    .max(200)
    .step(1)
    .default(20)
    .description('How many captures stay temporarily available in the panel before the oldest is pruned. Saved files are never pruned.'),
  interactiveTimeoutMs: Schema.number()
    .min(5000)
    .max(600000)
    .step(1)
    .default(180_000)
    .description('How long an interactive capture (native region/window selection) may wait for the operator before it is cancelled.'),
  hideAppDuringCapture: Schema.boolean()
    .default(true)
    .description(
      'Hide the DeepSeek Harness window while a screen capture runs (only when it is the frontmost app), so it does not cover the target. The panel has a per-capture toggle; this is its default.',
    ),
  globalHotkey: Schema.string()
    .default(DEFAULT_GLOBAL_ACCELERATOR)
    .description(
      'System-wide screenshot shortcut, usable while any application has focus, e.g. "ctrl+alt+a". Leave empty to disable. The result is copied to the clipboard and saved. Needs the Xcode Command Line Tools once for the native helper.',
    ),
  globalHotkeySound: Schema.boolean()
    .default(true)
    .description('Play the macOS Glass sound after a global-hotkey screenshot succeeds.'),
  pinAfterGlobalCapture: Schema.boolean()
    .default(true)
    .description('Also pin the global-hotkey screenshot to the screen as an always-on-top floating image (Esc closes it). Turn off to only copy and save.'),
  historyLimit: Schema.number()
    .min(1)
    .max(500)
    .step(1)
    .default(60)
    .description('How many screenshots the panel history keeps. Older captures are deleted beyond this limit.'),
  transferPort: Schema.number()
    .min(1024)
    .max(65535)
    .step(1)
    .default(8791)
    .description(
      'Preferred TCP port for the phone-transfer server the "Phone" panel tab starts on demand. If it is taken, the next 9 ports are tried. The server only listens while a transfer session is active.',
    ),
  transferDirectory: Schema.string()
    .default('')
    .description(
      'Directory phone uploads are saved to, with `~` expanded. Empty means `~/Downloads/DSH 手机互传`.',
    ),
  transferSessionMinutes: Schema.number()
    .min(1)
    .max(240)
    .step(1)
    .default(30)
    .description('How long one phone-transfer session stays open before it stops itself and the QR code expires.'),
  transferMaxFileMB: Schema.number()
    .min(1)
    .max(4096)
    .step(1)
    .default(512)
    .description('Largest single file a phone may upload, in megabytes. Larger uploads are refused and removed.'),
  transferAutoCopyText: Schema.boolean()
    .default(false)
    .description('Copy text received from the phone to the macOS clipboard automatically.'),
})

/**
 * Normalize a raw row config, from a validated Loader value or from tests.
 *
 * @param {unknown} rawConfig - row config, possibly absent or partial.
 * @returns {{ saveDirectory: string, maxShots: number, interactiveTimeoutMs: number, hideAppDuringCapture: boolean, globalHotkey: string, globalHotkeySound: boolean, pinAfterGlobalCapture: boolean, historyLimit: number }} effective values (the save directory still unexpanded).
 */
export function resolveConfig(rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? /** @type {Record<string, unknown>} */ (rawConfig) : {}
  const saveDirectory = typeof config.saveDirectory === 'string' && config.saveDirectory.trim() !== ''
    ? config.saveDirectory.trim()
    : CONFIG_DEFAULTS.saveDirectory
  const maxShots = Number.isInteger(config.maxShots) && /** @type {number} */ (config.maxShots) > 0
    ? /** @type {number} */ (config.maxShots)
    : CONFIG_DEFAULTS.maxShots
  const interactiveTimeoutMs = Number.isFinite(config.interactiveTimeoutMs) && /** @type {number} */ (config.interactiveTimeoutMs) >= 5000
    ? Math.round(/** @type {number} */ (config.interactiveTimeoutMs))
    : CONFIG_DEFAULTS.interactiveTimeoutMs
  const hideAppDuringCapture = typeof config.hideAppDuringCapture === 'boolean'
    ? config.hideAppDuringCapture
    : CONFIG_DEFAULTS.hideAppDuringCapture
  const globalHotkey = typeof config.globalHotkey === 'string'
    ? config.globalHotkey.trim()
    : CONFIG_DEFAULTS.globalHotkey
  const globalHotkeySound = typeof config.globalHotkeySound === 'boolean'
    ? config.globalHotkeySound
    : CONFIG_DEFAULTS.globalHotkeySound
  const pinAfterGlobalCapture = typeof config.pinAfterGlobalCapture === 'boolean'
    ? config.pinAfterGlobalCapture
    : CONFIG_DEFAULTS.pinAfterGlobalCapture
  const historyLimit = Number.isInteger(config.historyLimit) && /** @type {number} */ (config.historyLimit) > 0
    ? /** @type {number} */ (config.historyLimit)
    : CONFIG_DEFAULTS.historyLimit
  const transferPort = Number.isInteger(config.transferPort)
    && /** @type {number} */ (config.transferPort) >= 1024
    && /** @type {number} */ (config.transferPort) <= 65535
    ? /** @type {number} */ (config.transferPort)
    : CONFIG_DEFAULTS.transferPort
  const transferDirectory = typeof config.transferDirectory === 'string'
    ? config.transferDirectory.trim()
    : CONFIG_DEFAULTS.transferDirectory
  const transferSessionMinutes = Number.isFinite(config.transferSessionMinutes)
    && /** @type {number} */ (config.transferSessionMinutes) >= 1
    && /** @type {number} */ (config.transferSessionMinutes) <= 240
    ? Math.round(/** @type {number} */ (config.transferSessionMinutes))
    : CONFIG_DEFAULTS.transferSessionMinutes
  const transferMaxFileMB = Number.isFinite(config.transferMaxFileMB)
    && /** @type {number} */ (config.transferMaxFileMB) >= 1
    && /** @type {number} */ (config.transferMaxFileMB) <= 4096
    ? Math.round(/** @type {number} */ (config.transferMaxFileMB))
    : CONFIG_DEFAULTS.transferMaxFileMB
  const transferAutoCopyText = typeof config.transferAutoCopyText === 'boolean'
    ? config.transferAutoCopyText
    : CONFIG_DEFAULTS.transferAutoCopyText
  return {
    saveDirectory,
    maxShots,
    interactiveTimeoutMs,
    hideAppDuringCapture,
    globalHotkey,
    globalHotkeySound,
    pinAfterGlobalCapture,
    historyLimit,
    transferPort,
    transferDirectory,
    transferSessionMinutes,
    transferMaxFileMB,
    transferAutoCopyText,
  }
}
