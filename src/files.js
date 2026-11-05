/**
 * The host half of the Files (访达-style) tab.
 *
 * A local file browser for the panel: it lists directories with Finder-ish
 * sorting, previews text and the safe raster image formats, and performs the
 * write operations an operator expects — new folder, rename, move to Trash,
 * compress, drop files coming from the browser, reveal in Finder and open with
 * the default application.
 *
 * Read and write access are deliberately asymmetrical. Browsing defaults to the
 * whole disk (`readRoots: ['/']`), because the operator already has those
 * privileges; every mutation must stay under `writeRoots` (the home directory
 * and `/Volumes` by default). Write targets are checked through the realpath of
 * their *parent*, so a symlinked directory cannot be used to escape the allowed
 * roots, and read paths reject NUL bytes before anything touches the
 * filesystem.
 *
 * Nothing here spawns a shell: the short list of macOS helpers (`ditto`,
 * `open`, `qlmanage`) runs through the injected `run` process runner, which is
 * also what makes the module testable without macOS.
 *
 * Small durable state lives in the plugin state directory: `recent.json` keeps
 * the last visited directories and `thumbs/` caches Quick Look thumbnails.
 *
 * @module dsh-mac-tools/files
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

import { runProcess } from './capture.js'

/** Recents file inside the state directory. */
const RECENT_FILE = 'recent.json'

/** How many recently visited directories the sidebar keeps. */
const RECENT_LIMIT = 12

/** Maximum number of entries one listing returns before it is truncated. */
const LIST_ENTRY_LIMIT = 5000

/** Maximum byte count `readText()` will decode when the caller does not say. */
const DEFAULT_PREVIEW_MAX_BYTES = 262_144

/** Upper bound `readText()` accepts from the caller as `maxBytes`. */
const PREVIEW_ABSOLUTE_MAX_BYTES = 1_048_576

/** Bytes inspected for a NUL byte when deciding that a file is binary. */
const BINARY_SNIFF_BYTES = 8 * 1024

/** Largest image file `previewFile()` loads into memory. */
const IMAGE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024

/** Largest single upload accepted by `drop()`. */
const DROP_FILE_LIMIT_BYTES = 128 * 1024 * 1024

/** Largest total upload accepted by one `drop()` call. */
const DROP_TOTAL_LIMIT_BYTES = 256 * 1024 * 1024

/** Default thumbnail edge length in pixels. */
const DEFAULT_THUMBNAIL_SIZE = 512

/** Smallest thumbnail edge length `thumbnail()` accepts. */
const MIN_THUMBNAIL_SIZE = 64

/** Largest thumbnail edge length `thumbnail()` accepts. */
const MAX_THUMBNAIL_SIZE = 1024

/** Deadline for one `ditto` compression run (10 minutes). */
const COMPRESS_TIMEOUT_MS = 600_000

/** Deadline for one `open`/`qlmanage` helper run. */
const HELPER_TIMEOUT_MS = 30_000

/** Maximum length of one file name, matching the usual HFS+/APFS limit. */
const MAX_NAME_LENGTH = 255

/** Directory every mounted volume appears in (macOS). */
const VOLUMES_DIRECTORY = '/Volumes'

/** Display name of the root volume when it cannot be discovered from /Volumes. */
const ROOT_VOLUME_NAME = 'Macintosh HD'

/** `/Applications`, the standard Applications place. */
const APPLICATIONS_DIRECTORY = '/Applications'

/** Top-level locations that make the client warn more quietly about writes. */
const SYSTEM_LOCATIONS = Object.freeze(['/System', '/Library', '/Applications', '/usr'])

/** The macOS helper executables, always invoked by absolute path. */
const DITTO = '/usr/bin/ditto'
const OPEN = '/usr/bin/open'
const QLMANAGE = '/usr/bin/qlmanage'

/** Raster formats the preview pane may inline, with their MIME types. */
const PREVIEW_MIME_BY_EXTENSION = Object.freeze({
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
})

/** Sort keys `list()` understands. */
const SORT_KEYS = Object.freeze(['name', 'size', 'mtime', 'kind'])

