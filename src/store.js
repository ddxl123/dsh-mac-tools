/**
 * The temporary registry of captured screenshots.
 *
 * The panel shows a capture by pointing an `<img>` at the authenticated route
 * with the shot id; the registry is what makes that id resolvable. Files live
 * in one process-owned temporary directory and are removed when the row is
 * unloaded, so a capture that is never saved leaves nothing behind.
 *
 * A saved file is a different object: it goes to the configured save directory
 * and is never pruned. The registry exists for the transient editor session.
 *
 * @module dsh-mac-tools/store
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Largest capture file the registry accepts, in bytes (the attachment limit is 20 MiB). */
export const MAX_SHOT_BYTES = 20 * 1024 * 1024

/**
 * One registry entry.
 * @typedef {object} ShotRecord
 * @property {string} id - stable short id used in the image URL.
 * @property {string} path - absolute PNG path.
 * @property {number} width - pixel width.
 * @property {number} height - pixel height.
 * @property {number} bytes - file size.
 * @property {string} at - ISO timestamp.
 * @property {string} mode - capture mode that produced it.
 * @property {{ id: number, app: string, title: string } | undefined} [window] - window metadata for window captures.
 * @property {{ x: number, y: number, w: number, h: number } | undefined} [rect] - screen rectangle the capture came from, used to pin it back in place.
 */

/** A short, URL-safe identifier for one capture. */
function newShotId() {
  return `s${randomBytes(8).toString('hex')}`
}

/**
 * Own the temporary capture directory and its ordered registry.
 */
export class ShotStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.directory - temporary directory owned by this store.
   * @param {number} [options.maxShots] - entries retained before the oldest is pruned.
   * @param {(message: string) => void} [options.warn] - warning sink.
   */
  constructor({ directory, maxShots = 20, warn = () => {} }) {
    /** @type {string} */
    this.directory = directory
    /** @type {number} */
    this.maxShots = Number.isInteger(maxShots) && maxShots > 0 ? maxShots : 20
    /** @type {(message: string) => void} */
    this.warn = warn
    /** @type {ShotRecord[]} oldest first. */
    this.shots = []
    /** @type {Set<string>} */
    this.edited = new Set()
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  /** @returns {string} a fresh, unique PNG path inside the store directory. */
  createPath() {
    return join(this.directory, `capture-${newShotId()}-${Date.now()}.png`)
  }

  /**
   * Register one capture that was just written to its path.
   *
   * @param {{ path: string, width: number, height: number, bytes: number, at: string, mode: string, window?: object, rect?: object }} capture - capture outcome.
   * @returns {ShotRecord} the registered record.
   * @throws {Error} when the file is missing or larger than the retention cap.
   */
  add(capture) {
    const info = statSync(capture.path)
    if (!info.isFile() || info.size === 0) throw new Error('the capture file is missing')
    if (info.size > MAX_SHOT_BYTES) throw new Error(`the capture is larger than ${MAX_SHOT_BYTES} bytes`)
    const record = {
      id: newShotId(),
      path: capture.path,
      width: capture.width,
      height: capture.height,
      bytes: info.size,
      at: typeof capture.at === 'string' ? capture.at : new Date().toISOString(),
      mode: typeof capture.mode === 'string' ? capture.mode : 'unknown',
      ...(capture.window === undefined ? {} : { window: capture.window }),
      ...(capture.rect === undefined ? {} : { rect: capture.rect }),
    }
    this.shots.push(record)
    this.prune()
    return record
  }

  /**
   * Write bytes that did not come from the capture utility (an edited or
   * re-encoded PNG from the panel) into the temporary directory.
   *
   * @param {Buffer} buffer - PNG bytes.
   * @returns {string} the written path.
   */
  writeTemporary(buffer) {
    const path = join(this.directory, `edited-${newShotId()}-${Date.now()}.png`)
    writeFileSync(path, buffer, { mode: 0o600 })
    this.edited.add(path)
    return path
  }

  /**
   * @param {string} id - shot id.
   * @returns {ShotRecord | undefined} the record.
   */
  get(id) {
    return this.shots.find((shot) => shot.id === id)
  }

  /** @returns {ShotRecord | undefined} the newest capture. */
  latest() {
    return this.shots[this.shots.length - 1]
  }

  /**
   * @param {string} id - shot id.
   * @returns {Buffer} the PNG bytes.
   * @throws {Error} when the id is unknown or its file disappeared.
   */
  read(id) {
    const record = this.get(id)
    if (record === undefined) throw new Error(`unknown screenshot ${JSON.stringify(id)}`)
    return readFileSync(record.path)
  }

  /** Drop the oldest entries until the retention cap holds. */
  prune() {
    while (this.shots.length > this.maxShots) {
      const dropped = this.shots.shift()
      if (dropped === undefined) return
      try {
        unlinkSync(dropped.path)
      } catch (error) {
        this.warn(`could not delete the pruned capture ${dropped.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Remove the whole temporary directory, including edited copies. */
  dispose() {
    this.shots = []
    this.edited.clear()
    try {
      rmSync(this.directory, { recursive: true, force: true })
    } catch (error) {
      this.warn(`could not delete the temporary capture directory ${this.directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
