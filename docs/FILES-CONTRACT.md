# Files tab (访达-style) — Host/Client contract

> Scope: a fifth panel tab, id `files`, label **「文件」(zh) / "Files" (en)**,
> placed between the **Screenshot** tab and the **Calculator** tab. It is a
> Finder-style browser inside the DeepSeek Harness panel: view directories and
> files, preview them, and create / rename / move-to-trash / compress them
> without switching to Finder.
>
> This document is the single binding contract between the Host service
> (`src/files.js`), the plugin route (`src/route.js`), the panel UI
> (`client/index.js`) and the integration layer (`src/config.js`,
> `src/ops.js`, `src/index.js`). The three parts are written in parallel and
> must not invent different wire shapes. If the code and this file disagree,
> the Lead owns the resolution; do not change a shape unilaterally.

## 1. Purpose and non-goals

Finder is awkward for the small file-management steps that happen in the
middle of a panel workflow (preview a PDF, tuck a screenshot into a folder,
zip a few files, push one to the phone). The Files tab makes those steps
available inside the panel.

**In scope**

- Browse directories and files anywhere the panel's user can read, with a
  Places sidebar, breadcrumb toolbar, sorting, filtering and a preview pane.
- Create a folder, rename, drag files in from Finder, move to Trash, compress
  to `.zip`, reveal in Finder, open with the default app, and send files to
  the Phone tab's transfer service.
- A Finder-style preview pane: images inline, text/code up to 256 KiB, PDF
  first-page Quick Look thumbnail, everything else icon + metadata.

**Out of scope (non-goals)**

- **No permanent delete.** There is no "delete forever" operation anywhere on
  the wire. The only destructive-looking action moves an item into the user's
  own `~/.Trash`.
- **No arbitrary copy / move between folders.** The mutation set is exactly:
  mkdir, rename (same directory), trash, compress, plus Finder drag-in copies
  (`filesDrop`) and sending to the phone. There is no move-to-folder or
  copy-to-folder endpoint.
- **No copy fallback for trash.** A trash move that cannot be done with
  `rename(2)` (i.e. the item lives on another volume) is reported as
  `files_cross_device`, never silently copied across volumes.
- **No new permissions** (no Accessibility, no Automation/Finder scripting,
  no root) and **no new network listener**. The tab reuses the authenticated
  `/api/dsh-mac-tools` route; nothing is exposed to the LAN.
- **No model-facing tools.** This stays a panel-only plugin.

## 2. Data paths and ownership

### 2.1 Code ownership (who writes what)

| Role | Writes |
|---|---|
| Host service implementer | `src/files.js`, `test/files.test.js` |
| Panel UI implementer | `client/index.js`, `test/client.test.js` |
| Docs writer | `docs/FILES-CONTRACT.md`, `README.md`, `README.zh.md`, `locale/en.json` and `locale/zh.json` (meta only) |
| Lead (integration) | `src/config.js`, `src/ops.js`, `src/index.js`, `src/route.js`, `package.json`, `cordis.patch.yml`, `test/manifest.test.js`, `test/ops.test.js`, `test/route.test.js` |

Do not edit another role's files. Do not run `plugin_manager` and do not
restart DSH; the Lead installs and verifies the bundle.

### 2.2 State on disk

| Path | Contents | Written by | Notes |
|---|---|---|---|
| `<profile home>/dsh-mac-tools/files/recent.json` | `{ "version": 1, "entries": [{ "name", "path", "at" }] }`, newest first, **max 12** | Host, on every successful `filesList` | JSON, mode **0600**, tmp+rename atomic write; a missing/corrupt file loads as `[]`; an older bare-array or `{entries}` document is accepted |
| `<profile home>/dsh-mac-tools/files/thumbs/` | Quick Look PNG thumbnails, one `<sha1>.png` per (path, source `mtimeMs`, requested size) | Host, on `?thumb=` | cache only; safe to delete at any time, regenerated on demand |

`<profile home>` is the same plugin state directory that already holds
`hotkey.json`, `monitor/` and `transfer/` (for example
`~/.dsh/dsh-mac-tools/`). The `files/` directory is created with mode 0700 on
first use. Those two files are the **only** paths the Files tab owns: user
files are listed and read in place and are never copied into the plugin state
directory (thumbnails are the sole exception).

## 3. Configuration keys

Added to the row config (`src/config.js` schema, `cordis.patch.yml` comments
written by the Lead) and documented in both README tables.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `filesStartDirectory` | string | `''` | Directory the tab opens first, with `~` expanded. Empty means the user's home directory. A configured path that is not an existing directory falls back to the home directory (with a warning in the log). |
| `filesShowHidden` | boolean | `false` | Default visibility of hidden entries (dotfiles) in the listing. The panel keeps a per-view toggle on top of it and starts from the resolved value it receives as `showHidden` in `filesPlaces` (§5.1). |
| `filesFavorites` | array of strings | `[]` | Extra directories pinned after the standard places in the Places sidebar, with `~` expanded. Missing/invalid entries are skipped, never treated as an error; duplicates of a standard place are dropped. |

Defaults are part of `CONFIG_DEFAULTS`; the panel does not define its own
values for these keys — it adopts the resolved `filesPlaces.showHidden`.

## 4. Host service (`src/files.js`)

- ESM, JSDoc, `node:test`-friendly, dependency injection through the
  constructor. **No new npm dependency**: Node built-ins plus the plugin's own
  shared process runner.
- The integration constructs it as
  `new FileBrowser({ stateDirectory, favorites, startDirectory, showHidden, warn })`
  (see §4.1); the service derives the home directory, writable roots, Trash
  directory, volume list and clock, and accepts the sandbox seams (roots,
  runner, limits) through the constructor so the tests never touch the real
  `~/.Trash` or profile state. It reuses the plugin's shared process runner
  (`import { runProcess } from './capture.js'`, the default for the injectable
  `run` option, used for `/usr/bin/open`, `/usr/bin/ditto` and
  `/usr/bin/qlmanage`) and otherwise imports no project modules — **no new
  dependency**.
