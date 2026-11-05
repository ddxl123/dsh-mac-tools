/**
 * Files (访达-style) browser service: listings, previews, CRUD, trash,
 * compression, uploads, recents and the mocked macOS helpers.
 *
 * Every test works inside a fresh temporary directory and injects its own
 * Trash directory, so nothing here touches the real `~/.Trash` or user files.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { FileBrowser, FilesError } from '../src/files.js'

/**
 * Create a canonical temporary directory. The browser's state and Trash
 * directories live next to it (not inside it), so they never show up in a
 * listing and nothing touches the real `~/.Trash`.
 *
 * @returns {{ root: string, cleanup: () => void }} the directory and its removal.
 */
function makeRoot() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mac-tools-files-')))
  const root = join(base, 'root')
  mkdirSync(root)
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

/**
 * @param {string} root - test root created by {@link makeRoot}.
 * @returns {string} the browser state directory used by {@link makeBrowser}.
 */
function stateDirectoryFor(root) {
  return join(dirname(root), 'state')
}

/**
 * @param {string} root - test root created by {@link makeRoot}.
 * @returns {string} the browser Trash directory used by {@link makeBrowser}.
 */
function trashDirectoryFor(root) {
  return join(dirname(root), 'trash')
}

/**
 * Create a temporary directory outside the browser's roots.
 *
 * @returns {{ outside: string, cleanup: () => void }} the directory and its removal.
 */
function makeOutside() {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mac-tools-files-outside-')))
  return { outside, cleanup: () => rmSync(outside, { recursive: true, force: true }) }
}

/**
 * Build a browser whose roots and Trash live inside the test directory.
 *
 * @param {string} root - temporary test directory.
 * @param {object} [overrides] - constructor overrides.
 * @returns {FileBrowser} the browser.
 */
function makeBrowser(root, overrides = {}) {
  return new FileBrowser({
    stateDirectory: stateDirectoryFor(root),
    trashDirectory: trashDirectoryFor(root),
    readRoots: [root],
    writeRoots: [root],
    startDirectory: root,
    ...overrides,
  })
}

/**
 * Write a file, creating its parent directory.
 *
 * @param {string} path - file path.
 * @param {string | Buffer} [content] - bytes.
 * @returns {string} the path.
 */
function createFile(path, content = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

test('FilesError carries a stable code and structured details', () => {
  const failure = new FilesError('files_invalid_name', 'bad name', { path: '/tmp/x' })
  assert.ok(failure instanceof Error)
  assert.equal(failure.name, 'FilesError')
  assert.equal(failure.code, 'files_invalid_name')
  assert.deepEqual(failure.details, { path: '/tmp/x' })
  assert.throws(() => new FileBrowser({}), (thrown) => thrown.code === 'files_invalid_request')
})

test('places reports standard places, custom favorites and volumes', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const projects = join(root, 'projects')
    mkdirSync(projects)
    const browser = makeBrowser(root, { favorites: [projects, '~/dsh-mac-tools-missing-favorite'] })
    const places = await browser.places()
    assert.equal(places.startDirectory, root)
    const home = places.favorites.find((place) => place.id === 'home')
    assert.equal(home.path, homedir())
    assert.equal(home.name, 'Home')
    assert.deepEqual(places.favorites.filter((place) => place.id === 'custom'), [{ id: 'custom', name: 'projects', path: projects }])
    const placesPaths = places.favorites.map((place) => place.path)
    assert.equal(new Set(placesPaths).size, placesPaths.length, 'favorites are de-duplicated')
    assert.deepEqual(places.recents, [])
    assert.ok(places.volumes.length >= 1)
    const rootVolume = places.volumes.find((volume) => volume.isRoot)
    assert.equal(rootVolume.path, '/')
    assert.equal(typeof rootVolume.name, 'string')
    assert.ok(rootVolume.name.length > 0)
    assert.ok(rootVolume.totalBytes > 0)
    assert.ok(rootVolume.freeBytes >= 0 && rootVolume.freeBytes <= rootVolume.totalBytes)
    for (const volume of places.volumes) {
      assert.deepEqual(Object.keys(volume).sort(), ['freeBytes', 'isRoot', 'name', 'path', 'totalBytes'])
      assert.equal(typeof volume.isRoot, 'boolean')
      assert.equal(typeof volume.path, 'string')
    }
  } finally {
    cleanup()
  }
})

