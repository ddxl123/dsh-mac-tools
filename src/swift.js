/**
 * Compile-once cache for the plugin's Swift helpers.
 *
 * The screenshot hotkey already carries its own copy of this logic; this module
 * is the generic entry the newer helpers (`state.swift`, `fan-daemon.swift`)
 * share. A source change invalidates the cached binary through the source hash,
 * so editing `assets/*.swift` and reloading the plugin picks up the new binary
 * without any manual step.
 *
 * Compilation needs the Xcode Command Line Tools (`swiftc` is a shim that asks
 * to install them when they are missing). Every failure is reported as a typed
 * error with a stable `code`, so the panel can localize the reason instead of
 * printing a compiler transcript.
 *
 * @module dsh-mac-tools/swift
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runProcess } from './capture.js'

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

/** A failed helper compilation with a stable code. */
export class SwiftBuildError extends Error {
  /**
   * @param {'swift-missing' | 'compile-failed'} code - stable failure code.
   * @param {string} message - diagnostic message.
   */
  constructor(code, message) {
    super(message)
    this.name = 'SwiftBuildError'
    this.code = code
  }
}

/**
 * Compile one Swift source once and cache the binary by source hash.
 *
 * A cache hit returns the existing executable without touching `swiftc`, which
 * keeps restarts instant after the first build.
 *
 * A helper may also be built from a C source (the IOReport power shim): `swiftc`
 * compiles `.c` files itself and links them, and the declarations reach Swift
 * through the bridging header passed with `-import-objc-header`. Both the
 * sources and the header are part of the cache key, so editing either rebuilds.
 *
 * @param {object} options - build options.
 * @param {string} options.sourcePath - absolute path of the single `.swift` source.
 * @param {string[]} [options.sourcePaths] - absolute paths when the helper is built from several files (the shared SMC core plus a main file, or Swift sources plus a C shim).
 * @param {string} [options.headerPath] - absolute path of the bridging header that exposes a C shim to Swift.
 * @param {string} options.cacheName - stable name prefix for the cached binary.
 * @param {string} [options.cacheDirectory] - where compiled helpers live.
 * @param {string} [options.swiftc] - compiler executable.
 * @param {typeof runProcess} [options.run] - process runner (injectable for tests).
 * @returns {Promise<string>} the executable path.
 * @throws {SwiftBuildError} when the toolchain is missing or compilation fails.
 */
export async function ensureSwiftBinary({
  sourcePath,
  sourcePaths,
  headerPath,
  cacheName,
  cacheDirectory = join(tmpdir(), 'dsh-mac-tools-swift'),
  swiftc = resolveSwiftc(),
  run = runProcess,
}) {
  if (swiftc === undefined) {
    throw new SwiftBuildError('swift-missing', 'swiftc is not installed (install the Xcode Command Line Tools)')
  }
  const sources = Array.isArray(sourcePaths) && sourcePaths.length > 0 ? sourcePaths : [sourcePath]
  const digest = createHash('sha256')
  for (const file of sources) digest.update(readFileSync(file))
  // The bridging header is a build input as well: it is what exposes the C
  // shim's declarations to Swift, so a header edit must invalidate the cache.
  if (headerPath !== undefined) {
    digest.update('bridging-header')
    digest.update(readFileSync(headerPath))
  }
  const hash = digest.digest('hex').slice(0, 16)
  const binary = join(cacheDirectory, `${cacheName}-${process.arch}-${hash}`)
  if (existsSync(binary)) return binary
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
  const args = ['-O']
  if (headerPath !== undefined) args.push('-import-objc-header', headerPath)
  args.push(...sources, '-o', binary)
  try {
    await run(swiftc, args, { timeoutMs: 180_000 })
  } catch (failure) {
    throw new SwiftBuildError(
      'compile-failed',
      `could not compile ${cacheName}: ${failure instanceof Error ? failure.message : String(failure)}`,
    )
  }
  chmodSync(binary, 0o700)
  return binary
}