- macOS-only features (Quick Look thumbnails, mounted-volume enumeration,
  `~/.Trash`, LaunchServices open/reveal, system zip) sit behind the same
  platform gate the rest of the plugin uses (`process.platform === 'darwin'`).
  On another platform the Files endpoints answer the existing `unsupported`
  error code and the panel hides/disables the tab; the plugin itself is a
  macOS toolbox.
- Exposes `FilesError` plus the `FileBrowser` class the integration layer
  already constructs and wires (`src/index.js`):

```js
export class FilesError extends Error {
  // code: 'files_invalid_request' | 'files_outside_roots' | 'files_not_found'
  //     | 'files_not_directory' | 'files_binary' | 'files_exists'
  //     | 'files_invalid_name' | 'files_too_large'
  //     | 'files_unsupported_preview' | 'files_thumbnail_unavailable'
  //     | 'files_compress_failed' | 'files_permission_denied'
  //     | 'files_io_error' | 'files_open_failed' | 'files_trash_failed'
  // (`files_cross_device` appears only in the `failed[]` rows of trash();
  //  `files_failed`/`unsupported` are dispatcher-level, not thrown here.)
  constructor(code, message, details = {})
}

export class FileBrowser {
  // stateDirectory = <profile home>/dsh-mac-tools/files (§2.2)
  constructor({ stateDirectory, favorites = [], startDirectory = '', showHidden = false, warn = () => {} })

  places()                                  // filesPlaces
  list({ path, sort, order, showHidden })   // filesList
  readText({ path, maxBytes })              // filesRead
  createFolder({ path, name })              // filesMkdir (path = parent)
  rename({ path, name })                    // filesRename
  trash({ paths })                          // filesTrash
  compress({ paths })                       // filesCompress
  reveal({ path })                          // filesReveal
  open({ path })                            // filesOpen
  drop({ directory, files })                // filesDrop
  previewFile(path)                         // GET ?file=  → { buffer, mime }
  thumbnail({ path, size })                 // GET ?thumb= → { buffer, mime }
  dispose()                                 // drop caches/timers on row unload
}
```

`src/index.js` already imports `FileBrowser` and passes `previewFile` /
`thumbnail` to the route as `readFile` / `readThumbnail`; `src/ops.js` already
maps the class methods to the endpoints and forwards `FilesError` codes.
Unexpected I/O failures are mapped to the closest stable code above and never
escape as uncaught exceptions.

### 4.1 Constructor options

`src/index.js` passes exactly these; everything else has a default:

