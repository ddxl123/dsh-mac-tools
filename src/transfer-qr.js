/**
 * QR-code helper for the phone-transfer session.
 *
 * The QR image is produced by a tiny Swift program (`assets/qrcode.swift`),
 * built once with `swiftc` and cached next to the other compiled helpers,
 * keyed by the first 16 hex characters of the helper source's SHA-256. That
 * keeps the first transfer session slow (one `swiftc` run) and every later
 * session instant, and it automatically refreshes the binary when the Swift
 * source changes.
 *
 * `generateQrPng()` returns the bare base64 PNG (no `data:` prefix); the panel
 * turns it into a `data:image/png;base64,…` URL. The process runner is
 * injectable so tests exercise the cache and argument logic without a Swift
 * toolchain.
 *
 * @module dsh-mac-tools/transfer-qr
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Default timeout for one compiler / helper invocation. */
const DEFAULT_TIMEOUT_MS = 25_000

/** Default QR image edge length in pixels. */
const DEFAULT_QR_SIZE = 512

/**
 * @param {string} code - stable failure code.
 * @param {string} message - human-readable diagnostic.
 * @param {object} [details] - extra context.
 * @returns {Error} an error carrying `code`.
 */
function qrError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

/**
 * Locate a Swift compiler.
 *
 * @returns {string | undefined} the executable, when the toolchain is installed.
 */
export function resolveSwiftc() {
  for (const candidate of ['/usr/bin/swiftc', '/usr/local/bin/swiftc', '/opt/homebrew/bin/swiftc']) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** @returns {string} this package's QR helper source path. */
export function qrSourcePath() {
  return fileURLToPath(new URL('../assets/qrcode.swift', import.meta.url))
}

/**
 * Run one child process and capture its output.
 *
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {{ timeoutMs?: number }} [options] - runner options.
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>} the captured output.
 */
function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-256 * 1024)
    })
    const finish = (operation) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      operation()
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        finish(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // The process already exited.
          }
          reject(qrError('timeout', `${command} timed out after ${timeoutMs} ms`, { timeoutMs }))
        })
      }, timeoutMs)
      : undefined
    timer?.unref?.()
    child.on('error', (failure) => {
      finish(() => reject(qrError('io_error', `could not run ${command}: ${failure instanceof Error ? failure.message : String(failure)}`)))
    })
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr, code })
          return
        }
        reject(qrError('exit', `${command} exited with code ${code}: ${stderr.trim()}`, { code, stdout, stderr }))
      })
    })
  })
}

/**
 * Generate a QR code as a base64 PNG for the session URL.
 *
 * @param {string} text - the text to encode (the session URL).
 * @param {object} [options] - generation options.
 * @param {string} [options.sourcePath] - `qrcode.swift` path.
 * @param {string} [options.cacheDirectory] - where compiled helpers live.
 * @param {string} [options.swiftc] - compiler executable.
 * @param {(command: string, args: string[], options: object) => Promise<{ stdout: string }>} [options.run] - process runner (injectable for tests).
 * @param {number} [options.timeoutMs] - per-invocation timeout.
 * @param {number} [options.size] - QR image edge length in pixels.
 * @returns {Promise<string>} bare base64 PNG, no `data:` prefix.
 * @throws {Error} with `code` `swift-missing`, `compile-failed` or `qr-failed`.
 */
export async function generateQrPng(text, {
  sourcePath = qrSourcePath(),
  cacheDirectory = join(tmpdir(), 'dsh-mac-tools-qrcode'),
  swiftc = resolveSwiftc(),
  run = runProcess,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  size = DEFAULT_QR_SIZE,
} = {}) {
  if (typeof text !== 'string' || text === '') {
    throw qrError('qr-failed', 'the QR text must be a non-empty string')
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw qrError('qr-failed', `the QR size must be a positive integer, got ${JSON.stringify(size)}`)
  }
  if (typeof swiftc !== 'string' || swiftc === '') {
    throw qrError('swift-missing', 'swiftc is not installed (install the Xcode Command Line Tools)')
  }
  let source
  try {
    source = readFileSync(sourcePath)
  } catch (failure) {
    throw qrError('compile-failed', `could not read the QR helper source: ${failure instanceof Error ? failure.message : String(failure)}`)
  }
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const binary = join(cacheDirectory, `qrcode-${process.arch}-${hash}`)
  if (!existsSync(binary)) {
    try {
      mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
    } catch (failure) {
      throw qrError('compile-failed', `could not prepare the QR helper cache: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
    // Compile to a private temporary path and rename it into place only on
    // success: a killed/timed-out compiler must never leave a truncated binary
    // at the cache path (later calls would execute it instead of recompiling),
    // and two concurrent first-time sessions must not write the same output.
    const temporary = `${binary}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      await run(swiftc, ['-O', sourcePath, '-o', temporary], { timeoutMs })
      let compiledBytes = 0
      try {
        compiledBytes = statSync(temporary).size
      } catch {
        compiledBytes = 0
      }
      if (compiledBytes === 0) {
        throw qrError('compile-failed', 'the compiler produced no QR helper binary')
      }
      try {
        chmodSync(temporary, 0o700)
      } catch {
        // A cache filesystem without chmod support is still usable.
      }
      try {
        renameSync(temporary, binary)
      } catch (failure) {
        // A concurrent process may have published its (equivalent) binary first.
        if (!existsSync(binary)) throw failure
        rmSync(temporary, { force: true })
      }
    } catch (failure) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // It was never created.
      }
      if (failure instanceof Error && failure.code === 'compile-failed') throw failure
      throw qrError('compile-failed', `could not compile the QR helper: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
    if (!existsSync(binary)) {
      throw qrError('compile-failed', 'the compiler produced no QR helper binary')
    }
  }
  let stdout
  try {
    ({ stdout } = await run(binary, [text, String(size)], { timeoutMs }))
  } catch (failure) {
    throw qrError('qr-failed', `could not generate the QR code: ${failure instanceof Error ? failure.message : String(failure)}`)
  }
  const base64 = typeof stdout === 'string' ? stdout.trim() : ''
  if (base64 === '') throw qrError('qr-failed', 'the QR helper produced no image')
  return base64
}
