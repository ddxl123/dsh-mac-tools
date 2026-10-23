/**
 * QR helper orchestration: source-hash cache, compiler/helper arguments and
 * error mapping — all through an injected `run`, so no Swift toolchain runs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateQrPng, qrSourcePath, resolveSwiftc } from '../src/transfer-qr.js'

/** A valid tiny PNG as base64 (one transparent pixel). */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * @param {string} [prefix] - temp-dir prefix.
 * @returns {string} a fresh temp directory.
 */
function tempRoot(prefix = 'dsh-mac-tools-transfer-qr-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * @param {string} sourcePath - source file the hash is computed from.
 * @returns {string} the cached binary path the helper must compile to.
 */
function expectedBinary(sourcePath) {
  const hash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex').slice(0, 16)
  return `qrcode-${process.arch}-${hash}`
}

test('compiles once, caches by source hash and runs the helper with the right arguments', async () => {
  const root = tempRoot()
  try {
    const sourcePath = join(root, 'qrcode.swift')
    writeFileSync(sourcePath, '// fake qrcode source\n')
    const cacheDirectory = join(root, 'cache')
    /** @type {Array<{ command: string, args: string[], options: object }>} */
    const calls = []
    const run = async (command, args, options) => {
      calls.push({ command, args, options })
      if (args.includes('-o')) {
        const outputIndex = args.indexOf('-o') + 1
        writeFileSync(args[outputIndex], '#!/bin/sh\n')
        return { stdout: '', stderr: '', code: 0 }
      }
      return { stdout: `${TINY_PNG_BASE64}\n`, stderr: '', code: 0 }
    }

    const encoded = await generateQrPng('http://192.168.1.47:8791/t/abc/', {
      sourcePath,
      cacheDirectory,
      swiftc: '/usr/bin/swiftc',
      run,
      timeoutMs: 5000,
      size: 256,
    })
    assert.equal(encoded, TINY_PNG_BASE64)
    assert.equal(calls.length, 2)
    const binary = join(cacheDirectory, expectedBinary(sourcePath))
    assert.equal(calls[0].command, '/usr/bin/swiftc')
    assert.deepEqual(calls[0].args.slice(0, 3), ['-O', sourcePath, '-o'], 'the compiler builds into a private temporary path')
    assert.ok(
      calls[0].args[3].startsWith(`${binary}.tmp-`),
      `the compiler must not write the cache path directly, got ${calls[0].args[3]}`,
    )
    assert.equal(calls[0].options.timeoutMs, 5000)
    assert.equal(calls[1].command, binary)
    assert.deepEqual(calls[1].args, ['http://192.168.1.47:8791/t/abc/', '256'])
    assert.equal(calls[1].options.timeoutMs, 5000)
    assert.ok(existsSync(binary))
    assert.deepEqual(readdirSync(cacheDirectory).filter((name) => name.includes('.tmp-')), [], 'no temporary compile output may remain')

    calls.length = 0
    const again = await generateQrPng('second text', { sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.equal(again, TINY_PNG_BASE64)
    assert.equal(calls.length, 1, 'the cached binary must not be recompiled')
    assert.equal(calls[0].command, binary)
    assert.deepEqual(calls[0].args, ['second text', '512'], 'the default size is used')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails with swift-missing when no compiler is configured', async () => {
  await assert.rejects(
    generateQrPng('http://example.test/t/abc/', {
      swiftc: '',
      run: async () => {
        throw new Error('the runner must not be called')
      },
    }),
    (failure) => failure instanceof Error && failure.code === 'swift-missing',
  )
})

test('reports a missing helper source as compile-failed', async () => {
  const root = tempRoot()
  try {
    await assert.rejects(
      generateQrPng('http://example.test/t/abc/', {
        sourcePath: join(root, 'missing.swift'),
        cacheDirectory: join(root, 'cache'),
        swiftc: '/usr/bin/swiftc',
        run: async () => {
          throw new Error('the runner must not be called')
        },
      }),
      (failure) => failure instanceof Error && failure.code === 'compile-failed',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports compilation failures as compile-failed', async () => {
  const root = tempRoot()
  try {
    const sourcePath = join(root, 'qrcode.swift')
    writeFileSync(sourcePath, '// fake qrcode source\n')
    await assert.rejects(
      generateQrPng('http://example.test/t/abc/', {
        sourcePath,
        cacheDirectory: join(root, 'cache'),
        swiftc: '/usr/bin/swiftc',
        run: async () => {
          throw new Error('swiftc exploded')
        },
      }),
      (failure) => failure instanceof Error && failure.code === 'compile-failed' && failure.message.includes('swiftc exploded'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports helper failures and empty output as qr-failed', async () => {
  const root = tempRoot()
  try {
    const sourcePath = join(root, 'qrcode.swift')
    writeFileSync(sourcePath, '// fake qrcode source\n')
    const cacheDirectory = join(root, 'cache')
    mkdirSync(cacheDirectory, { recursive: true })
    const binary = join(cacheDirectory, expectedBinary(sourcePath))
    writeFileSync(binary, '#!/bin/sh\n')

    await assert.rejects(
      generateQrPng('boom', {
        sourcePath,
        cacheDirectory,
        swiftc: '/usr/bin/swiftc',
        run: async () => {
          throw new Error('helper crashed')
        },
      }),
      (failure) => failure instanceof Error && failure.code === 'qr-failed' && failure.message.includes('helper crashed'),
    )

    await assert.rejects(
      generateQrPng('blank', {
        sourcePath,
        cacheDirectory,
        swiftc: '/usr/bin/swiftc',
        run: async () => ({ stdout: '   \n', stderr: '', code: 0 }),
      }),
      (failure) => failure instanceof Error && failure.code === 'qr-failed',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discards a partial compiler output so the next call recompiles', async () => {
  const root = tempRoot()
  try {
    const sourcePath = join(root, 'qrcode.swift')
    writeFileSync(sourcePath, '// fake qrcode source\n')
    const cacheDirectory = join(root, 'cache')
    const binary = join(cacheDirectory, expectedBinary(sourcePath))
    let compiles = 0
    const run = async (command, args) => {
      if (args.includes('-o')) {
        compiles += 1
        const output = args[args.indexOf('-o') + 1]
        if (compiles === 1) {
          // A compiler interrupted mid-write leaves a truncated output behind.
          writeFileSync(output, 'PARTIAL-BINARY')
          throw new Error('swiftc was killed')
        }
        writeFileSync(output, '#!/bin/sh\n')
        return { stdout: '', stderr: '', code: 0 }
      }
      return { stdout: `${TINY_PNG_BASE64}\n`, stderr: '', code: 0 }
    }

    await assert.rejects(
      generateQrPng('http://example.test/t/abc/', { sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run }),
      (failure) => failure instanceof Error && failure.code === 'compile-failed',
    )
    assert.equal(existsSync(binary), false, 'a failed compile must not poison the cache')
    assert.deepEqual(readdirSync(cacheDirectory).filter((name) => name.includes('.tmp-')), [])

    const encoded = await generateQrPng('http://example.test/t/abc/', { sourcePath, cacheDirectory, swiftc: '/usr/bin/swiftc', run })
    assert.equal(encoded, TINY_PNG_BASE64)
    assert.equal(compiles, 2, 'the broken cache entry must be recompiled, not executed')
    assert.ok(existsSync(binary))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a compiler that exits 0 without producing a binary', async () => {
  const root = tempRoot()
  try {
    const sourcePath = join(root, 'qrcode.swift')
    writeFileSync(sourcePath, '// fake qrcode source\n')
    const cacheDirectory = join(root, 'cache')
    await assert.rejects(
      generateQrPng('http://example.test/t/abc/', {
        sourcePath,
        cacheDirectory,
        swiftc: '/usr/bin/swiftc',
        run: async (command, args) => {
          if (args.includes('-o')) writeFileSync(args[args.indexOf('-o') + 1], '')
          return { stdout: '', stderr: '', code: 0 }
        },
      }),
      (failure) => failure instanceof Error && failure.code === 'compile-failed',
    )
    assert.equal(existsSync(join(cacheDirectory, expectedBinary(sourcePath))), false)
    assert.deepEqual(readdirSync(cacheDirectory).filter((name) => name.includes('.tmp-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exposes the bundled helper source and the installed compiler', () => {
  const sourcePath = qrSourcePath()
  assert.ok(sourcePath.endsWith(`${join('assets', 'qrcode.swift')}`), `unexpected source path ${sourcePath}`)
  assert.ok(existsSync(sourcePath), 'the bundled qrcode.swift must exist')
  const swiftc = resolveSwiftc()
  assert.ok(swiftc === undefined || existsSync(swiftc), 'resolveSwiftc must return an existing compiler or undefined')
})