| Option | Meaning |
|---|---|
| `stateDirectory` | **Required**, `<plugin state>/files` — `recent.json` and `thumbs/` live here (§2.2); created with mode 0700. |
| `favorites` | resolved `filesFavorites` (`~` expansion is the service's job). |
| `startDirectory` | resolved `filesStartDirectory`; `''` means home. |
| `showHidden` | configured `filesShowHidden`; the resolved value is also returned by `filesPlaces` (§5.1). |
| `warn` | plugin logger for non-fatal failures. |

Optional options (defaulted; the tests inject the sandbox values):

| Option | Default | Meaning |
|---|---|---|
| `previewMaxBytes` | `262144` (256 KiB) | default text-preview budget; a caller may raise it up to 1 MiB |
| `readRoots` | `['/']` | roots browsing/preview may enter (reads "anywhere") |
| `writeRoots` | home + `/Volumes` | roots every mutation must stay inside (§8.2) |
| `trashDirectory` | `~/.Trash` | Trash destination; created on demand, never in the constructor |
| `run(command, args, opts)` | plugin process runner | runs `/usr/bin/qlmanage`, `/usr/bin/open`, `/usr/bin/ditto` |
| `maxDropFileBytes` | 128 MiB | largest single dropped file |
| `maxDropTotalBytes` | 256 MiB | largest dropped batch |

## 5. Endpoints

All endpoints ride the existing authenticated route on Connection's `/api`
channel:

```
POST /api/dsh-mac-tools   { "endpoint": "files…", "payload": { … } }
      → HTTP 200 { "ok": true, "value": { … } }
      → HTTP 200 { "ok": false, "error": { "code", "message", "details" } }
```

A refusal (bad path, outside roots, binary file, …) is an answer the panel
renders, so it stays HTTP 200 with the error envelope, exactly like the other
endpoint groups. Paths on the wire are absolute (`/Users/…`, `/Volumes/…`);
the Host expands a leading `~` defensively but the panel sends absolute paths.
All sizes are bytes; all timestamps are ISO 8601 strings.

| Endpoint | Payload | `value` |
|---|---|---|
| `filesPlaces` | `{}` | places (5.1) |
| `filesList` | `{ path, sort?, order?, showHidden? }` | listing (5.2) |
| `filesRead` | `{ path, maxBytes? }` | text preview (5.3) |
| `filesMkdir` | `{ path, name }` (`path` = parent directory) | new folder (5.4) |
| `filesRename` | `{ path, name }` | renamed item (5.4) |
| `filesTrash` | `{ paths: string[] }` | per-item result (5.5) |
| `filesCompress` | `{ paths: string[] }` | archive (5.6) |
| `filesReveal` | `{ path }` | `{ revealed: true, path }` (5.4) |
| `filesOpen` | `{ path }` | `{ opened: true, path }` (5.4) |
| `filesSend` | `{ paths: string[] }` | `{ items, count }` (5.7) |
| `filesDrop` | `{ directory, files: [{ name, dataBase64 }] }` | copies + failures (5.8) |

`payload` is always an object. `paths` is a non-empty array of strings (at most
**500** per call, trimmed by the dispatcher); dropped batches carry at most
**100** files. A malformed payload (missing `path`/`name`/`directory`, wrong
types, empty `paths`, non-object file items) is rejected by the dispatcher with
the existing `invalid_request` code. When the Files service was not mounted
(non-darwin, or its construction failed), every Files endpoint answers
`unsupported` and the panel disables the tab.

### 5.1 `filesPlaces` → places

No payload. Everything the sidebar needs in one answer:

```jsonc
{
  "startDirectory": "/Users/me",
  "showHidden": false,
  "favorites": [
    { "id": "custom", "name": "Projects", "path": "/Users/me/Projects" }
  ],
  "volumes": [
    { "name": "Macintosh HD", "path": "/", "totalBytes": 994662584320, "freeBytes": 301234567890, "isRoot": true },
    { "name": "Backup", "path": "/Volumes/Backup", "totalBytes": 2000398934016, "freeBytes": 512345678901, "isRoot": false }
  ],
  "recents": [
    { "name": "Downloads", "path": "/Users/me/Downloads", "at": "2026-10-25T01:12:00.000Z" }
  ]
}
```

- `startDirectory`: absolute canonical path from `filesStartDirectory`
  (default: home). The panel opens this directory on first mount.
- `showHidden`: the resolved `filesShowHidden` boolean. The panel adopts it as
  its initial toggle on first load; after that the panel sends its own
  `showHidden` on every `filesList`.
- `favorites`: the sidebar destinations — the existing standard places first
  (`id` = `home` / `desktop` / `documents` / `downloads` / `pictures` /
  `movies` / `music` / `applications`, `name` English, `path` absolute), then
  the configured `filesFavorites` as `{ id: "custom", name: <basename>,
  path }`. Missing standard places and unusable favorites are skipped;
  duplicates are removed by real path. The panel localizes the labels by `id`.
- `volumes`: the root volume (`isRoot: true`, `path: "/"`) plus every mounted
  volume under `/Volumes`; free/total capacity in bytes. The root volume is
  discovered through the usual `/Volumes/Macintosh HD → /` symlink (falling
  back to `/` itself) and keeps `path: "/"` with `isRoot: true`; other mounts
  report their path under `/Volumes`. The sidebar formats them; the value is
  never localized.
- `recents`: newest first, at most 12, read from `recent.json`. Recorded on
  every successful `filesList` (de-duplicated by path, so a refresh only
  bumps the timestamp); `at` is an ISO string.

### 5.2 `filesList` → listing

Payload:
`{ "path": "/Users/me/Documents", "sort": "name", "order": "asc", "showHidden": false }`
— `path` is **required** (the dispatcher rejects a missing/empty `path` with
`invalid_request`; the panel always sends it). `sort` is one of `name` /
`size` / `mtime` / `kind` (default `name`; `mtime` is the "modified" column),
`order` is `asc` / `desc` (default `asc`); unknown values fall back to the
defaults instead of failing. Directories always sort before files regardless
of the selector. `showHidden` is the panel's toggle; when the panel omits it
the configured `filesShowHidden` applies. When the effective value is `false`,
hidden entries are omitted and `total` counts the visible ones; when `true`,
they are included with `"hidden": true`.

```jsonc
{
  "path": "/Users/me/Documents",
  "name": "Documents",
  "parent": "/Users/me",
  "writable": true,
  "system": false,
  "freeBytes": 301234567890,
  "totalBytes": 994662584320,
  "entries": [
    {
      "name": "Report.pdf",
      "path": "/Users/me/Documents/Report.pdf",
      "kind": "file",
      "size": 182734,
      "mtime": "2026-10-24T09:31:12.000Z",
      "ext": "pdf",
      "hidden": false,
      "directory": false
    },
    {
      "name": "Shared",
      "path": "/Users/me/Documents/Shared",
      "kind": "directory",
      "size": 0,
      "mtime": "2026-10-23T17:04:41.000Z",
      "ext": "",
      "hidden": false,
      "directory": true,
      "linkTarget": "/Users/me/Shared"
    }
  ],
  "total": 2,
  "truncated": false
}
```

- `path` / `name` / `parent`: the resolved directory, its basename (`/` for the
  filesystem root) and its parent (`null` only for `/`; a volume mount point
  such as `/Volumes/Backup` reports `/Volumes`). The panel never concatenates
  raw strings to build a parent — it uses `parent`, so `..` and symlinks
  cannot walk it somewhere unexpected.
- `writable`: the directory's real path is inside one of the `writeRoots`
  (home directory or `/Volumes`); the panel enables mutating actions from it.
- `system`: the directory is an OS/system location — `/` itself or a path
  inside `/System`, `/Library`, `/Applications`, `/usr`. Advisory only: the
  panel disables the mutating menu items and shows a short note; the Host
  re-checks every call.
- `freeBytes` / `totalBytes`: capacity of the volume that contains `path`.
- `entries`: folders first, then sorted by the requested key (directories
  always stay before files). A directory is also anything a symlink points at
  (`kind: "symlink"` with `directory: true`). Every entry carries:
  - `name`: base name, never a path fragment.
  - `path`: absolute path (`join(directory, name)`).
  - `kind`: exactly one of `directory` (folder), `file` (regular file),
    `symlink` (symbolic link), `other` (fifo/socket/device or an unreadable
    entry). This is the Host token, not localized; the panel maps it through
    its `files.kind.*` dictionary and falls back to its generic file label.
    The richer families (image/pdf/text/…) are intentionally not part of the
    wire — see §11.1.
  - `size`: bytes; `0` for directories (not recursive) and unreadable entries.
  - `mtime`: last modification, ISO string (`""` for an unreadable entry).
  - `ext`: lowercase extension without the dot, `''` when none.
  - `hidden`: dotfile / hidden flag.
  - `directory`: true for directories and for symlinks that resolve to one.
  - `linkTarget`: only on symbolic links — the resolved absolute target
    (falling back to the raw `readlink` value); absent when it cannot be read.
    The panel marks links and disables mutations that would follow them out
    of the roots.
  - `error`: only when the entry's `lstat` failed during the listing —
    `{ code, message }` with the OS error. The row is still returned so the
    directory does not disappear from the UI.
- `total`: number of entries after the effective hidden filter, before the
  per-listing cap.
- `truncated`: `true` when the directory holds more than **5000** entries and
  `entries` was capped; the panel shows a "showing first N of total" note.

### 5.3 `filesRead` → text preview

Payload `{ "path": "/Users/me/notes.md", "maxBytes": 262144 }` — `maxBytes` is
optional and clamped to 1…1,048,576 bytes; the default budget is 256 KiB.
For the preview pane only; never used to write.

```jsonc
{
  "path": "/Users/me/notes.md",
  "name": "notes.md",
  "text": "# Notes\n…",
  "bytes": 512000,
  "truncated": true,
  "lines": 812
}
```

- Reads the first `maxBytes` of a regular file as UTF-8 text (a leading BOM is
  stripped). The preview pane's default budget is **256 KiB**.
  `truncated: true` when the file is larger than the budget; `bytes` is the
  **full on-disk size** (so the panel can show "first 256 KiB of 500 KiB");
  `lines` counts the lines in `text` (a trailing newline does not add an empty
  line).
- Binary content (a NUL byte in the first 8 KiB) answers `files_binary`; the
  panel shows the file icon and metadata instead.
- Errors: `files_not_found`, `files_not_directory` (a directory path — the
  panel uses `filesList` for directories), `files_invalid_request` (not a
  regular file), `files_binary`, `files_permission_denied`,
  `files_outside_roots`.

### 5.4 Mutations: mkdir / rename / reveal / open

**`filesMkdir`** — `{ "path": "/Users/me/Documents", "name": "Invoices" }`
→ `{ "path": "/Users/me/Documents/Invoices", "name": "Invoices" }`.
`path` is the **parent directory**; exactly one folder is created directly
inside it (no recursive create). Name rules (5.4.1). `files_exists` when the
name is taken.

**`filesRename`** — `{ "path": "/Users/me/Documents/a.txt", "name": "b.txt" }`
→ `{ "path": "/Users/me/Documents/b.txt", "name": "b.txt" }`.
Same-directory rename only; the extension may change; an existing target is
`files_exists`, never overwritten. Name rules (5.4.1).

**`filesReveal`** — `{ "path": "/Users/me/Documents/a.txt" }` →
`{ "revealed": true, "path": "…" }`. Uses `/usr/bin/open -R`
(LaunchServices), **not** AppleScript/Finder automation, so no Automation
permission is involved. Read-only action: allowed anywhere readable
(`readRoots`). Errors: `files_not_found`, `files_open_failed` (helper refused
or failed), `files_permission_denied`.

**`filesOpen`** — `{ "path": "/Users/me/Documents/a.txt" }` →
`{ "opened": true, "path": "…" }`. Opens with the default application via
`/usr/bin/open`; for a `.app` bundle it launches the app, for a directory it
opens it in Finder. Read-only action: allowed anywhere readable. Errors:
`files_not_found`, `files_open_failed`.

Neither action takes a snapshot or reads the file content; the Host only
checks that the path exists, then hands it to LaunchServices.

#### 5.4.1 Name validation (`filesMkdir` / `filesRename`)

The name is a **base name**, not a path. The Host trims it and then answers
`files_invalid_name` when it is empty, `.` or `..`, contains `/`, `\` or NUL,
or is longer than 255 characters. Leading dots are allowed (dotfile creation
is legitimate); other characters are accepted because the underlying
filesystem accepts them. Mutations still require the target location to be
inside a write root (§8.2).

### 5.5 `filesTrash` → move to Trash

Payload `{ "paths": ["/Users/me/Documents/a.txt", "/Users/me/Desktop/b"] }`.
Partial success is normal; the response reports each item:

```jsonc
{
  "trashed": [
    { "path": "/Users/me/Documents/a.txt", "trashPath": "/Users/me/.Trash/a.txt" },
    { "path": "/Users/me/Desktop/b", "trashPath": "/Users/me/.Trash/b 2" }
  ],
  "failed": [
    { "path": "/Volumes/USB/c.iso", "code": "files_cross_device", "message": "The item is on another volume; Trash cannot move it." }
  ]
}
```

- Destination is the user's own `~/.Trash` (inside the write roots); the
  plugin has no other delete path and never removes the item itself. The
  Trash directory is created on demand.
- **Finder-style collision renaming**, extension preserved:
  `a.txt` → `a 2.txt` → `a 3.txt`; a folder `b` → `b 2`. The chosen name is
  reported as `trashPath`.
- A cross-volume item (rename returns `EXDEV`) is reported as
  `files_cross_device` in `failed` **without any copy**; the item is left in
  place. Other per-item failures carry their own code (`files_outside_roots`,
  `files_not_found`, `files_permission_denied`, `files_trash_failed` when the
  Trash directory itself cannot be created, `files_io_error`).
- The dispatcher requires a non-empty `paths` array of at most 500 trimmed
  strings; empty or malformed `paths` is `invalid_request`. An empty array
  reaching the service would return `{ trashed: [], failed: [] }`.

### 5.6 `filesCompress` → zip

Payload `{ "paths": ["/Users/me/Documents/report.pdf"] }` →
`{ "path": "/Users/me/Documents/report.pdf.zip", "bytes": 91234 }`
— the archive name is always derived by the Host; the wire takes no name
override.

- The archive is created next to the **first** selected item; all sources are
  passed to `ditto -c -k --sequesterRsrc --keepParent` in one run, so one
  archive contains the whole selection. Mixed parent directories are allowed —
  the first item's directory decides where the archive lands.
- Default name: `<first item's base name>.zip`, including its extension (so
  `one.txt` becomes `one.txt.zip`, `report.pdf` becomes `report.pdf.zip`, a
  folder `Invoices` becomes `Invoices.zip`).
