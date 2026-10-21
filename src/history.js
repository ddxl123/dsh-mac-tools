/**
 * Durable screenshot history for the panel.
 *
 * Every capture — panel or global shortcut — is copied here, next to a small
 * JSON index, so the panel can show a gallery that survives restarts and
 * re-open any shot in the editor or pin it again. The temporary capture
 * registry is still used for the shot currently being edited; history is the
 * durable catalog.
 *
 * Storage lives in the plugin's state directory (`<state>/history`): one PNG
 * per entry plus `index.json`, both private (0600/0700). The oldest entries are
 * pruned beyond the configured limit.
 *
 * @module dsh-mac-tools/history
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Index file name inside the history directory. */
export const HISTORY_INDEX_FILE = 'index.json'

/** Default number of captures kept. */
export const DEFAULT_HISTORY_LIMIT = 60

/**
 * A durable screenshot history.
 */
export class HistoryStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.directory - directory that holds the PNGs and index.
   * @param {number} [options.maxItems] - entries kept before pruning the oldest.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   */
  constructor({ directory, maxItems = DEFAULT_HISTORY_LIMIT, warn = () => {} }) {
    this.directory = directory
    this.maxItems = Number.isInteger(maxItems) && maxItems > 0 ? maxItems : DEFAULT_HISTORY_LIMIT
    this.warn = warn
    /** @type {Array<object>} newest first. */
    this.entries = []
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.load()
  }

  /** @returns {string} index path. */
  get indexPath() {
    return join(this.directory, HISTORY_INDEX_FILE)
  }

  /** Read the persisted index, dropping entries whose file disappeared. */
  load() {
    let document
    try {
      document = JSON.parse(readFileSync(this.indexPath, 'utf8'))
    } catch {
      this.entries = []
      return
    }
    const entries = Array.isArray(document) ? document : (document !== null && typeof document === 'object' && Array.isArray(document.entries) ? document.entries : [])
    this.entries = entries.filter((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.file !== 'string') return false
      return existsSync(join(this.directory, entry.file))
    })
    this.prune()
  }

  /** Persist the index atomically. */
  save() {
    const temporary = `${this.indexPath}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: this.entries }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.indexPath)
  }

  /**
   * Store one capture.
   *
   * @param {{ buffer: Buffer, width: number, height: number, bytes?: number, at?: string, mode?: string, window?: object, rect?: object }} capture - capture bytes and metadata.
   * @returns {object} the public history entry.
   * @throws {Error} when the PNG cannot be written.
   */
  add(capture) {
    if (!Buffer.isBuffer(capture.buffer) || capture.buffer.byteLength === 0) throw new Error('the capture has no bytes')
    const id = `h${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    const file = `${id}.png`
    writeFileSync(join(this.directory, file), capture.buffer, { mode: 0o600 })
    const entry = {
      id,
      file,
      width: Math.max(0, Math.round(Number(capture.width) || 0)),
      height: Math.max(0, Math.round(Number(capture.height) || 0)),
      bytes: Math.max(0, Math.round(Number(capture.bytes) || capture.buffer.byteLength)),
      at: typeof capture.at === 'string' && capture.at !== '' ? capture.at : new Date().toISOString(),
      mode: typeof capture.mode === 'string' ? capture.mode : 'unknown',
      ...(capture.window === undefined ? {} : { window: capture.window }),
      ...(capture.rect === undefined ? {} : { rect: capture.rect }),
    }
    this.entries.unshift(entry)
    this.prune()
    this.save()
    return this.publicEntry(entry)
  }

  /** Delete entries beyond the limit, oldest first. */
  prune() {
    while (this.entries.length > this.maxItems) {
      const dropped = this.entries.pop()
      if (dropped === undefined) return
      this.removeFile(dropped)
    }
  }

  /**
   * @param {object} entry - stored entry.
   * @returns {void}
   */
  removeFile(entry) {
    if (typeof entry.file !== 'string') return
    try {
      rmSync(join(this.directory, entry.file), { force: true })
    } catch (error) {
      this.warn(`could not delete the pruned history capture ${entry.file}`, error)
    }
  }

  /**
   * @param {object} entry - stored entry.
   * @returns {object} the caller-facing metadata (no internal file name).
   */
  publicEntry(entry) {
    return {
      id: entry.id,
      width: entry.width,
      height: entry.height,
      bytes: entry.bytes,
      at: entry.at,
      mode: entry.mode,
      ...(entry.window === undefined ? {} : { window: entry.window }),
      ...(entry.rect === undefined ? {} : { rect: entry.rect }),
    }
  }

  /** @returns {object[]} newest-first public entries. */
  list() {
    return this.entries.map((entry) => this.publicEntry(entry))
  }

  /**
   * @param {string} id - entry id.
   * @returns {object | undefined} the stored entry.
   */
  get(id) {
    return this.entries.find((entry) => entry.id === id)
  }

  /**
   * @param {string} id - entry id.
   * @returns {Buffer} the stored PNG bytes.
   * @throws {Error} when the entry is unknown or its file vanished.
   */
  read(id) {
    const entry = this.get(id)
    if (entry === undefined) throw new Error(`unknown history capture ${JSON.stringify(id)}`)
    return readFileSync(join(this.directory, entry.file))
  }

  /**
   * @param {string} id - entry id.
   * @returns {boolean} whether an entry was removed.
   */
  remove(id) {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    const [entry] = this.entries.splice(index, 1)
    this.removeFile(entry)
    this.save()
    return true
  }

  /** Remove every entry and file. */
  clear() {
    for (const entry of this.entries) this.removeFile(entry)
    this.entries = []
    try {
      this.save()
    } catch {
      // The next write will recreate the index.
    }
  }

  /** @returns {number} total bytes of the stored PNGs. */
  sizeBytes() {
    let total = 0
    for (const entry of this.entries) {
      try {
        total += statSync(join(this.directory, entry.file)).size
      } catch {
        // Ignore a file that disappeared.
      }
    }
    return total
  }
}