test('list returns directories first with full entry metadata', async () => {
  const { root, cleanup } = makeRoot()
  try {
    createFile(join(root, 'b.txt'), 'hello')
    createFile(join(root, 'a.png'), 'x')
    createFile(join(root, 'Zulu.bin'), '12345')
    createFile(join(root, '.secret'), 'hidden')
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, 'beta'))
    symlinkSync(join(root, 'b.txt'), join(root, 'link.txt'))
    symlinkSync(join(root, 'alpha'), join(root, 'linkdir'))
    const browser = makeBrowser(root)
    const result = await browser.list({ path: root })
    assert.equal(result.path, root)
    assert.equal(result.name, basename(root))
    assert.equal(result.parent, dirname(root))
    assert.equal(result.writable, true)
    assert.equal(result.system, false)
    assert.ok(result.totalBytes > 0)
    assert.ok(result.freeBytes > 0)
    assert.equal(result.total, 7)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.entries.map((entry) => entry.name), ['alpha', 'beta', 'linkdir', 'a.png', 'b.txt', 'link.txt', 'Zulu.bin'])
    const directory = result.entries[0]
    assert.equal(directory.kind, 'directory')
    assert.equal(directory.size, 0)
    assert.equal(directory.ext, '')
    assert.equal(directory.hidden, false)
    assert.equal(directory.path, join(root, 'alpha'))
    assert.equal(new Date(directory.mtime).toISOString(), directory.mtime)
    const fileEntry = result.entries.find((entry) => entry.name === 'b.txt')
    assert.equal(fileEntry.kind, 'file')
    assert.equal(fileEntry.size, 5)
    assert.equal(fileEntry.ext, 'txt')
    assert.equal(fileEntry.hidden, false)
    const link = result.entries.find((entry) => entry.name === 'link.txt')
    assert.equal(link.kind, 'symlink')
    assert.equal(link.linkTarget, join(root, 'b.txt'))
    assert.equal(link.directory, undefined)
    const directoryLink = result.entries.find((entry) => entry.name === 'linkdir')
    assert.equal(directoryLink.kind, 'symlink')
    assert.equal(directoryLink.directory, true)
    assert.equal((await makeBrowser(root, { showHidden: true }).list({ path: root })).total, 8)
    assert.equal((await browser.list({ path: root, showHidden: true })).total, 8)
    assert.equal((await makeBrowser(root, { showHidden: true }).list({ path: root, showHidden: false })).total, 7)
    const nested = await browser.list({ path: join(root, 'alpha') })
    assert.equal(nested.name, 'alpha')
    assert.deepEqual(nested.entries, [])
  } finally {
    cleanup()
  }
})