- A name collision is renamed Finder-style (`one.txt 2.zip`) rather than
  overwritten.
- The archive itself is a mutation: its directory must be inside a write root
  (`files_outside_roots`), and the source items must be readable.
- Zip failure (helper error/timeout, unreadable item, empty archive, archive
  not created) is `files_compress_failed`; a partially written archive is
  removed before the error is returned.

### 5.7 `filesSend` → send to the phone

Payload `{ "paths": ["/Users/me/Pictures/shot.png"] }`.

```jsonc
{
  "items": [
    { "id": "o-1a2b3c4d5e6f7a8b", "kind": "file", "name": "shot.png", "size": 182734, "mime": "image/png", "createdAt": "2026-10-25T01:20:00.000Z", "previewable": true, "path": "/Users/me/Pictures/shot.png" }
  ],
  "count": 1
}
```

- Reuses the existing Phone tab transfer service: each file is added to its
  outbox exactly as the Phone tab's own "add file" action would, so the file
  appears there immediately (see [`TRANSFER-CONTRACT.md`](TRANSFER-CONTRACT.md)
  §3.4/§5). The item shape is the transfer outbox item, unchanged.
- Works whether or not a phone session is currently active; the file is
  queued for the next session.
- A directory path, a missing file or a file above `transferMaxFileMB` fails
  the call with the transfer layer's code (`invalid_request`, `not_found`,
  `too_large`, `io_error`, `unsupported`). Items already queued before the
  failure stay in the outbox, so the panel reports the failure and still
  offers to open the Phone tab.
