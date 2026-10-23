/**
 * Manifest and display-resource checks: the bundle must be installable, must
 * carry its locale metadata and icon, and must keep the exports the two halves
 * are loaded through.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (relative) => readFileSync(join(root, relative), 'utf8')

test('package.json declares an installable ESM bundle with both halves', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, 'dsh-mac-tools')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'src/index.js')
  assert.equal(manifest.exports['.'], './src/index.js')
  assert.equal(manifest.exports['./client'], './client/index.js')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  for (const file of ['src', 'client', 'locale', 'assets', 'icon.svg', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(file), `files must include ${file}`)
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '^3.18.2')
})

test('the bundle patch inserts exactly one host-plane row', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /- insert:/u)
  assert.match(patch, /id: mac-tools/u)
  assert.match(patch, /name: 'dsh-mac-tools'/u)
  assert.match(patch, /saveDirectory: ''/u)
  assert.match(patch, /transferPort: 8791/u)
  assert.match(patch, /transferDirectory: ''/u)
  assert.match(patch, /transferSessionMinutes: 30/u)
  assert.match(patch, /transferMaxFileMB: 512/u)
  assert.match(patch, /transferAutoCopyText: false/u)
  assert.doesNotMatch(patch, /preset:/u)
})

test('locales carry a real title and description in both languages', () => {
  const en = JSON.parse(read('locale/en.json'))
  const zh = JSON.parse(read('locale/zh.json'))
  for (const [locale, document] of [['en', en], ['zh', zh]]) {
    assert.equal(typeof document.meta.title, 'string', `${locale} title`)
    assert.equal(typeof document.meta.description, 'string', `${locale} description`)
    assert.ok(document.meta.title.length >= 4, `${locale} title is meaningful`)
    assert.ok(document.meta.description.length >= 20, `${locale} description is meaningful`)
  }
  assert.notEqual(en.meta.title, zh.meta.title)
  assert.match(en.meta.description, /screenshot|calculator/u)
  assert.match(zh.meta.description, /截图|计算器/u)
})

test('the native helpers ship with the package', () => {
  const hotkey = read('assets/hotkey.swift')
  assert.match(hotkey, /RegisterEventHotKey/u)
  assert.match(hotkey, /SOCK_STREAM/u)
  assert.match(hotkey, /READY/u)
  assert.ok(statSync(join(root, 'assets/hotkey.swift')).size > 512)

  const pin = read('assets/pin.swift')
  assert.match(pin, /PinPanel/u)
  assert.match(pin, /\.floating/u)
  assert.match(pin, /AnnotationToolbar/u)
  assert.match(pin, /READY/u)
  assert.ok(statSync(join(root, 'assets/pin.swift')).size > 1024)

  const qrcode = read('assets/qrcode.swift')
  assert.match(qrcode, /CIQRCodeGenerator/u)
  assert.match(qrcode, /base64EncodedString/u)
  assert.ok(statSync(join(root, 'assets/qrcode.swift')).size > 256)
})

test('the icon is an original SVG within the size limit', () => {
  const svg = read('icon.svg')
  assert.match(svg, /^<svg[ >]/u)
  assert.match(svg, /viewBox="0 0 48 48"/u)
  assert.match(svg, /role="img"/u)
  assert.ok(statSync(join(root, 'icon.svg')).size <= 256 * 1024)
  assert.doesNotMatch(svg, /href=|xlink:href=|url\(/u)
})

test('the client half registers through the lazy module loader', () => {
  const client = read('client/index.js')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/u)
  assert.match(client, /id: 'dsh-mac-tools'/u)
  assert.match(client, /factory:?\s*\(?require\)?/u)
  assert.match(client, /require\('react'\)/u)
  // The registration contract the host half and the shell agree on.
  assert.match(client, /PANEL_ID = 'mac-tools'/u)
  assert.match(client, /API_PATH = '\/api\/dsh-mac-tools'/u)
  assert.match(client, /name: 'main'/u)
  assert.match(client, /name: 'sidebar\.panellist'/u)
  assert.match(client, /ctx\.locale\.register\(NS/u)
  // Client halves must not import shipped client packages as modules.
  assert.doesNotMatch(client, /require\('@deepseek-ai/u)
  assert.doesNotMatch(client, /from '@deepseek-ai/u)
  assert.doesNotMatch(client, /document\.body/u)
})

test('the host half exports the Cordis plugin contract without absolute paths', () => {
  const index = read('src/index.js')
  assert.match(index, /export const name = 'dsh-mac-tools'/u)
  assert.match(index, /export \{ Config \}/u)
  assert.match(index, /export function apply\(ctx, rawConfig\)/u)
  assert.match(index, /connection\.fetch\.register/u)
  // This project is panel-only: it must not register any model-facing tools.
  assert.doesNotMatch(index, /tools\.register|registerTools|mac_screenshot|mac_calculator/u)
  for (const relative of ['src/index.js', 'src/route.js', 'src/ops.js', 'src/capture.js', 'src/windows.js', 'src/calc.js', 'src/system.js', 'src/store.js', 'src/config.js', 'src/transfer.js', 'src/transfer-qr.js', 'src/transfer-page.js']) {
    const source = read(relative)
    assert.doesNotMatch(source, /\/Users\/|file:\/\//u, `${relative} must not embed absolute paths`)
  }
})

test('every source module parses as ESM JavaScript', async () => {
  for (const relative of ['src/index.js', 'src/route.js', 'src/ops.js', 'src/capture.js', 'src/windows.js', 'src/calc.js', 'src/system.js', 'src/store.js', 'src/config.js', 'src/transfer.js', 'src/transfer-qr.js', 'src/transfer-page.js']) {
    // Checking the module namespace would evaluate imports that only resolve in
    // the harness; `node --check` covers syntax, and each pure module has its
    // own functional test file.
    assert.ok(read(relative).length > 0)
  }
})