test('list sorts by size, mtime and kind in both directions', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const sized = join(root, 'sized')
    mkdirSync(sized)
    createFile(join(sized, 'small.txt'), 'a')
    createFile(join(sized, 'mid.txt'), '12345')
    createFile(join(sized, 'big.txt'), '1234567890')
    const stamp = (name, iso) => utimesSync(join(sized, name), new Date(iso), new Date(iso))
    stamp('small.txt', '2020-01-01T00:00:00Z')
    stamp('mid.txt', '2021-01-01T00:00:00Z')
    stamp('big.txt', '2022-01-01T00:00:00Z')
    const browser = makeBrowser(root)
    assert.deepEqual((await browser.list({ path: sized, sort: 'size' })).entries.map((entry) => entry.name), ['small.txt', 'mid.txt', 'big.txt'])
    assert.deepEqual((await browser.list({ path: sized, sort: 'size', order: 'desc' })).entries.map((entry) => entry.name), ['big.txt', 'mid.txt', 'small.txt'])
    assert.deepEqual((await browser.list({ path: sized, sort: 'mtime' })).entries.map((entry) => entry.name), ['small.txt', 'mid.txt', 'big.txt'])
    assert.deepEqual((await browser.list({ path: sized, sort: 'mtime', order: 'desc' })).entries.map((entry) => entry.name), ['big.txt', 'mid.txt', 'small.txt'])
    const kinds = join(root, 'kinds')
    mkdirSync(kinds)
    createFile(join(kinds, 'a.txt'), 'a')
    symlinkSync(join(kinds, 'a.txt'), join(kinds, 'b-link'))
    mkdirSync(join(kinds, 'zzz'))
    assert.deepEqual((await browser.list({ path: kinds, sort: 'kind' })).entries.map((entry) => entry.name), ['zzz', 'a.txt', 'b-link'])
    assert.deepEqual((await browser.list({ path: kinds, sort: 'kind', order: 'desc' })).entries.map((entry) => entry.name), ['zzz', 'b-link', 'a.txt'])
    assert.deepEqual((await browser.list({ path: sized, sort: 'bogus' })).entries.map((entry) => entry.name), ['big.txt', 'mid.txt', 'small.txt'], 'an unknown sort key falls back to name order')
  } finally {
    cleanup()
  }
})

test('readText previews text, truncates and reports lines', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const browser = makeBrowser(root)
    const note = createFile(join(root, 'note.txt'), 'hello\nworld\n')
    const preview = await browser.readText({ path: note })
    assert.equal(preview.text, 'hello\nworld\n')
    assert.equal(preview.name, 'note.txt')
    assert.equal(preview.bytes, 12)
    assert.equal(preview.truncated, false)
    assert.equal(preview.lines, 2)
    const long = createFile(join(root, 'long.txt'), 'abcdefghij')
    const truncated = await browser.readText({ path: long, maxBytes: 4 })
    assert.equal(truncated.text, 'abcd')
    assert.equal(truncated.bytes, 10)
    assert.equal(truncated.truncated, true)
    assert.equal(truncated.lines, 1)
    assert.equal((await browser.readText({ path: long, maxBytes: 0 })).text, 'a', 'maxBytes is clamped to at least one byte')
    assert.equal((await browser.readText({ path: long, maxBytes: 99_999_999 })).truncated, false, 'maxBytes is clamped to at most 1 MiB')
    const empty = createFile(join(root, 'empty.txt'), '')
    assert.deepEqual(await browser.readText({ path: empty }), { path: empty, name: 'empty.txt', text: '', bytes: 0, truncated: false, lines: 0 })
  } finally {
    cleanup()
  }
})

test('readText rejects binaries, directories and bad requests', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const browser = makeBrowser(root)
    const binary = join(root, 'binary.bin')
    writeFileSync(binary, Buffer.from([0x68, 0x00, 0x69]))
    await assert.rejects(() => browser.readText({ path: binary }), (failure) => {
      assert.equal(failure.code, 'files_binary')
      assert.equal(failure.details.path, binary)
      return true
    })
    await assert.rejects(() => browser.readText({ path: root }), (failure) => {
      assert.equal(failure.code, 'files_not_directory')
      assert.ok(failure.message.includes(root))
      assert.equal(failure.details.path, root)
      return true
    })
    await assert.rejects(() => browser.readText({ path: join(root, 'missing.txt') }), (failure) => failure.code === 'files_not_found')
    await assert.rejects(() => browser.readText({ path: `${root}/bad\u0000.txt` }), (failure) => {
      assert.equal(failure.code, 'files_invalid_request')
      assert.ok(failure.details.path.includes('\u0000'))
      return true
    })
  } finally {
    cleanup()
  }
})