- If the Phone tab's transfer service is not mounted on this Host (for
  example a build without the LAN bridge), the endpoint answers
  `unsupported`; the panel shows that as an error toast instead of switching
  tabs.

### 5.8 `filesDrop` → copy files dragged in from Finder

Payload: the panel reads dropped `File` objects in the browser and sends them
base64-encoded:

```jsonc
{
  "directory": "/Users/me/Documents",
  "files": [
    { "name": "photo.jpg", "dataBase64": "/9j/4AAQ…" }
  ]
}
```

```jsonc
{
  "saved": [
    { "name": "photo.jpg", "path": "/Users/me/Documents/photo.jpg", "bytes": 182734 }
  ],
  "failed": [
    { "name": "huge.mov", "code": "files_too_large", "message": "File exceeds the drop limit." }
  ]
}
```

- `dataBase64` is plain base64 **or** a `data:` URL; the dispatcher also
  accepts `data` as an alias. At most **100** files per request.
- Destination is the current directory; it must be inside a write root
  (`files_outside_roots` otherwise).
- Upload names are reduced to a safe basename: the value is split on `/` and
  `\` and the last segment is used, control characters and `* ? " < > | :` are
  removed, then it is trimmed, capped at 255 characters keeping its extension,
  and a name that ends up empty/`.`/`..` is `files_invalid_name` for that
  item. Collisions are renamed Finder-style (`photo 2.jpg`), never overwritten.
- Each file is written atomically (a `.dsh-files-<hex>.tmp` sibling then
  rename); a failed item leaves no residue, and the whole request writes
  nothing if the batch exceeds the total limit.
- Limits: **128 MiB** per file, **256 MiB** per request (both constructor
  options). A file over its own limit fails that item with `files_too_large`;
  a batch over the total limit fails the whole request with `files_too_large`
  before anything is written.
- Directories in the dropped list (browser folder drops) arrive without data
  and fail that item with `files_invalid_request` rather than being recursed.
- Partial success is normal; the panel refreshes the listing afterwards and
  toasts a summary.

## 6. GET previews

Two **new GET parameters on the same route**, used only by the preview pane.
Both are same-origin, authenticated by the existing browser session cookie,
answer binary bytes on success, and are wired in `src/route.js` through the
`readFile` / `readThumbnail` dependencies (`FileBrowser.previewFile` and
`FileBrowser.thumbnail`).

Every success response carries exactly the headers the other image responses
already use:

```
content-type: <mime>            content-length: <bytes>
cache-control: no-store         content-disposition: inline
x-content-type-options: nosniff
content-security-policy: default-src 'none'; sandbox
```

Failures are **plain-text 4xx** (no JSON envelope, no path echoed back, so the
GET never leaks which check failed):

- `400` — the `file`/`thumb` parameter is missing or empty.
- `404` — the reader is not wired, or the Host refused/could not read the
  file. The Host-side stable reasons are `files_not_found` (missing,
  unreadable, permission denied), `files_unsupported_preview` (a `?file=`
  request for a non-raster type), `files_too_large` (a raster above 64 MiB)
  and `files_thumbnail_unavailable` (Quick Look failed); the panel treats any
  non-2xx as "preview unavailable" and falls back to the file icon (or the
  `?thumb=` path for raster files).

### 6.1 `?file=<absolute path>` — inline raster image

```
GET /api/dsh-mac-tools?file=%2FUsers%2Fme%2FPictures%2Fshot.png
```

- Streams the file inline **only** when its type is one of `png`, `jpeg`,
  `gif`, `webp`, `avif`, `bmp`, with the matching `Content-Type`. SVG, HTML
  and every other type are refused, so a crafted file can never execute in the
  Web UI origin; the panel uses `?thumb=` for everything else.
- The path must be absolute and a regular file; relative, missing or
  unreadable paths are refused as described above.
- Reads are allowed anywhere the panel's user can read, so this GET has no
  write-root restriction.
