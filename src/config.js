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
  return {
    saveDirectory,
    maxShots,
    interactiveTimeoutMs,
    hideAppDuringCapture,
    globalHotkey,
    globalHotkeySound,
    pinAfterGlobalCapture,
    historyLimit,
  }
}