test('previewFile serves raster images and refuses other formats', async () => {
  const { root, cleanup } = makeRoot()
  const outsideRoot = makeOutside()
  try {
    const browser = makeBrowser(root)
    const png = createFile(join(root, 'pic.PNG'), Buffer.from([1, 2, 3]))
    const preview = await browser.previewFile(png)
    assert.equal(preview.mime, 'image/png')
    assert.deepEqual(preview.buffer, Buffer.from([1, 2, 3]))
    const text = createFile(join(root, 'notes.txt'), 'hello')
    await assert.rejects(() => browser.previewFile(text), (failure) => failure.code === 'files_unsupported_preview')
    const outsideImage = createFile(join(outsideRoot.outside, 'outside.png'), 'x')
    await assert.rejects(() => browser.previewFile(outsideImage), (failure) => {
      assert.equal(failure.code, 'files_outside_roots')
      assert.equal(failure.details.path, outsideImage)
      return true
    })
  } finally {
    cleanup()
    outsideRoot.cleanup()
  }
})

test('thumbnail calls Quick Look once and then serves the cached PNG', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const source = createFile(join(root, 'photo.png'), 'fake image bytes')
    let calls = 0
    const run = async (command, args) => {
      calls += 1
      assert.equal(command, '/usr/bin/qlmanage')
      assert.deepEqual(args.slice(0, 2), ['-t', '-s'])
      assert.equal(args[3], '-o')
      const outputDirectory = args[4]
      assert.deepEqual(args.slice(5), [source])
      writeFileSync(join(outputDirectory, `${basename(source)}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      return { stdout: '', stderr: '', code: 0 }
    }
    const browser = makeBrowser(root, { run })
    const first = await browser.thumbnail({ path: source, size: 128 })
    assert.equal(first.mime, 'image/png')
    assert.deepEqual(first.buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    assert.equal(calls, 1)
    const key = createHash('sha1').update(`${source}:${statSync(source).mtimeMs}:128`).digest('hex')
    assert.deepEqual(readdirSync(join(stateDirectoryFor(root), 'thumbs')), [`${key}.png`])
    const second = await browser.thumbnail({ path: source, size: 128 })
    assert.deepEqual(second.buffer, first.buffer)
    assert.equal(calls, 1, 'the second request is served from the disk cache')
    await browser.thumbnail({ path: source, size: 256 })
    assert.equal(calls, 2, 'a different size has its own cache entry and runs the helper again')
  } finally {
    cleanup()
  }
})

test('thumbnail reports an unavailable Quick Look result', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const source = createFile(join(root, 'broken.png'), 'data')
    const browser = makeBrowser(root, {
      run: async () => {
        const failure = new Error('qlmanage failed')
        failure.code = 'process_failed'
        throw failure
      },
    })
    await assert.rejects(() => browser.thumbnail({ path: source }), (failure) => {
      assert.equal(failure.code, 'files_thumbnail_unavailable')
      assert.equal(failure.details.path, source)
      return true
    })
    await assert.rejects(() => browser.thumbnail({ path: join(root, 'missing.png') }), (failure) => failure.code === 'files_not_found')
  } finally {
    cleanup()
  }
})

test('createFolder creates one directory and refuses unusable names', async () => {
  const { root, cleanup } = makeRoot()
  const outsideRoot = makeOutside()
  try {
    const browser = makeBrowser(root)
    const created = await browser.createFolder({ path: root, name: '  New Folder  ' })
    assert.equal(created.name, 'New Folder')
    assert.equal(created.path, join(root, 'New Folder'))
    assert.equal(statSync(created.path).isDirectory(), true)
    await assert.rejects(() => browser.createFolder({ path: root, name: 'New Folder' }), (failure) => {
      assert.equal(failure.code, 'files_exists')
      assert.equal(failure.details.path, join(root, 'New Folder'))
      return true
    })
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', 'x'.repeat(256)]) {
      await assert.rejects(
        () => browser.createFolder({ path: root, name }),
        (failure) => failure.code === 'files_invalid_name',
        `the name ${JSON.stringify(name)} must be refused`,
      )
    }
    await assert.rejects(() => browser.createFolder({ path: outsideRoot.outside, name: 'nope' }), (failure) => {
      assert.equal(failure.code, 'files_outside_roots')
      assert.equal(failure.details.path, outsideRoot.outside)
      return true
    })
  } finally {
    cleanup()
    outsideRoot.cleanup()
  }
})

test('rename renames within the parent and refuses conflicts', async () => {
  const { root, cleanup } = makeRoot()
  const outsideRoot = makeOutside()
  try {
    const browser = makeBrowser(root)
    const source = createFile(join(root, 'old.txt'), 'content')
    createFile(join(root, 'taken.txt'), 'taken')
    const renamed = await browser.rename({ path: source, name: 'new.txt' })
    assert.deepEqual(renamed, { path: join(root, 'new.txt'), name: 'new.txt' })
    assert.equal(existsSync(source), false)
    assert.equal(readFileSync(renamed.path, 'utf8'), 'content')
    assert.deepEqual(await browser.rename({ path: renamed.path, name: 'new.txt' }), renamed, 'renaming to the same name is a no-op')
    await assert.rejects(() => browser.rename({ path: renamed.path, name: 'taken.txt' }), (failure) => failure.code === 'files_exists')
    await assert.rejects(() => browser.rename({ path: renamed.path, name: '../escape.txt' }), (failure) => failure.code === 'files_invalid_name')
    await assert.rejects(() => browser.rename({ path: join(root, 'missing.txt'), name: 'x.txt' }), (failure) => failure.code === 'files_not_found')
    const outside = createFile(join(outsideRoot.outside, 'outside.txt'), 'x')
    await assert.rejects(() => browser.rename({ path: outside, name: 'other.txt' }), (failure) => failure.code === 'files_outside_roots')
  } finally {
    cleanup()
    outsideRoot.cleanup()
  }
})

test('trash moves entries into the Trash with Finder-style collision names', async () => {
  const { root, cleanup } = makeRoot()
  const outsideRoot = makeOutside()
  try {
    const trashDirectory = trashDirectoryFor(root)
    createFile(join(trashDirectory, 'taken.txt'), 'already trashed')
    const first = createFile(join(root, 'taken.txt'), 'first')
    const second = createFile(join(root, 'note.txt'), 'second')
    const browser = makeBrowser(root)
    const result = await browser.trash({
      paths: [first, second, join(root, 'missing.txt'), join(outsideRoot.outside, 'outside.txt')],
    })
    assert.deepEqual(result.trashed, [
      { path: first, trashPath: join(trashDirectory, 'taken 2.txt') },
      { path: second, trashPath: join(trashDirectory, 'note.txt') },
    ])
    assert.equal(readFileSync(join(trashDirectory, 'taken 2.txt'), 'utf8'), 'first')
    assert.equal(readFileSync(join(trashDirectory, 'note.txt'), 'utf8'), 'second')
    assert.equal(readFileSync(join(trashDirectory, 'taken.txt'), 'utf8'), 'already trashed')
    assert.equal(existsSync(first), false)
    assert.equal(existsSync(second), false)
    const codes = new Map(result.failed.map((entry) => [entry.path, entry.code]))
    assert.equal(codes.get(join(root, 'missing.txt')), 'files_not_found')
    assert.equal(codes.get(join(outsideRoot.outside, 'outside.txt')), 'files_outside_roots')
    assert.equal(result.failed.length, 2)
    assert.ok(existsSync(join(trashDirectory, 'taken 2.txt')), 'nothing is deleted permanently')
    assert.ok(existsSync(join(trashDirectory, 'note.txt')))
    await assert.rejects(() => browser.trash({}), (failure) => failure.code === 'files_invalid_request')
  } finally {
    cleanup()
    outsideRoot.cleanup()
  }
})

test('compress invokes ditto with the Finder-compatible flags', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const first = createFile(join(root, 'one.txt'), 'one')
    const second = createFile(join(root, 'two.txt'), 'two')
    const calls = []
    const run = async (command, args, options) => {
      calls.push({ command, args, options })
      writeFileSync(args[args.length - 1], Buffer.from('zip-bytes'))
      return { stdout: '', stderr: '', code: 0 }
    }
    const browser = makeBrowser(root, { run })
    const result = await browser.compress({ paths: [first, second] })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, '/usr/bin/ditto')
    assert.deepEqual(calls[0].args, ['-c', '-k', '--sequesterRsrc', '--keepParent', first, second, join(root, 'one.txt.zip')])
    assert.equal(calls[0].options.timeoutMs, 600_000)
    assert.equal(result.path, join(root, 'one.txt.zip'))
    assert.equal(result.bytes, Buffer.byteLength('zip-bytes'))
    assert.ok(existsSync(result.path))
    assert.equal((await browser.compress({ paths: [first] })).path, join(root, 'one.txt 2.zip'), 'an existing archive gets a free suffix')
  } finally {
    cleanup()
  }
})

test('compress surfaces helper failures and outside-root paths', async () => {
  const { root, cleanup } = makeRoot()
  const outsideRoot = makeOutside()
  try {
    const source = createFile(join(root, 'one.txt'), 'one')
    const failing = makeBrowser(root, {
      run: async () => {
        const failure = new Error('ditto exploded')
        failure.code = 'process_failed'
        throw failure
      },
    })
    await assert.rejects(() => failing.compress({ paths: [source] }), (failure) => {
      assert.equal(failure.code, 'files_compress_failed')
      assert.match(failure.message, /ditto exploded/u)
      return true
    })
    assert.equal(existsSync(join(root, 'one.txt.zip')), false, 'a failed archive is removed')
    const browser = makeBrowser(root)
    const outside = createFile(join(outsideRoot.outside, 'outside.txt'), 'x')
    await assert.rejects(() => browser.compress({ paths: [outside] }), (failure) => failure.code === 'files_outside_roots')
    await assert.rejects(() => browser.compress({ paths: [] }), (failure) => failure.code === 'files_invalid_request')
  } finally {
    cleanup()
    outsideRoot.cleanup()
  }
})

test('drop saves base64 uploads with unique names', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const browser = makeBrowser(root)
    const result = await browser.drop({
      directory: root,
      files: [
        { name: 'note.txt', dataBase64: Buffer.from('first').toString('base64') },
        { name: 'note.txt', dataBase64: `data:text/plain;base64,${Buffer.from('second').toString('base64')}` },
        { name: 'new.txt', dataBase64: Buffer.from('third').toString('base64') },
        { name: '../../escape.txt', dataBase64: Buffer.from('fourth').toString('base64') },
      ],
    })
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.saved.map((entry) => entry.name), ['note.txt', 'note 2.txt', 'new.txt', 'escape.txt'])
    assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'first')
    assert.equal(readFileSync(join(root, 'note 2.txt'), 'utf8'), 'second')
    assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'third')
    assert.equal(readFileSync(join(root, 'escape.txt'), 'utf8'), 'fourth')
    assert.equal(result.saved[0].path, join(root, 'note.txt'))
    assert.equal(result.saved[0].bytes, 5)
    assert.equal(existsSync(join(dirname(root), 'escape.txt')), false, 'a traversal name stays inside the destination directory')
    await assert.rejects(() => browser.drop({ directory: root, files: 'nope' }), (failure) => failure.code === 'files_invalid_request')
  } finally {
    cleanup()
  }
})

test('drop reports invalid names and enforces the injected size limits', async () => {
  const { root, cleanup } = makeRoot()
  const outsideRoot = makeOutside()
  try {
    const browser = makeBrowser(root, { maxDropFileBytes: 8, maxDropTotalBytes: 100 })
    const result = await browser.drop({
      directory: root,
      files: [
        { name: '', dataBase64: Buffer.from('x').toString('base64') },
        { name: '..', dataBase64: Buffer.from('x').toString('base64') },
        { name: 'big.bin', dataBase64: Buffer.alloc(9, 1).toString('base64') },
        { name: 'ok.txt', dataBase64: Buffer.from('ok').toString('base64') },
      ],
    })
    assert.deepEqual(result.saved.map((entry) => entry.name), ['ok.txt'])
    assert.deepEqual(result.failed.map((entry) => entry.code), ['files_invalid_name', 'files_invalid_name', 'files_too_large'])
    assert.equal(existsSync(join(root, 'big.bin')), false)
    const totalBrowser = makeBrowser(root, { maxDropTotalBytes: 10 })
    await assert.rejects(() => totalBrowser.drop({
      directory: root,
      files: [
        { name: 'a.bin', dataBase64: Buffer.alloc(6).toString('base64') },
        { name: 'b.bin', dataBase64: Buffer.alloc(6).toString('base64') },
      ],
    }), (failure) => {
      assert.equal(failure.code, 'files_too_large')
      assert.equal(failure.details.path, root)
      return true
    })
    assert.equal(existsSync(join(root, 'a.bin')), false, 'the total limit is checked before anything is written')
    await assert.rejects(() => browser.drop({ directory: outsideRoot.outside, files: [] }), (failure) => failure.code === 'files_outside_roots')
  } finally {
    cleanup()
    outsideRoot.cleanup()
  }
})

test('reveal and open run /usr/bin/open with validated paths', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const file = createFile(join(root, 'a.txt'), 'a')
    const calls = []
    const run = async (command, args, options) => {
      calls.push({ command, args, options })
      return { stdout: '', stderr: '', code: 0 }
    }
    const browser = makeBrowser(root, { run })
    assert.deepEqual(await browser.reveal({ path: file }), { revealed: true, path: file })
    assert.deepEqual(await browser.open({ path: file }), { opened: true, path: file })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].command, '/usr/bin/open')
    assert.deepEqual(calls[0].args, ['-R', file])
    assert.deepEqual(calls[1].args, [file])
    assert.equal(calls[0].options.timeoutMs, 30_000)
    await assert.rejects(() => browser.open({ path: join(root, 'missing') }), (failure) => failure.code === 'files_not_found')
    const failing = makeBrowser(root, {
      run: async () => {
        throw new Error('open failed')
      },
    })
    await assert.rejects(() => failing.reveal({ path: file }), (failure) => failure.code === 'files_open_failed')
  } finally {
    cleanup()
  }
})

test('list reports the root volume and refuses non-directories', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const browser = makeBrowser(root, { readRoots: ['/'], writeRoots: [root] })
    const rootListing = await browser.list({ path: '/' })
    assert.equal(rootListing.path, '/')
    assert.equal(rootListing.name, '/')
    assert.equal(rootListing.parent, null)
    assert.equal(rootListing.system, true)
    assert.equal(rootListing.writable, false, 'the root volume is outside this browser write roots')
    assert.ok(rootListing.totalBytes > 0)
    const file = createFile(join(root, 'plain.txt'), 'x')
    await assert.rejects(() => browser.list({ path: file }), (failure) => failure.code === 'files_not_directory')
    await assert.rejects(() => browser.list({ path: join(root, 'missing') }), (failure) => failure.code === 'files_not_found')
    await assert.rejects(() => browser.list({ path: '\u0000bad' }), (failure) => failure.code === 'files_invalid_request')
    const defaultListing = await makeBrowser(root).list()
    assert.equal(defaultListing.path, root, 'an omitted path uses the start directory')
  } finally {
    cleanup()
  }
})

test('recents persist across instances, newest first and capped', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const directories = []
    for (let index = 0; index < 13; index += 1) {
      const directory = join(root, `dir-${String(index).padStart(2, '0')}`)
      mkdirSync(directory)
      directories.push(directory)
    }
    const first = makeBrowser(root)
    for (const directory of directories) await first.list({ path: directory })
    first.dispose()
    const reopened = makeBrowser(root)
    const places = await reopened.places()
    assert.equal(places.recents.length, 12)
    assert.equal(places.recents[0].path, directories[12])
    assert.equal(places.recents[0].name, 'dir-12')
    assert.equal(typeof places.recents[0].at, 'string')
    assert.ok(!places.recents.some((entry) => entry.path === directories[0]), 'the oldest visit is dropped')
    await reopened.list({ path: directories[0] })
    assert.equal((await makeBrowser(root).places()).recents[0].path, directories[0], 'revisiting a directory moves it to the top')
    assert.ok(existsSync(join(stateDirectoryFor(root), 'recent.json')))
    assert.ok(statSync(join(stateDirectoryFor(root), 'recent.json')).isFile())
  } finally {
    cleanup()
  }
})