- The panel builds the URL as
  `${API_PATH}?file=${encodeURIComponent(path)}&t=${encodeURIComponent(mtime)}`
  so a changed file busts the image cache.

### 6.2 `?thumb=<absolute path>&size=<64..1024>` — Quick Look thumbnail

```
GET /api/dsh-mac-tools?thumb=%2FUsers%2Fme%2FDocuments%2FReport.pdf&size=512
```

- Returns a PNG (`image/png`) rendered by macOS Quick Look
  (`/usr/bin/qlmanage -t`), i.e. the first page for PDFs and the document
  preview for Office files, video posters, etc.
- `size` is the longest edge in pixels: an integer 64…1024, **default 512**
  (the panel asks for 640). The route forwards a positive number; the Host
  clamps it to that range and falls back to the default for a
  missing/non-numeric value.
- Used for **non-raster** files only: the panel prefers `?file=` for raster
  images and falls back to `?thumb=` for everything else (PDF, Office, video,
  …). A raster file works through either, but the panel does not need it.
- Successful PNGs are cached under `files/thumbs/` (§2.2) as
  `<sha1(path:mtimeMs:size)>.png` and reused until the source mtime or the
  requested `size` changes; a Quick Look failure (`qlmanage` wrote no image)
  is not cached and answers `files_thumbnail_unavailable`.

## 7. Error codes

Stable codes; the panel localizes them. `details` may carry the offending
path or a short hint and is never rendered raw.