/** Control characters stripped from an uploaded file name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu

/** Characters removed from an uploaded file name; separators are split on. */
const FORBIDDEN_FILE_CHARACTERS = /[*?"<>|:]/gu

/**
 * A refused Files operation, carrying the stable code the panel localizes.
 */
export class FilesError extends Error {
  /**
   * @param {string} code - stable failure code, e.g. `files_outside_roots`.
   * @param {string} message - operator-facing description.
   * @param {object} [details] - extra structured context; `details.path` is set whenever a path is known.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FilesError'
    this.code = code
    this.details = details
  }
}

/**
 * One sidebar destination.
 *
 * @typedef {object} Place
 * @property {'home' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'movies' | 'music' | 'applications' | 'custom' | 'recent'} id - stable identifier the client localizes.
 * @property {string} name - English fallback name (or the directory's basename for custom favorites).
 * @property {string} path - absolute directory path.
 */

/**
 * One mounted volume shown in the sidebar.
 *
 * @typedef {object} Volume
 * @property {string} name - display name, e.g. `Macintosh HD`.
 * @property {string} path - mount point.
 * @property {number} totalBytes - capacity in bytes.
 * @property {number} freeBytes - bytes available to this user.
 * @property {boolean} isRoot - whether this is the root volume (`/`).
 */

/**
 * One recently visited directory.
 *
 * @typedef {object} Recent
 * @property {string} name - directory name (`/` for the root).
 * @property {string} path - absolute directory path.
 * @property {string} at - ISO timestamp of the visit.
 */

/**
 * One entry of a directory listing.
 *
 * @typedef {object} FileEntry
 * @property {string} name - base name.
 * @property {string} path - absolute path.
 * @property {'directory' | 'file' | 'symlink' | 'other'} kind - what the entry is, from `lstat`.
 * @property {number} size - bytes; 0 for directories.
 * @property {string} mtime - ISO modification time.
 * @property {string} ext - lowercase extension without the dot (`''` when none).
 * @property {boolean} hidden - whether the name starts with a dot.
 * @property {string} [linkTarget] - resolved target of a symbolic link.
 * @property {boolean} [directory] - `true` when a symbolic link points at a directory.
 * @property {{ code: string, message: string }} [error] - present only when `lstat` failed for this entry.
 */

/**
 * The outcome of one directory listing.
 *
 * @typedef {object} ListResult
 * @property {string} path - the listed directory.
 * @property {string} name - its base name (`/` for the root).
 * @property {string | null} parent - the parent directory, `null` for `/`.
 * @property {boolean} writable - whether the directory is inside `writeRoots`.
 * @property {boolean} system - whether the directory is a system location.
 * @property {number} freeBytes - free space on the directory's volume.
 * @property {number} totalBytes - capacity of the directory's volume.
 * @property {FileEntry[]} entries - visible entries, directories first.
 * @property {number} total - entries before the 5000-entry cap.
 * @property {boolean} truncated - whether `entries` was capped.
 */

/**
 * @param {unknown} failure - a thrown value.
 * @returns {string} its message.
 */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * @param {unknown} failure - a thrown value.
 * @returns {string} the most useful diagnostic detail (process stderr when present).
 */
function failureDetail(failure) {
  if (failure !== null && typeof failure === 'object') {
    const details = failure.details
    if (details !== null && typeof details === 'object') {
      const stderr = typeof details.stderr === 'string' ? details.stderr.trim() : ''
      if (stderr !== '') return stderr
    }
  }
  return failureMessage(failure)
}

/**
 * @param {unknown} failure - a thrown value.
 * @returns {string} a native errno such as `ENOENT`, or `''`.
 */
function nativeCode(failure) {
  return failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : ''
}

/**
 * Expand a leading `~` and resolve a path against the process directory.
 *
 * @param {string} input - a non-empty path, possibly starting with `~`.
 * @returns {string} the absolute path.
 */
function resolvePath(input) {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolve(join(homedir(), input.slice(2)))
  return resolve(input)
}

/**
 * @param {string} path - a path.
 * @returns {string} its realpath when it exists, the path otherwise.
 */
function realRoot(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether `candidate` is `root` or below it, comparing whole path segments.
 *
 * @param {string} candidate - absolute path.
 * @param {string} root - absolute root path.
 * @returns {boolean} true when contained.
 */
function isInside(candidate, root) {
  if (root === sep) return candidate.startsWith(sep)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(prefix)
}

/**
 * @param {string} path - absolute path.
 * @param {string[]} roots - allowed roots.
 * @returns {boolean} whether the path is inside any root.
 */
function insideAny(path, roots) {
  return roots.some((root) => isInside(path, root))
}

/**
 * Normalize configured root lists: expand `~`, resolve, and prefer the realpath
 * so comparisons against `realpath()` results are stable (macOS `/var` is a
 * symlink to `/private/var`).
 *
 * @param {unknown} value - the configured value.
 * @param {string[]} fallback - defaults, already absolute.
 * @param {(message: string) => void} [warn] - diagnostic sink for ignored entries.
 * @param {string} [field] - name used in warnings.
 * @returns {string[]} the normalized, de-duplicated roots.
 */
function normalizeRoots(value, fallback, warn = () => {}, field = 'roots') {
  const roots = []
  const inputs = Array.isArray(value) ? value : []
  for (const input of inputs) {
    if (typeof input !== 'string' || input.trim() === '' || input.includes('\u0000')) {
      warn(`${field} entry ${JSON.stringify(input)} is not a usable path`)
      continue
    }
    const root = realRoot(resolvePath(input.trim()))
    if (!roots.includes(root)) roots.push(root)
  }
  if (roots.length === 0) {
    for (const root of fallback) {
      if (!roots.includes(root)) roots.push(root)
    }
  }
  return roots
}

/**
 * @param {string} path - any path.
 * @returns {boolean} whether it exists and is a directory.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string} path - any path.
 * @returns {boolean} whether anything (including a dangling symlink) is there.
 */
function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the capacity and free space of the volume holding a path.
 *
 * @param {string} path - a path on the volume.
 * @returns {{ totalBytes: number, freeBytes: number }} the sizes.
 * @throws {Error} when `statfs` fails (e.g. the path disappeared).
 */
function volumeSizes(path) {
  const stats = statfsSync(path)
  const blockSize = Number(stats.bsize) || 0
  const totalBytes = blockSize * (Number(stats.blocks) || 0)
  const freeBytes = blockSize * (Number(stats.bavail) || 0)
  return { totalBytes, freeBytes }
}

/**
 * Discover the mounted volumes: the root volume plus the entries of
 * `/Volumes` that resolve to a directory. A single unreadable volume is
 * skipped instead of failing the whole sidebar.
 *
 * @param {(message: string) => void} [warn] - diagnostic sink.
 * @returns {Volume[]} the root volume first, then the others by name.
 */
function discoverVolumes(warn = () => {}) {
  const volumes = []
  const seen = new Set()
  /**
   * @param {string} name - display name.
   * @param {string} path - mount point shown to the caller.
   * @param {string} real - resolved mount point used for de-duplication.
   * @param {boolean} isRoot - whether this is the root volume.
   * @returns {void}
   */
  const add = (name, path, real, isRoot) => {
    if (seen.has(real)) return
    let sizes
    try {
      sizes = volumeSizes(real)
    } catch (failure) {
      warn(`could not read the volume ${JSON.stringify(path)}: ${failureMessage(failure)}`)
      return
    }
    seen.add(real)
    volumes.push({ name, path, totalBytes: sizes.totalBytes, freeBytes: sizes.freeBytes, isRoot })
  }
  let entries = []
  try {
    entries = readdirSync(VOLUMES_DIRECTORY).sort()
  } catch {
    // A Linux host (or a restricted process) has no /Volumes; the root volume
    // below is still reported.
  }
  for (const entry of entries) {
    let real
    let info
    try {
      real = realpathSync(join(VOLUMES_DIRECTORY, entry))
      info = statSync(real)
    } catch (failure) {
      warn(`could not inspect the volume ${JSON.stringify(entry)}: ${failureMessage(failure)}`)
      continue
    }
    if (!info.isDirectory()) continue
    if (real === sep) add(entry, sep, real, true)
    else add(entry, real, real, false)
  }
  if (!seen.has(sep)) {
    try {
      const sizes = volumeSizes(sep)
      volumes.push({ name: ROOT_VOLUME_NAME, path: sep, totalBytes: sizes.totalBytes, freeBytes: sizes.freeBytes, isRoot: true })
    } catch (failure) {
      warn(`could not read the root volume: ${failureMessage(failure)}`)
    }
  }
  volumes.sort((left, right) => {
    if (left.isRoot !== right.isRoot) return left.isRoot ? -1 : 1
    return left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' })
  })
  return volumes
}

/**
 * Finder-ish name comparison: natural number order, case-insensitive, with a
 * deterministic tie-break so equal-looking names keep a stable order.
 *
 * @param {string} left - first name.
 * @param {string} right - second name.
 * @returns {number} negative, zero or positive.
 */
function compareNames(left, right) {
  const result = left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
  if (result !== 0) return result
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * @param {string} path - any path.
 * @returns {boolean} whether it is one of the system locations.
 */
function isSystemLocation(path) {
  if (path === sep) return true
  return SYSTEM_LOCATIONS.some((root) => isInside(path, root))
}

/**
 * @param {string} text - decoded text.
 * @returns {number} the number of lines, ignoring the empty tail of a trailing newline.
 */
function countLines(text) {
  if (text === '') return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Clamp a caller-supplied `maxBytes` into the accepted range.
 *
 * @param {unknown} value - requested limit.
 * @param {number} fallback - default limit.
 * @returns {number} a byte count between 1 and {@link PREVIEW_ABSOLUTE_MAX_BYTES}.
 */
function clampedByteLimit(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(PREVIEW_ABSOLUTE_MAX_BYTES, Math.max(1, Math.trunc(number)))
}

/**
 * Clamp a caller-supplied thumbnail edge length.
 *
 * @param {unknown} value - requested size.
 * @returns {number} a size between {@link MIN_THUMBNAIL_SIZE} and {@link MAX_THUMBNAIL_SIZE}.
 */
function clampedThumbnailSize(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_THUMBNAIL_SIZE
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_THUMBNAIL_SIZE
  return Math.min(MAX_THUMBNAIL_SIZE, Math.max(MIN_THUMBNAIL_SIZE, Math.round(number)))
}

/**
 * @param {unknown} value - configured byte limit.
 * @param {number} fallback - default.
 * @returns {number} a positive integer byte count.
 */
function positiveLimit(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

/**
 * Read at most `maxBytes` bytes from the start of a file.
 *
 * @param {string} path - file path.
 * @param {number} maxBytes - maximum bytes to read.
 * @returns {Buffer} the bytes read.
 * @throws {Error} when the file cannot be opened or read.
 */
function readPrefix(path, maxBytes) {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    let offset = 0
    while (offset < maxBytes) {
      const read = readSync(descriptor, buffer, offset, maxBytes - offset, offset)
      if (read <= 0) break
      offset += read
    }
    return buffer.subarray(0, offset)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Pick a name that is not yet used inside a directory.
 *
 * @param {string} directory - existing destination directory.
 * @param {string} name - preferred base name.
 * @returns {string} `name`, or Finder-style `name 2.ext`, `name 3.ext`, …
 */
function uniqueDestination(directory, name) {
  if (!pathExists(join(directory, name))) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} ${index}${extension}`
    if (!pathExists(join(directory, candidate))) return candidate
  }
  return `${stem} ${Date.now()}${extension}`
}

/**
 * Shorten a file name while keeping its extension.
 *
 * @param {string} name - candidate name.
 * @param {number} maxLength - maximum character count.
 * @returns {string} the shortened name.
 */
function truncateName(name, maxLength) {
  if (name.length <= maxLength) return name
  const extension = extname(name)
  if (extension.length >= maxLength) return name.slice(0, maxLength)
  return `${name.slice(0, maxLength - extension.length)}${extension}`
}

/**
 * Validate a name typed by the operator for a new folder or a rename.
 *
 * @param {unknown} input - requested name.
 * @param {string} [directory] - parent directory, used for `details.path`.
 * @returns {string} the trimmed name.
 * @throws {FilesError} `files_invalid_name` when the name is unusable.
 */
function validatedEntryName(input, directory) {
  const details = directory === undefined ? { name: typeof input === 'string' ? input : '' } : { name: typeof input === 'string' ? input : '', path: directory }
  if (typeof input !== 'string') throw new FilesError('files_invalid_name', 'the name must be a string', details)
  if (input.includes('\u0000')) throw new FilesError('files_invalid_name', 'the name must not contain a NUL byte', details)
  const name = input.trim()
  if (name === '') throw new FilesError('files_invalid_name', 'the name must not be empty', details)
  if (name.length > MAX_NAME_LENGTH) throw new FilesError('files_invalid_name', `the name must be at most ${MAX_NAME_LENGTH} characters`, details)
  if (name === '.' || name === '..') throw new FilesError('files_invalid_name', 'the name must not be "." or ".."', details)
  if (name.includes('/') || name.includes('\\')) throw new FilesError('files_invalid_name', 'the name must not contain a path separator', details)
  return name
}

/**
 * Reduce an upload name to a single safe path segment.
 *
 * Separators are split on (so `../evil.txt` becomes `evil.txt`), control and
 * reserved characters are removed, and the result is trimmed and length-capped
 * while keeping its extension.
 *
 * @param {unknown} input - the name sent by the browser.
 * @returns {string} the safe name.
 * @throws {FilesError} `files_invalid_name` when nothing usable remains.
 */
function sanitizedUploadName(input) {
  const raw = typeof input === 'string' ? input : ''
  const segments = raw.split(/[/\\]/u)
  let name = (segments[segments.length - 1] ?? '').replace(CONTROL_CHARACTERS, '').replace(FORBIDDEN_FILE_CHARACTERS, '').trim()
  if (name === '' || name === '.' || name === '..') {
    throw new FilesError('files_invalid_name', 'the upload has no usable file name', { name: raw })
  }
  name = truncateName(name, MAX_NAME_LENGTH)
  return name
}

/**
 * Decode one upload payload: a raw base64 string or a `data:` URL.
 *
 * The decoded size is estimated before allocation so an oversized upload is
 * refused without building the buffer first.
 *
 * @param {unknown} input - the payload.
 * @param {number} maxBytes - largest accepted decoded size.
 * @returns {Buffer} the decoded bytes.
 * @throws {FilesError} `files_invalid_request`, `files_too_large`.
 */
function decodeUpload(input, maxBytes) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new FilesError('files_invalid_request', 'the upload has no data', { field: 'dataBase64' })
  }
  let text = input.trim()
  if (text.startsWith('data:')) {
    const comma = text.indexOf(',')
    if (comma === -1) throw new FilesError('files_invalid_request', 'the data URL has no payload', { field: 'dataBase64' })
    text = text.slice(comma + 1)
  }
  text = text.replace(/\s+/gu, '')
  if (text === '') throw new FilesError('files_invalid_request', 'the upload has no data', { field: 'dataBase64' })
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) throw new FilesError('files_invalid_request', 'the upload is not base64', { field: 'dataBase64' })
  const remainder = text.length % 4
  if (remainder === 1) throw new FilesError('files_invalid_request', 'the upload is not base64', { field: 'dataBase64' })
  const estimated = Math.floor((text.length * 3) / 4)
  if (estimated > maxBytes) throw new FilesError('files_too_large', `the upload is larger than ${maxBytes} bytes`, { bytes: estimated, limit: maxBytes })
  const buffer = Buffer.from(remainder === 0 ? text : `${text}${'='.repeat(4 - remainder)}`, 'base64')
  if (buffer.byteLength > maxBytes) throw new FilesError('files_too_large', `the upload is larger than ${maxBytes} bytes`, { bytes: buffer.byteLength, limit: maxBytes })
  return buffer
}

/**
 * Write one upload into a directory without partially replacing anything: the
 * bytes go to a temporary name first and are renamed into their final unique
 * name afterwards.
 *
 * @param {string} directory - existing destination directory.
 * @param {string} name - sanitized name.
 * @param {Buffer} buffer - decoded bytes.
 * @returns {string} the written path.
 * @throws {Error} when the file cannot be written.
 */
function writeUpload(directory, name, buffer) {
  const temporary = join(directory, `.dsh-files-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(temporary, buffer, { mode: 0o644 })
  try {
    const destination = join(directory, uniqueDestination(directory, name))
    renameSync(temporary, destination)
    return destination
  } catch (failure) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The temporary file is harmless; report the write failure below.
    }
    throw failure
  }
}

/**
 * Locate the PNG `qlmanage` produced inside its output directory.
 *
 * @param {string} directory - the `-o` directory.
 * @param {string} sourcePath - the file a thumbnail was requested for.
 * @returns {string | undefined} the produced file, when one is non-empty.
 */
function producedThumbnail(directory, sourcePath) {
  const expected = join(directory, `${basename(sourcePath)}.png`)
  /** @type {string[]} */
  let names = []
  try {
    names = readdirSync(directory).sort()
  } catch {
    return undefined
  }
  const candidates = [expected, ...names.map((name) => join(directory, name))]
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate)
      if (info.isFile() && info.size > 0) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * Move a finished thumbnail into the cache, falling back to a copy when the
 * temporary directory and the state directory live on different volumes.
 *
 * @param {string} source - produced PNG.
 * @param {string} destination - cache path.
 * @returns {void}
 * @throws {Error} when the file cannot be placed.
 */
function placeThumbnail(source, destination) {
  try {
    renameSync(source, destination)
    return
  } catch (failure) {
    if (nativeCode(failure) !== 'EXDEV') throw failure
  }
  const temporary = `${destination}.tmp-${process.pid}`
  copyFileSync(source, temporary)
  renameSync(temporary, destination)
  try {
    rmSync(source, { force: true })
  } catch {
    // The temporary directory is removed by the caller anyway.
  }
}

/**
 * A local file browser for the panel.
 *
 * Read operations accept everything under `readRoots`; write operations are
 * confined to `writeRoots` and are re-checked through the parent's realpath.
 */
export class FileBrowser {
  /**
   * @param {object} options - browser options.
   * @param {string} options.stateDirectory - plugin state directory for this feature; created with mode 0700. Holds `recent.json` and `thumbs/`.
   * @param {string[]} [options.favorites] - extra sidebar paths, `~` allowed.
   * @param {string} [options.startDirectory] - directory the panel opens at; `''` means the home directory, `~` allowed.
   * @param {boolean} [options.showHidden] - default hidden-file policy.
   * @param {number} [options.previewMaxBytes] - default text-preview byte budget.
   * @param {string[]} [options.readRoots] - roots browsing may enter; default `['/']`.
   * @param {string[]} [options.writeRoots] - roots mutations may touch; default the home directory and `/Volumes`.
   * @param {string} [options.trashDirectory] - Trash directory; default `~/.Trash`. Created on demand, never in the constructor.
   * @param {(command: string, args: string[], options?: object) => Promise<object>} [options.run] - process runner, defaults to the capture runner.
   * @param {(message: string, error?: unknown) => void} [options.warn] - non-fatal warning sink.
   * @param {number} [options.maxDropFileBytes] - largest single upload; default 128 MiB.
   * @param {number} [options.maxDropTotalBytes] - largest upload batch; default 256 MiB.
   */
  constructor({
    stateDirectory,
    favorites = [],
    startDirectory = '',
    showHidden = false,
    previewMaxBytes = DEFAULT_PREVIEW_MAX_BYTES,
    readRoots,
    writeRoots,
    trashDirectory,
    run = runProcess,
    warn = () => {},
    maxDropFileBytes = DROP_FILE_LIMIT_BYTES,
    maxDropTotalBytes = DROP_TOTAL_LIMIT_BYTES,
  } = {}) {
    if (typeof stateDirectory !== 'string' || stateDirectory.trim() === '' || stateDirectory.includes('\u0000')) {
      throw new FilesError('files_invalid_request', 'the files state directory is required', { field: 'stateDirectory' })
    }
    /** @type {(message: string, error?: unknown) => void} */
    this.warn = typeof warn === 'function' ? warn : () => {}
    /** @type {string} */
    this.stateDirectory = resolvePath(stateDirectory.trim())
    /** @type {string} */
    this.thumbnailDirectory = join(this.stateDirectory, 'thumbs')
    /** @type {string} */
    this.recentPath = join(this.stateDirectory, RECENT_FILE)
    /** @type {string[]} */
    this.readRoots = normalizeRoots(readRoots, [realRoot(sep)], this.warn, 'readRoots')
    /** @type {string[]} */
    this.writeRoots = normalizeRoots(writeRoots, [realRoot(homedir()), realRoot(VOLUMES_DIRECTORY)], this.warn, 'writeRoots')
    /** @type {string} */
    this.trashDirectory = resolvePath(typeof trashDirectory === 'string' && trashDirectory.trim() !== '' ? trashDirectory.trim() : join(homedir(), '.Trash'))
    /** @type {string} */
    this.startDirectory = typeof startDirectory === 'string' && startDirectory.trim() !== '' && !startDirectory.includes('\u0000')
      ? resolvePath(startDirectory.trim())
      : resolvePath(homedir())
    /** @type {boolean} */
    this.showHidden = Boolean(showHidden)
    /** @type {number} */
    this.previewMaxBytes = clampedByteLimit(previewMaxBytes, DEFAULT_PREVIEW_MAX_BYTES)
    /** @type {number} */
    this.maxDropFileBytes = positiveLimit(maxDropFileBytes, DROP_FILE_LIMIT_BYTES)
    /** @type {number} */
    this.maxDropTotalBytes = positiveLimit(maxDropTotalBytes, DROP_TOTAL_LIMIT_BYTES)
    /** @type {string[]} */
    this.favorites = Array.isArray(favorites)
      ? favorites.filter((value) => typeof value === 'string' && value.trim() !== '' && !value.includes('\u0000'))
      : []
    /** @type {(command: string, args: string[], options?: object) => Promise<object>} */
    this.run = typeof run === 'function' ? run : runProcess
    /** @type {Recent[]} newest first. */
    this.recents = this.loadRecents()
    try {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
      mkdirSync(this.thumbnailDirectory, { recursive: true, mode: 0o700 })
    } catch (failure) {
      this.warn(`could not create the files state directory ${this.stateDirectory}`, failure)
    }
  }

  /**
   * The sidebar data: start directory, standard and custom places, volumes and
   * the recently visited directories.
   *
   * @returns {Promise<{ startDirectory: string, favorites: Place[], volumes: Volume[], recents: Recent[] }>} the sidebar.
   */
  async places() {
    return {
      startDirectory: this.startDirectoryForPlaces(),
      favorites: this.buildFavorites(),
      volumes: discoverVolumes(this.warn),
      recents: this.recents.map((entry) => ({ name: entry.name, path: entry.path, at: entry.at })),
    }
  }

  /**
   * List one directory.
   *
   * The visit is recorded in the recents list on success. A single entry whose
   * `lstat` fails is reported with an `error` field instead of failing the
   * listing.
   *
   * @param {object} [request] - listing request.
   * @param {string} [request.path] - directory to list; defaults to the start directory.
   * @param {'name' | 'size' | 'mtime' | 'kind'} [request.sort] - sort key; `name` by default.
   * @param {'asc' | 'desc'} [request.order] - sort direction; `asc` by default.
   * @param {boolean} [request.showHidden] - override the constructor's hidden-file policy.
   * @returns {Promise<ListResult>} the listing.
   * @throws {FilesError} `files_not_found`, `files_not_directory`, `files_outside_roots`, `files_io_error`.
   */
  async list({ path, sort = 'name', order = 'asc', showHidden } = {}) {
    const directory = this.assertReadable(this.requestPath(path, 'path', this.startDirectory))
    let info
    try {
      info = statSync(directory)
    } catch (failure) {
      throw this.fileError(failure, directory)
    }
    if (!info.isDirectory()) {
      throw new FilesError('files_not_directory', `${JSON.stringify(directory)} is not a directory`, { path: directory })
    }
    let names
    try {
      names = readdirSync(directory)
    } catch (failure) {
      throw this.fileError(failure, directory)
    }
    const visible = typeof showHidden === 'boolean' ? showHidden : this.showHidden
    const entries = []
    for (const name of names) {
      if (!visible && name.startsWith('.')) continue
      entries.push(this.describeEntry(directory, name))
    }
    const sortKey = SORT_KEYS.includes(sort) ? sort : 'name'
    const direction = order === 'desc' ? -1 : 1
    entries.sort((left, right) => direction * compareEntries(left, right, sortKey))
    const directories = []
    const others = []
    for (const entry of entries) {
      const target = entry.kind === 'directory' || (entry.kind === 'symlink' && entry.directory === true) ? directories : others
      target.push(entry)
    }
    const sorted = [...directories, ...others]
    const total = sorted.length
    const truncated = total > LIST_ENTRY_LIMIT
    const listing = truncated ? sorted.slice(0, LIST_ENTRY_LIMIT) : sorted
    let totalBytes = 0
    let freeBytes = 0
    try {
      const sizes = volumeSizes(realRoot(directory))
      totalBytes = sizes.totalBytes
      freeBytes = sizes.freeBytes
    } catch (failure) {
      this.warn(`could not read the free space of ${directory}`, failure)
    }
    let writable = false
    try {
      writable = insideAny(realpathSync(directory), this.writeRoots)
    } catch {
      writable = false
    }
    this.recordRecent(directory)
    return {
      path: directory,
      name: directory === sep ? sep : basename(directory),
      parent: directory === sep ? null : dirname(directory),
      writable,
      system: isSystemLocation(directory),
      freeBytes,
      totalBytes,
      entries: listing,
      total,
      truncated,
    }
  }

  /**
   * Read a text file for the preview pane.
   *
   * Large files are read only up to `maxBytes` and flagged `truncated`; a NUL
   * byte inside the first 8 KiB marks the file as binary and refuses it.
   *
   * @param {object} request - read request.
   * @param {string} request.path - file to read.
   * @param {number} [request.maxBytes] - byte budget, clamped to 1…1048576.
   * @returns {Promise<{ path: string, name: string, text: string, bytes: number, truncated: boolean, lines: number }>} the preview.
   * @throws {FilesError} `files_not_found`, `files_not_directory`, `files_binary`, `files_outside_roots`.
   */
  async readText({ path, maxBytes } = {}) {
    const target = this.assertReadable(this.requestPath(path, 'path'))
    const limit = clampedByteLimit(maxBytes, this.previewMaxBytes)
    let info
    try {
      info = statSync(target)
    } catch (failure) {
      throw this.fileError(failure, target)
    }
    if (info.isDirectory()) {
      throw new FilesError('files_not_directory', `${JSON.stringify(target)} is a directory, not a text file`, { path: target })
    }
    if (!info.isFile()) {
      throw new FilesError('files_invalid_request', `${JSON.stringify(target)} is not a regular file`, { path: target })
    }
    let buffer
    try {
      buffer = readPrefix(target, limit)
    } catch (failure) {
      throw this.fileError(failure, target)
    }
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new FilesError('files_binary', `${JSON.stringify(target)} looks like a binary file`, { path: target })
    }
    let text = buffer.toString('utf8')
    if (text.startsWith('\uFEFF')) text = text.slice(1)
    return {
      path: target,
      name: basename(target),
      text,
      bytes: info.size,
      truncated: info.size > limit,
      lines: countLines(text),
    }
  }

  /**
   * Load one safe raster image for the preview pane.
   *
   * @param {string} path - image path.
   * @returns {Promise<{ buffer: Buffer, mime: string }>} the bytes and their MIME type.
   * @throws {FilesError} `files_unsupported_preview`, `files_not_found`, `files_too_large`, `files_outside_roots`.
   */
  async previewFile(path) {
    const target = this.assertReadable(this.requestPath(path, 'path'))
    const mime = PREVIEW_MIME_BY_EXTENSION[extname(target).slice(1).toLowerCase()]
    if (mime === undefined) {
      throw new FilesError('files_unsupported_preview', `${JSON.stringify(target)} is not a previewable image`, { path: target })
    }
    let info
    try {
      info = statSync(target)
    } catch (failure) {
      throw this.fileError(failure, target)
    }
    if (!info.isFile()) {
      throw new FilesError('files_unsupported_preview', `${JSON.stringify(target)} is not a regular file`, { path: target })
    }
    if (info.size > IMAGE_PREVIEW_MAX_BYTES) {
      throw new FilesError('files_too_large', `${JSON.stringify(target)} is larger than ${IMAGE_PREVIEW_MAX_BYTES} bytes`, { path: target, bytes: info.size, limit: IMAGE_PREVIEW_MAX_BYTES })
    }
    try {
      return { buffer: readFileSync(target), mime }
    } catch (failure) {
      throw this.fileError(failure, target)
    }
  }

  /**
   * Produce (or reuse) a PNG thumbnail through Quick Look.
   *
   * `qlmanage` frequently exits non-zero even after writing the image, so the
   * output file is what decides success. Thumbnails are cached under
   * `<stateDirectory>/thumbs` keyed by path, mtime and requested size.
   *
   * @param {object} request - thumbnail request.
   * @param {string} request.path - file to thumbnail.
   * @param {number} [request.size] - requested edge length in pixels, clamped to 64…1024.
   * @returns {Promise<{ buffer: Buffer, mime: 'image/png' }>} the PNG bytes.
   * @throws {FilesError} `files_thumbnail_unavailable`, `files_not_found`, `files_outside_roots`.
   */
  async thumbnail({ path, size = DEFAULT_THUMBNAIL_SIZE } = {}) {
    const target = this.assertReadable(this.requestPath(path, 'path'))
    const requested = clampedThumbnailSize(size)
    let info
    try {
      info = statSync(target)
    } catch (failure) {
      throw this.fileError(failure, target)
    }
    if (!info.isFile()) {
      throw new FilesError('files_thumbnail_unavailable', `${JSON.stringify(target)} is not a regular file`, { path: target })
    }
    const key = createHash('sha1').update(`${target}:${info.mtimeMs}:${requested}`).digest('hex')
    const cachePath = join(this.thumbnailDirectory, `${key}.png`)
    try {
      const cached = readFileSync(cachePath)
      if (cached.byteLength > 0) return { buffer: cached, mime: 'image/png' }
    } catch {
      // Not cached yet; generate it below.
    }
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-thumb-'))
    try {
      let runFailure
      try {
        await this.run(QLMANAGE, ['-t', '-s', String(requested), '-o', temporaryDirectory, target], { timeoutMs: HELPER_TIMEOUT_MS })
      } catch (failure) {
        runFailure = failure
      }
      const produced = producedThumbnail(temporaryDirectory, target)
      if (produced === undefined) {
        const reason = runFailure === undefined ? 'Quick Look produced no thumbnail' : `Quick Look produced no thumbnail: ${failureDetail(runFailure)}`
        throw new FilesError('files_thumbnail_unavailable', `${JSON.stringify(target)} has no thumbnail (${reason})`, { path: target, reason })
      }
      try {
        mkdirSync(this.thumbnailDirectory, { recursive: true, mode: 0o700 })
        placeThumbnail(produced, cachePath)
      } catch (failure) {
        throw new FilesError('files_thumbnail_unavailable', `could not cache the thumbnail for ${JSON.stringify(target)}: ${failureMessage(failure)}`, { path: target, reason: failureMessage(failure) })
      }
      try {
        const buffer = readFileSync(cachePath)
        if (buffer.byteLength > 0) return { buffer, mime: 'image/png' }
      } catch (failure) {
        throw new FilesError('files_thumbnail_unavailable', `could not read the thumbnail for ${JSON.stringify(target)}: ${failureMessage(failure)}`, { path: target })
      }
      throw new FilesError('files_thumbnail_unavailable', `${JSON.stringify(target)} produced an empty thumbnail`, { path: target })
    } finally {
      try {
        rmSync(temporaryDirectory, { recursive: true, force: true })
      } catch {
        // The temporary directory is pruned by the system when left behind.
      }
    }
  }

  /**
   * Create one folder inside a writable directory.
   *
   * @param {object} request - folder request.
   * @param {string} request.path - parent directory.
   * @param {string} request.name - new folder name.
   * @returns {Promise<{ path: string, name: string }>} the created folder.
   * @throws {FilesError} `files_invalid_name`, `files_exists`, `files_outside_roots`, `files_not_found`.
   */
  async createFolder({ path, name } = {}) {
    const parent = this.assertWritableDirectory(this.requestPath(path, 'path'))
    const safeName = validatedEntryName(name, parent)
    const target = join(parent, safeName)
    if (pathExists(target)) {
      throw new FilesError('files_exists', `${JSON.stringify(target)} already exists`, { path: target })
    }
    try {
      mkdirSync(target)
    } catch (failure) {
      if (nativeCode(failure) === 'EEXIST') {
        throw new FilesError('files_exists', `${JSON.stringify(target)} already exists`, { path: target })
      }
      throw this.fileError(failure, target)
    }
    return { path: target, name: safeName }
  }

  /**
   * Rename one entry inside its current parent directory.
   *
   * The name is used exactly as given: the extension is not preserved or
   * appended automatically.
   *
   * @param {object} request - rename request.
   * @param {string} request.path - entry to rename.
   * @param {string} request.name - new base name.
   * @returns {Promise<{ path: string, name: string }>} the new path and name.
   * @throws {FilesError} `files_invalid_name`, `files_exists`, `files_not_found`, `files_outside_roots`.
   */
  async rename({ path, name } = {}) {
    const source = this.assertWritableTarget(this.requestPath(path, 'path'))
    try {
      lstatSync(source)
    } catch (failure) {
      throw this.fileError(failure, source)
    }
    const safeName = validatedEntryName(name, dirname(source))
    const target = join(dirname(source), safeName)
    if (target === source) return { path: source, name: safeName }
    if (pathExists(target)) {
      throw new FilesError('files_exists', `${JSON.stringify(target)} already exists`, { path: target })
    }
    try {
      renameSync(source, target)
    } catch (failure) {
      throw this.fileError(failure, target)
    }
    return { path: target, name: safeName }
  }

  /**
   * Move entries into the Trash.
   *
   * Entries are moved, never deleted: a cross-device Trash move fails instead
   * of replacing the move with a copy-and-delete. Name collisions get the
   * Finder-style `name 2.ext`, `name 3.ext`, … suffix. Each path is handled
   * independently and its failure is reported in `failed`.
   *
   * @param {object} request - trash request.
   * @param {string[]} request.paths - entries to move to the Trash.
   * @returns {Promise<{ trashed: Array<{ path: string, trashPath: string }>, failed: Array<{ path: string, code: string, message: string }> }>} the aggregate outcome.
   */
  async trash({ paths } = {}) {
    if (!Array.isArray(paths)) {
      throw new FilesError('files_invalid_request', 'paths must be an array of file paths', { field: 'paths' })
    }
    const trashed = []
    const failed = []
    for (const raw of paths) {
      let candidate = typeof raw === 'string' ? raw : String(raw)
      try {
        candidate = this.assertWritableTarget(this.requestPath(raw, 'path'))
        try {
          lstatSync(candidate)
        } catch (failure) {
          throw this.fileError(failure, candidate)
        }
        this.ensureTrashDirectory()
        const destination = join(this.trashDirectory, uniqueDestination(this.trashDirectory, basename(candidate) || 'item'))
        renameSync(candidate, destination)
        trashed.push({ path: candidate, trashPath: destination })
      } catch (failure) {
        failed.push(trashFailure(candidate, failure))
      }
    }
    return { trashed, failed }
  }

  /**
   * Compress entries into a ZIP archive next to the first entry.
   *
   * The archive is written with `ditto -c -k --sequesterRsrc --keepParent`, so
   * Finder's metadata comes along. A partial archive is removed when the helper
   * fails.
   *
   * @param {object} request - compression request.
   * @param {string[]} request.paths - entries to compress.
   * @returns {Promise<{ path: string, bytes: number }>} the archive path and size.
   * @throws {FilesError} `files_invalid_request`, `files_outside_roots`, `files_not_found`, `files_compress_failed`.
   */
  async compress({ paths } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new FilesError('files_invalid_request', 'paths must be a non-empty array of file paths', { field: 'paths' })
    }
    const sources = []
    for (const raw of paths) {
      const source = this.assertWritableTarget(this.requestPath(raw, 'path'))
      try {
        lstatSync(source)
      } catch (failure) {
        throw this.fileError(failure, source)
      }
      sources.push(source)
    }
    const parent = dirname(sources[0])
    const destination = join(parent, uniqueDestination(parent, `${basename(sources[0])}.zip`))
    try {
      await this.run(DITTO, ['-c', '-k', '--sequesterRsrc', '--keepParent', ...sources, destination], { timeoutMs: COMPRESS_TIMEOUT_MS })
    } catch (failure) {
      try {
        rmSync(destination, { force: true })
      } catch {
        // A leftover partial archive is harmless; report the helper failure.
      }
      throw new FilesError('files_compress_failed', `could not compress ${JSON.stringify(sources[0])}: ${failureDetail(failure)}`, {
        path: destination,
        paths: sources,
        reason: failureDetail(failure),
      })
    }
    let info
    try {
      info = statSync(destination)
    } catch (failure) {
      throw new FilesError('files_compress_failed', `the archive ${JSON.stringify(destination)} was not created: ${failureMessage(failure)}`, { path: destination, paths: sources })
    }
    if (!info.isFile() || info.size === 0) {
      throw new FilesError('files_compress_failed', `the archive ${JSON.stringify(destination)} is empty`, { path: destination, paths: sources })
    }
    return { path: destination, bytes: info.size }
  }

  /**
   * Save files dropped onto the panel.
   *
   * Every payload is decoded and size-checked before anything is written, so a
   * batch that exceeds the total limit leaves no partial output. Names are
   * sanitized to one path segment, de-duplicated and written atomically.
   *
   * @param {object} request - drop request.
   * @param {string} request.directory - destination directory.
   * @param {Array<{ name: string, dataBase64: string }>} request.files - uploads; `dataBase64` may be a data URL.
   * @returns {Promise<{ saved: Array<{ name: string, path: string, bytes: number }>, failed: Array<{ name: string, code: string, message: string }> }>} the aggregate outcome.
   * @throws {FilesError} `files_invalid_request`, `files_outside_roots`, `files_too_large`.
   */
  async drop({ directory, files } = {}) {
    const destinationDirectory = this.assertWritableDirectory(this.requestPath(directory, 'directory'))
    if (!Array.isArray(files)) {
      throw new FilesError('files_invalid_request', 'files must be an array of uploads', { field: 'files' })
    }
    const decoded = []
    const failures = []
    let totalBytes = 0
    for (const item of files) {
      const requestedName = item !== null && typeof item === 'object' && typeof item.name === 'string' ? item.name : ''
      try {
        const safeName = sanitizedUploadName(requestedName)
        const buffer = decodeUpload(item !== null && typeof item === 'object' ? item.dataBase64 : undefined, this.maxDropFileBytes)
        totalBytes += buffer.byteLength
        decoded.push({ name: safeName, buffer })
      } catch (failure) {
        failures.push(uploadFailure(requestedName, failure))
      }
    }
    if (totalBytes > this.maxDropTotalBytes) {
      throw new FilesError('files_too_large', `the upload totals ${totalBytes} bytes, above the ${this.maxDropTotalBytes} byte limit`, {
        path: destinationDirectory,
        bytes: totalBytes,
        limit: this.maxDropTotalBytes,
      })
    }
    const saved = []
    for (const item of decoded) {
      try {
        const target = writeUpload(destinationDirectory, item.name, item.buffer)
        saved.push({ name: basename(target), path: target, bytes: item.buffer.byteLength })
      } catch (failure) {
        failures.push(uploadFailure(item.name, failure))
      }
    }
    return { saved, failed: failures }
  }

  /**
   * Show an entry in Finder.
   *
   * @param {object} request - reveal request.
   * @param {string} request.path - entry to reveal.
   * @returns {Promise<{ revealed: true, path: string }>} the outcome.
   * @throws {FilesError} `files_not_found`, `files_outside_roots`, `files_open_failed`.
   */
  async reveal({ path } = {}) {
    const target = this.requireExisting(path, 'path')
    await this.runOpen(['-R', target], target)
    return { revealed: true, path: target }
  }

  /**
   * Open an entry with its default application.
   *
   * @param {object} request - open request.
   * @param {string} request.path - entry to open.
   * @returns {Promise<{ opened: true, path: string }>} the outcome.
   * @throws {FilesError} `files_not_found`, `files_outside_roots`, `files_open_failed`.
   */
  async open({ path } = {}) {
    const target = this.requireExisting(path, 'path')
    await this.runOpen([target], target)
    return { opened: true, path: target }
  }

  /**
   * Release per-session resources.
   *
   * This browser keeps no descriptors or timers between calls; the persisted
   * recents and the thumbnail cache stay on disk and are reused by the next
   * instance.
   *
   * @returns {void}
   */
  dispose() {
    // Nothing to release: every operation closes what it opens.
  }

  /**
   * @param {unknown} input - request path.
   * @param {string} [field] - request field name used in errors.
   * @param {string} [fallback] - value used when the request omits the path.
   * @returns {string} the absolute path.
   * @throws {FilesError} `files_invalid_request` for an empty path or a NUL byte.
   */
  requestPath(input, field = 'path', fallback) {
    if (input === undefined || input === null || input === '') {
      if (fallback !== undefined) return fallback
      throw new FilesError('files_invalid_request', `${field} must be a non-empty path`, { field })
    }
    if (typeof input !== 'string') {
      throw new FilesError('files_invalid_request', `${field} must be a path string`, { field })
    }
    if (input.includes('\u0000')) {
      throw new FilesError('files_invalid_request', `${field} contains a NUL byte`, { path: input })
    }
    if (input.trim() === '') {
      throw new FilesError('files_invalid_request', `${field} must be a non-empty path`, { field })
    }
    return resolvePath(input)
  }

  /**
   * Resolve a read path and require it to be inside `readRoots`.
   *
   * A symlinked path is accepted when either its lexical form or its realpath
   * is inside the roots, so `~`-style paths and `/var` → `/private/var` keep
   * working.
   *
   * @param {string} input - request path.
   * @returns {string} the absolute path.
   * @throws {FilesError} `files_outside_roots`, `files_invalid_request`.
   */
  assertReadable(input) {
    const path = this.requestPath(input, 'path')
    if (insideAny(path, this.readRoots)) return path
    try {
      if (insideAny(realpathSync(path), this.readRoots)) return path
    } catch {
      // Missing paths are reported by the caller with a precise code.
    }
    throw new FilesError('files_outside_roots', `${JSON.stringify(path)} is outside the readable locations`, { path })
  }

  /**
   * Resolve an *existing* directory and require it inside `writeRoots`.
   *
   * @param {string} input - request path.
   * @returns {string} the directory path to use in returned values.
   * @throws {FilesError} `files_not_found`, `files_not_directory`, `files_outside_roots`.
   */
  assertWritableDirectory(input) {
    const path = this.requestPath(input, 'path')
    let real
    try {
      real = realpathSync(path)
    } catch (failure) {
      throw this.fileError(failure, path)
    }
    let info
    try {
      info = statSync(real)
    } catch (failure) {
      throw this.fileError(failure, path)
    }
    if (!info.isDirectory()) {
      throw new FilesError('files_not_directory', `${JSON.stringify(path)} is not a directory`, { path })
    }
    if (!insideAny(real, this.writeRoots)) {
      throw new FilesError('files_outside_roots', `${JSON.stringify(path)} is outside the allowed write locations`, { path })
    }
    return path
  }

  /**
   * Resolve a write target and require its parent's realpath to be inside
   * `writeRoots`. Because the check uses the parent's realpath, a symlinked
   * directory cannot be used to escape the roots.
   *
   * @param {string} input - request path.
   * @returns {string} the absolute target path.
   * @throws {FilesError} `files_not_found`, `files_not_directory`, `files_outside_roots`.
   */
  assertWritableTarget(input) {
    const path = this.requestPath(input, 'path')
    const parent = dirname(path)
    let parentReal
    try {
      parentReal = realpathSync(parent)
    } catch (failure) {
      throw this.fileError(failure, parent)
    }
    let info
    try {
      info = statSync(parentReal)
    } catch (failure) {
      throw this.fileError(failure, parent)
    }
    if (!info.isDirectory()) {
      throw new FilesError('files_not_directory', `${JSON.stringify(parent)} is not a directory`, { path: parent })
    }
    if (!insideAny(parentReal, this.writeRoots)) {
      throw new FilesError('files_outside_roots', `${JSON.stringify(path)} is outside the allowed write locations`, { path })
    }
    return path
  }

  /**
   * Resolve a read path that must exist.
   *
   * @param {unknown} input - request path.
   * @param {string} [field] - request field name used in errors.
   * @returns {string} the absolute path.
   * @throws {FilesError} `files_not_found`, `files_outside_roots`, `files_invalid_request`.
   */
  requireExisting(input, field = 'path') {
    const target = this.assertReadable(this.requestPath(input, field))
    try {
      statSync(target)
    } catch (failure) {
      throw this.fileError(failure, target)
    }
    return target
  }

  /**
   * Run `/usr/bin/open` and translate its failure.
   *
   * @param {string[]} args - helper arguments.
   * @param {string} target - path the caller asked about, used in errors.
   * @returns {Promise<void>} resolves when Finder or the default app accepted the request.
   * @throws {FilesError} `files_open_failed`.
   */
  async runOpen(args, target) {
    try {
      await this.run(OPEN, args, { timeoutMs: HELPER_TIMEOUT_MS })
    } catch (failure) {
      throw new FilesError('files_open_failed', `could not open ${JSON.stringify(target)}: ${failureDetail(failure)}`, {
        path: target,
        reason: failureDetail(failure),
      })
    }
  }

  /**
   * Translate a filesystem failure into a {@link FilesError}.
   *
   * @param {unknown} failure - thrown value.
   * @param {string} path - path the operation was about.
   * @returns {FilesError} the translated failure.
   */
  fileError(failure, path) {
    const code = nativeCode(failure)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return new FilesError('files_not_found', `${JSON.stringify(path)} does not exist`, { path })
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return new FilesError('files_permission_denied', `permission denied for ${JSON.stringify(path)}`, { path })
    }
    if (code === 'ELOOP') {
      return new FilesError('files_invalid_request', `${JSON.stringify(path)} has a symbolic-link loop`, { path })
    }
    return new FilesError('files_io_error', failureMessage(failure), { path })
  }

  /**
   * Build one listing entry.
   *
   * @param {string} directory - listed directory.
   * @param {string} name - entry name.
   * @returns {FileEntry} the entry; `lstat` failures become an `error` field.
   */
  describeEntry(directory, name) {
    const path = join(directory, name)
    const hidden = name.startsWith('.')
    const extension = extname(name).slice(1).toLowerCase()
    let info
    try {
      info = lstatSync(path)
    } catch (failure) {
      return {
        name,
        path,
        kind: 'other',
        size: 0,
        mtime: '',
        ext: extension,
        hidden,
        error: { code: nativeCode(failure) || 'files_io_error', message: failureMessage(failure) },
      }
    }
    /** @type {FileEntry} */
    const entry = {
      name,
      path,
      kind: 'other',
      size: 0,
      mtime: info.mtime.toISOString(),
      ext: extension,
      hidden,
    }
    if (info.isSymbolicLink()) {
      entry.kind = 'symlink'
      entry.size = info.size
      let linkTarget = ''
      try {
        linkTarget = realpathSync(path)
      } catch {
        try {
          linkTarget = readlinkSync(path)
        } catch {
          linkTarget = ''
        }
      }
      if (linkTarget !== '') entry.linkTarget = linkTarget
      try {
        if (statSync(path).isDirectory()) entry.directory = true
      } catch {
        // A dangling symlink stays a non-navigable symlink entry.
      }
    } else if (info.isDirectory()) {
      entry.kind = 'directory'
    } else if (info.isFile()) {
      entry.kind = 'file'
      entry.size = info.size
    } else {
      entry.size = info.size
    }
    return entry
  }

  /**
   * @returns {string} the start directory when it still exists, else the home directory, else `/`.
   */
  startDirectoryForPlaces() {
    if (isDirectory(this.startDirectory)) return this.startDirectory
    const home = resolvePath(homedir())
    if (isDirectory(home)) {
      this.warn(`the configured start directory ${this.startDirectory} is not available; using the home directory`)
      return home
    }
    return sep
  }

  /**
   * Build the sidebar destinations: the existing standard places first, then
   * the configured custom favorites, de-duplicated by real path.
   *
   * @returns {Place[]} the places.
   */
  buildFavorites() {
    const home = resolvePath(homedir())
    const standard = [
      { id: 'home', name: 'Home', path: home },
      { id: 'desktop', name: 'Desktop', path: join(home, 'Desktop') },
      { id: 'documents', name: 'Documents', path: join(home, 'Documents') },
      { id: 'downloads', name: 'Downloads', path: join(home, 'Downloads') },
      { id: 'pictures', name: 'Pictures', path: join(home, 'Pictures') },
      { id: 'movies', name: 'Movies', path: join(home, 'Movies') },
      { id: 'music', name: 'Music', path: join(home, 'Music') },
      { id: 'applications', name: 'Applications', path: APPLICATIONS_DIRECTORY },
    ]
    const favorites = []
    const seen = new Set()
    for (const place of standard) {
      if (!isDirectory(place.path)) continue
      const real = realRoot(place.path)
      if (seen.has(real)) continue
      seen.add(real)
      favorites.push({ id: place.id, name: place.name, path: place.path })
    }
    for (const input of this.favorites) {
      let path
      let real
      try {
        path = resolvePath(input.trim())
        real = realRoot(path)
      } catch (failure) {
        this.warn(`could not resolve the favorite ${JSON.stringify(input)}`, failure)
        continue
      }
      if (!isDirectory(path)) {
        this.warn(`the favorite ${JSON.stringify(input)} is not a directory; skipping it`)
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      favorites.push({ id: 'custom', name: basename(path) || path, path })
    }
    return favorites
  }

  /**
   * Read the persisted recents list, tolerating a missing or corrupt file.
   *
   * @returns {Recent[]} newest first, at most {@link RECENT_LIMIT} entries.
   */
  loadRecents() {
    let document
    try {
      document = JSON.parse(readFileSync(this.recentPath, 'utf8'))
    } catch {
      return []
    }
    const entries = Array.isArray(document)
      ? document
      : (document !== null && typeof document === 'object' && Array.isArray(document.entries) ? document.entries : [])
    const recents = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.path !== 'string' || entry.path === '') continue
      if (recents.some((item) => item.path === entry.path)) continue
      recents.push({
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : (entry.path === sep ? sep : basename(entry.path)),
        path: entry.path,
        at: typeof entry.at === 'string' ? entry.at : '',
      })
      if (recents.length >= RECENT_LIMIT) break
    }
    return recents
  }

  /**
   * Record one visited directory and persist the list atomically (0600).
   *
   * @param {string} path - visited directory.
   * @returns {void}
   */
  recordRecent(path) {
    const name = path === sep ? sep : (basename(path) || path)
    this.recents = [{ name, path, at: new Date().toISOString() }, ...this.recents.filter((entry) => entry.path !== path)].slice(0, RECENT_LIMIT)
    try {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
      const temporary = `${this.recentPath}.tmp-${process.pid}`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: this.recents }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.recentPath)
    } catch (failure) {
      this.warn(`could not persist the recent directories in ${this.recentPath}`, failure)
    }
  }

  /**
   * Create the Trash directory on demand. The constructor deliberately does
   * not touch `~/.Trash`.
   *
   * @returns {void}
   * @throws {FilesError} `files_trash_failed` when the directory cannot be created.
   */
  ensureTrashDirectory() {
    try {
      mkdirSync(this.trashDirectory, { recursive: true, mode: 0o700 })
    } catch (failure) {
      throw new FilesError('files_trash_failed', `could not create the Trash directory ${JSON.stringify(this.trashDirectory)}: ${failureMessage(failure)}`, {
        path: this.trashDirectory,
      })
    }
  }
}