| Code | Meaning |
|---|---|
| `files_invalid_request` | The service got an unsatisfiable request: empty/NUL path, a non-regular file for a text read, an upload that is not base64/has no data, a symbolic-link loop (`ELOOP`). |
| `files_outside_roots` | The path is outside `readRoots`/`writeRoots` (a mutation outside the home directory and `/Volumes`, or a read outside a custom read root). |
| `files_not_found` | `ENOENT`/`ENOTDIR`, or the path disappeared between listing and action. |
| `files_not_directory` | A directory was required (listing, mkdir parent, text read) but the path is not one. |
| `files_binary` | `filesRead` was asked for text but the content is binary (NUL byte in the first 8 KiB). |
| `files_exists` | The target name already exists (mkdir / rename; compress and drop auto-rename instead). |
| `files_invalid_name` | Empty, `.`, `..`, contains `/`, `\` or NUL, or longer than 255 characters. |
| `files_too_large` | A raster above 64 MiB, a dropped file above 128 MiB, or a dropped batch above 256 MiB. Text previews truncate instead of failing. |
| `files_unsupported_preview` | `?file=` was asked for a non-raster type (including SVG/HTML) or a non-regular file. |
| `files_thumbnail_unavailable` | Quick Look produced no image (or the cache could not be written). |
| `files_compress_failed` | `ditto` failed/timed out, the archive was not created, or it is empty. |
| `files_cross_device` | Appears **only inside `failed[]` rows of `filesTrash`**: the move would cross volumes (`EXDEV`), so the item is left in place. Reported, never copied. |
| `files_permission_denied` | The OS refused access (`EACCES`/`EPERM`, including a TCC folder denial). |
| `files_io_error` | Any other filesystem failure (e.g. `EIO`, `ENOSPC`), carrying the OS message. Reaches the panel as `files_failed`. |
| `files_open_failed` | `/usr/bin/open` refused or failed (`filesReveal` / `filesOpen`). Reaches the panel as `files_failed`. |
| `files_trash_failed` | The Trash directory could not be created, or another per-item trash failure. Reaches the panel as `files_failed`. |
| `unsupported` | The Files service is absent (non-darwin or failed to construct). Existing code, reused. |

Two dispatcher-level outcomes are added around the service:

- `invalid_request` — malformed payload (missing/empty `path`/`name`/
  `directory`, wrong types, empty `paths`, more than 500 paths, more than 100
  dropped files, a file item without name/data).
- `files_failed` — the dispatcher's generic bucket. `src/ops.js` forwards the
  `files_*` codes it knows verbatim (`files_permission_denied` included);
  `files_open_failed`, `files_io_error` and `files_trash_failed` are
  normalized to `files_failed`, with the original message and `details`
  preserved.

`files_not_file` is listed in the dispatcher's whitelist as a reserved code
but is never emitted by `src/files.js` (a directory where a regular file is
required answers `files_not_directory`).

The panel localizes the whole set plus `invalid_request`/`unsupported`, with a
generic fallback; `details` is never rendered raw.

## 8. Safety model

### 8.1 Reads: anywhere the user can read

`filesPlaces`, `filesList`, `filesRead`, the two GET previews and the
read-only `filesReveal`/`filesOpen` are not restricted to the write roots: the
service's `readRoots` defaults to `/`. (`files_outside_roots` can still appear
for reads when a test composes a narrower `readRoots`.) The route is already
authenticated and same-origin; nothing new is exposed to the phone listener or
the network. The Host still refuses symlink tricks that would turn a "read"
into a write (below).

### 8.2 Writes: home directory and mounted volumes only

Every mutation (mkdir, rename, trash, compress, drop) is validated against
two canonical roots:

1. the user's home directory (`os.homedir()`), and
2. every mounted volume under `/Volumes`.

Rules:

- Expand `~`, resolve the path, then canonicalise with `realpath` before the
  root check: for a directory the directory itself, for a rename/trash target
  the **parent** directory (which must already exist). The canonical value
  must be equal to or inside a root — this is what stops
  `/Users/me/link → /System/...` from becoming a write.
- Refuse with `files_outside_roots` instead of asking the OS and failing
  later; the panel's `system`/`writable` flags are only hints, the Host
  re-validates every call.
- The destination of a rename/trash/compress/drop is checked too — creating a
  file is a write at the parent directory.
- Root volume `/` is not a write root by itself (only `/Volumes/<name>`
  mount points and the home directory are).

### 8.3 Trash: never permanently delete

- Destructive UI says "move to Trash", and the Host implements exactly one
  delete-like operation: `rename(2)` into `~/.Trash`.
- Finder-style collision renaming keeps the extension: `name.ext` →
  `name 2.ext`, `name 3.ext`, …; extension-less names/folders get ` 2`
  appended.
- Cross-volume moves are not copied: they come back as `files_cross_device`
  and the item stays where it was. Restoring from the Trash is Finder's job;
  the plugin has no restore/untrash endpoint.
- The only files the Host ever deletes are its own temporary artifacts: a
  `.dsh-files-<hex>.tmp` upload that failed to rename into place, and a
  partially written archive after `files_compress_failed`. No user file is
  ever removed outright.

### 8.4 Permissions and network

- No Accessibility permission, no Automation/Finder scripting (no
  `osascript` for this tab), no root helper, no Full Disk Access request.
  `filesReveal`/`filesOpen` use LaunchServices via `/usr/bin/open`, Quick
  Look uses `/usr/bin/qlmanage`.
- macOS may show its standard file-access prompt for protected folders
  (Desktop, Documents, Downloads) the first time the app reads them; that is
  the OS's own grant, not a plugin permission, and it stops after the user
  allows it once. Errors from a denied access surface as the closest stable
  code (`files_invalid_request`/`files_not_found` with the OS message in
  `details`) and never crash the tab.
- No new HTTP listener, no outbound network, no clipboard writes except the
  explicit "copy path" action, which goes through the existing `clipboard`
  endpoint.

## 9. Client contract (`client/index.js`)

### 9.1 Registration

- `TABS` becomes `['screenshot', 'files', 'calculator', 'monitor', 'transfer']`
  — the Files tab sits between Screenshot and Calculator.
- Locale keys: `tab.files` → `文件` (zh) / `Files` (en); every label, menu
  item, empty state and error message for the tab exists in both dictionaries
  (`zh` and `en` must stay complete and parallel).
- Component `FilesTab({ store, snapshot, t, active })` follows the existing
  panel architecture: store + `useStoreSnapshot` + `React.createElement`, no
  JSX, no new `require`, no `document.body`. It polls/loads only while
  `active`; timers, listeners and `AbortController`s are cleaned up on
  deactivate/unmount.
- CSS is added to the existing `css` template, class prefix
  `dshMacToolsFiles…`, chrome colors from `--dsw-*` tokens only.

### 9.2 Layout

- **Places sidebar** (left): the standard places from `places.favorites`
  (Home, Desktop, Documents, Downloads, Pictures, Movies, Music,
  Applications) followed by the configured `filesFavorites`, mounted volumes
  with their free space, and recent folders. Clicking navigates.
- **Toolbar** (top): back / forward (panel-local history), up, a layout
  switcher (**list / icons / gallery**), a clickable breadcrumb path, a search
  box filtering the current directory by name (case-insensitive, non-recursive),
  a sort selector (`name` / `size` / `mtime` / `kind`, ascending/descending),
  a show-hidden toggle, and refresh.
- **Listing** (middle): rows show name (with a type glyph), size and
  modified — folders first. There is no separate Kind column: the type is the
  row glyph and is repeated in the preview. The whole Mac Tools panel is
  full-width: the shared content column's former 980 px centering cap is gone
  for every tab, so the Files tab is not a special case. Icons are larger than the other tabs' glyphs and colour-coded by
  kind: folders are a solid amber silhouette, files are outlined and tinted
  (image green, pdf red, text/code blue, audio/video brand, archive business,
  other caption).
- **Layout modes**: `list` is the row table above; `icons` renders
  auto-filling tiles (colour glyph, raster thumbnail overlay, two-line name,
  size) in the same item area; `gallery` replaces the item table and the right
  preview with one large preview (image / text / colour glyph) above a
  horizontal filmstrip of the folder. Selection, keyboard navigation, the
  context menu and drag-and-drop behave the same in every mode; the mode is
  session state (`files.view`), not persisted. Single click selects, ⌘-click
  toggles, Shift-click extends the range; double-click enters a folder or
  opens a file.
- **Preview pane** (right): image inline (via `?file=`), text/code via
  `filesRead` with a truncation banner at 256 KiB, PDF via `?thumb=` first
  page; other files show a Quick Look preview when one is available, plus
  metadata — full path, size, kind and modified time. (Created time and
  permissions are **not** shown: the listing entry carries no `ctime`/`mode`
  and the wire contract does not add them.) Directory selection shows a folder
  summary instead. Narrow layouts stack or collapse the sidebar/preview; the
  list must stay usable down to the panel's minimum width.

### 9.3 Actions

- **Action row** (always visible, above the item area): open, copy path,
  reveal in Finder, rename, compress to zip, send to phone, move to trash.
  The bar is rendered even with an empty selection (idle styling plus
  `files.status.none`); every button is `disabled` until at least one entry is
  selected, rename additionally requires exactly one entry, and move-to-trash
  also requires the directory to be writable. This keeps the actions
  discoverable instead of appearing only after a click.
- **Context menu** (row): open, reveal in Finder, copy path, copy name,
  rename, new folder, move to trash, compress to zip, send to phone. Mutating
  items are disabled when the current directory is not `writable`; the Host
  re-checks every call and a directory sent to the phone is refused by the
  transfer service with a toast.
- **Keyboard**: `↑`/`↓` move the selection, `Enter` opens (folder or file),
  `Backspace` or `⌘↑` goes to the parent folder, `Space` toggles the preview,
  `⌘C` copies the selected path(s) through the existing `clipboard` endpoint,
  `⌘⌫` asks for confirmation and moves the selection to the Trash. The status
  bar hint line mirrors this: "Double-click to open · Space to preview · ⌘C
  copies the path · ⌘⌫ moves to the Trash".
- **Drag from Finder**: dropping files onto the listing copies them into the
  current directory via `filesDrop` (base64), with an in-place progress state,
  then refreshes the listing and toasts saved/failed counts.
- **Send to phone**: `filesSend` adds the selected files to the transfer
  outbox and toasts that they are waiting in the Phone tab; the panel may
  switch to the Phone tab but must not start a session on its own.
- **Rename / new folder**: inline or dialog prompt; the Host's name rules
  (§5.4.1) are enforced, errors are localized, and the listing refreshes on
  success.
- Empty states (empty folder, no search hits, unreadable directory) and
  loading skeletons follow the existing panel style; every `error.code` from
  §7 has a localized message with a generic fallback (`hostErrorText` style).

## 10. Testing and definition of done

### 10.1 `test/files.test.js` (Host service)

`node:test` + `node:assert/strict`, no network, no real `~/.Trash`, no real
Quick Look. Instantiate the service against a `mkdtemp` sandbox with the
optional injected seams from §4.1 (`stateDirectory`, `favorites`,
`startDirectory`, `showHidden`, `trashDirectory`, `writeRoots`, `readRoots`,
`run`, `warn`, drop limits) and stubbed child processes. Cover at least:

- `filesPlaces`: start directory from config with home fallback, standard
  places plus configured favorites (duplicates skipped), volumes with
  `isRoot`, recents newest-first capped at 12.
- `filesList`: folders first, hidden filtering and `showHidden: true`,
  `total`/`truncated` (cap 5000), `parent` for `/` and `/Volumes/<name>`,
  `system` locations, `writable`, free/total bytes, symlink entries with
  `linkTarget`/`directory`, unreadable entry → `error` field, recents
  recorded on success.
- `filesRead`: UTF-8 text, default 256 KiB budget and 1 MiB clamp,
  `bytes` = full size, `truncated`, `lines`, binary → `files_binary`,
  directory → `files_not_directory`, missing → `files_not_found`,
  BOM stripped.
- Mutations: mkdir/rename success and collision (`files_exists`), name
  validation (`.`, `..`, `/`, `\`, NUL, 255-char cap), symlink escape
  (`files_outside_roots`), `files_not_directory`, read-only volume.
- Reveal/open: helper success values, helper failure → `files_open_failed`,
  missing path → `files_not_found`.
- Trash: collision rename preserving the extension, injected `EXDEV` →
  `files_cross_device` in `failed` and the file still present, partial success,
  Trash-directory creation failure → `files_trash_failed`.
- Compress: archive path/bytes, `<first base name>.zip` default, Finder-style
  collision, injected `ditto` failure → `files_compress_failed` with no
  partial archive, empty archive → `files_compress_failed`.
- Drop: sanitised names (separators/reserved chars stripped), Finder-style
  collision, base64 and `data:` URL payloads, decode failure → per-item
  `failed`, failed item leaves no residue, per-file 128 MiB / total 256 MiB
  caps, outside roots.
- Recent state: `{ version: 1, entries }` atomic write with mode 0600,
  12-entry cap, duplicate paths de-duplicated, corrupt file recovers to `[]`.
- Thumbnails: cache hit avoids a second Quick Look run, miss writes
  `<sha1>.png`, `qlmanage` producing nothing → `files_thumbnail_unavailable`,
  size clamped to 64…1024 (default 512).
- Every error carries a stable `code`; no uncaught rejection escapes.

Because `src/index.js` only mounts the browser on `darwin`, the
`unsupported` path is exercised at the dispatcher level (ops without a
service), not inside `FileBrowser`.

`package.json`'s `check` script already runs `node --check src/files.js` before
the test run.

### 10.2 Unchanged rules

- `test/manifest.test.js` stays green: locale metadata valid, exactly one
  host-plane row, **no model-facing tools registered**. This feature must not
  add `tools.register` or any model-facing tool.
- `test/client.test.js` gains the Files tab in its required tab/locale lists
  (UI implementer).
- `npm run check` (all `node --check` + `node --test test/`) must pass; the
  Panel-only and existing contract docs are otherwise unchanged.

## 11. Remaining notes

The spec left a few wire details open; the rows below record how the
delivered code resolves them and the one naming difference that stays.

1. **`kind` tokens: Host and panel differ in vocabulary.** `src/files.js`
   emits `directory` / `file` / `symlink` / `other`, while the panel's
   `files.kind.*` dictionary also offers `image`, `text`, `code`, `pdf`,
   `archive`, `audio`, `video` (the panel falls back to its generic file
   label for the Host tokens, so nothing breaks). The preview pane chooses its
   mode from `ext`, not `kind`, so the richer labels stay unused until the
   Host classifies files by extension.
2. **Response values not fixed by the spec.** Request payloads are fixed by
   `src/ops.js` (§5); the values for `filesMkdir`, `filesRename`,
   `filesReveal`, `filesOpen` and `filesSend`/`filesDrop` are specified here
   beyond the general envelope. Treat §5 as the contract; change it in one
   place if `src/files.js` changes a field name.
3. **GET error statuses** are fixed by `src/route.js`: plain-text `400` for a
   missing/empty parameter and plain-text `404` for every refusal or read
   failure (the Host's internal reasons stay
   `files_not_found`/`files_unsupported_preview`/`files_too_large`/`files_thumbnail_unavailable`).
   The panel must not expect a JSON envelope on these GETs.
4. **Host limits** are fixed in `src/files.js` / `src/ops.js`: listing cap
   5000 entries (with `truncated`), text preview 256 KiB default / 1 MiB
   absolute, dropped file 128 MiB, dropped batch 256 MiB, thumbnail 512
   default clamped to 64…1024, 500 `paths` per mutation call and 100 dropped
   files per request. The panel only reports `files_too_large` or falls back
   to the icon; it keeps its own request sizes well below these.