/**
 * Compare two entries for one sort key.
 *
 * @param {FileEntry} left - first entry.
 * @param {FileEntry} right - second entry.
 * @param {'name' | 'size' | 'mtime' | 'kind'} sort - sort key.
 * @returns {number} negative, zero or positive.
 */
function compareEntries(left, right, sort) {
  if (sort === 'size') {
    const result = (left.size || 0) - (right.size || 0)
    return result !== 0 ? result : compareNames(left.name, right.name)
  }
  if (sort === 'mtime') {
    const result = Date.parse(left.mtime || '') - Date.parse(right.mtime || '')
    if (Number.isNaN(result)) return compareNames(left.name, right.name)
    return result !== 0 ? result : compareNames(left.name, right.name)
  }
  if (sort === 'kind') {
    const result = compareNames(left.kind, right.kind)
    return result !== 0 ? result : compareNames(left.name, right.name)
  }
  return compareNames(left.name, right.name)
}

/**
 * @param {string} path - attempted path.
 * @param {unknown} failure - thrown value.
 * @returns {{ path: string, code: string, message: string }} one `failed` row of `trash()`.
 */
function trashFailure(path, failure) {
  if (failure instanceof FilesError) return { path, code: failure.code, message: failure.message }
  if (nativeCode(failure) === 'EXDEV') {
    return { path, code: 'files_cross_device', message: 'the Trash directory is on another volume; the entry was left in place' }
  }
  return { path, code: 'files_trash_failed', message: failureMessage(failure) }
}

/**
 * @param {string} name - requested upload name.
 * @param {unknown} failure - thrown value.
 * @returns {{ name: string, code: string, message: string }} one `failed` row of `drop()`.
 */
function uploadFailure(name, failure) {
  const code = failure instanceof FilesError ? failure.code : 'files_io_error'
  return { name, code, message: failureMessage(failure) }
}
