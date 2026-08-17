# `@bluper/desktop`

Tauri 2 wrapper around the existing Next.js web app. The WebView loads the
Next build at `devUrl` (development) or the static export in
`apps/web/out/` (production); no UI is duplicated.

## Run / build

From the repo root:

```bash
bun install                  # one-time, picks up @bluper/desktop
bun run build:wasm           # renderer — must precede bun install on a clean tree
bun run dev:desktop          # tauri dev — starts the Next dev server and opens the window
bun run build:desktop        # tauri build — installers in target/release/bundle/
bun run build:web:export     # only the Next static export (used by tauri build via beforeBuildCommand)
```

Bundles land in the Cargo **workspace** target directory at the repo root —
`target/release/bundle/` — not under `apps/desktop/src-tauri/`, because the
crate is a workspace member.

`tauri dev` and `tauri build` both call `beforeDevCommand` / `beforeBuildCommand`
from `apps/desktop/src-tauri/tauri.conf.json`, which delegate to the workspace
scripts above via `apps/desktop/package.json`. The web build for desktop uses
`NEXT_OUTPUT=export`, which sets `output: "export"` and `images.unoptimized: true`
in `apps/web/next.config.ts` (the Cloudflare / standalone path is unaffected —
the env var defaults to the existing `standalone` output).

## Layout

```
apps/desktop/
├── package.json                       # tauri CLI + workspace delegation scripts
└── src-tauri/
    ├── Cargo.toml                     # rust crate, member of the root workspace
    ├── tauri.conf.json                # window, bundle, beforeDev/Build commands
    ├── build.rs                       # tauri_build::build()
    ├── capabilities/
    │   └── default.json               # plugin permissions for the editor window
    ├── icons/                         # Linux PNGs (32, 128, 128@2x, 512)
    └── src/
        ├── main.rs                    # calls bluper_desktop_lib::run()
        ├── lib.rs                     # tauri::Builder, plugin + command registration
        └── native_fs.rs               # streaming write bridge + filesystem media store
```

The Cargo workspace at the repo root includes `apps/desktop/src-tauri`.

## Plugins

`apps/desktop/src-tauri/src/lib.rs` registers:

| Plugin | Used by |
|---|---|
| `tauri-plugin-dialog` | Native save dialog on export. |
| `tauri-plugin-opener` | "Show in folder" action on the post-export toast. |
| `tauri-plugin-log` | Logs to stdout + the platform log directory (`~/.local/share/net.bluper.desktop/logs` on Linux, `%LOCALAPPDATA%\net.bluper.desktop\logs` on Windows). |

`tauri-plugin-fs` is deliberately **not** registered. Its `read_file` /
`write_file` commands serialise their payload as a JSON array of numbers, which
is exactly the memory ceiling this shell exists to remove; `native_fs.rs`
replaces them with commands that take a raw binary body. Dropping the plugin
also drops the `fs:scope-home-recursive` grant the app used to carry.

Each plugin's permissions live in
`apps/desktop/src-tauri/capabilities/default.json` (the source of truth — when
Tauri 2 ships it parses and validates against the schema in `gen/schemas/`).

## Native commands (`native_fs.rs`)

Everything that moves bytes lives here rather than in the webview.

| Command | Purpose |
|---|---|
| `bluper_media_path` | Resolve a file's path inside a project's media directory under `AppData`. |
| `bluper_list_media` / `bluper_remove_media` / `bluper_clear_media` / `bluper_media_size` | Manage stored media. |
| `bluper_open_write` / `bluper_write_chunk` / `bluper_close_write` / `bluper_abort_write` | A file held open across calls. `bluper_write_chunk` takes a raw `application/octet-stream` body and a `stream-id` header, plus an optional `stream-position` for the seek-back a muxer does when it finalises an MP4. |
| `bluper_scratch_path` / `bluper_move_file` / `bluper_remove_file` | Exports are written to the cache directory and moved to the user's chosen path once finished, so a cancelled render never leaves a partial file where a finished one was expected. |
| `bluper_available_disk_bytes` | Real free space on the volume holding the media directory — `statvfs`'s `f_bavail` on Unix, `GetDiskFreeSpaceExW`'s caller-available figure on Windows. |
| `bluper_diagnostic_log` | Prints a self-check result to stdout. |

Streams may only be opened inside the app's own data and cache directories.
The one path the webview can name freely is a `bluper_move_file` destination,
which is whatever the user picked in a native save dialog.

Reads don't use IPC at all: media is served over Tauri's `asset:` protocol,
scoped in `tauri.conf.json` to `$APPDATA/projects/**` and `$APPCACHE/exports/**`.
It answers range requests, so a `<video>` or a Mediabunny `UrlSource` pulls only
the bytes it needs.

## Self-check

```bash
BLUPER_SELFTEST=1 ./target/release/bluper-desktop          # Linux
$env:BLUPER_SELFTEST=1; .\target\release\bluper-desktop.exe  # Windows
```

Each result also goes to the log file, which is the reliable place to read them
on Windows: release builds are compiled as a GUI subsystem binary, so
`attach_parent_console()` reattaches stdout to the launching terminal, but
piping to a file (`> out.txt`) works regardless.

Opens `/desktop-check`, runs the storage checks against the real modules, and
prints each result to stdout — streaming writes, the media store, an export
that is muxed to disk and decoded back, disk-backed capacity, and the scene
graph. Open the same page from a running app to run them by hand.
`BLUPER_START_PATH=/some/route/` opens any other route the same way.

## Desktop-specific web behavior

`apps/web/src/lib/tauri-runtime.ts` exposes a `tauriAvailable()` runtime check
plus typed wrappers around the dialog / fs / opener plugin commands.

- `apps/web/src/services/storage/tauri-media-store.ts` — media lives on the
  real filesystem. Writes stream in 8 MiB chunks over binary IPC; reads hand
  back a path and an `asset:` URL instead of a `File`, so a clip is never
  copied into the page.
- `apps/web/src/media/source.ts` — the one place that decides whether media is
  read from a `Blob` or a URL. Everything that decodes takes a
  `MediaSourceRef` rather than a `File`.
- `apps/web/src/services/export/tauri-export-target.ts` — exports stream to a
  scratch file as they encode and produce `kind: "path"`. The browser path
  (OPFS + Service Worker) is unchanged.
- `apps/web/src/components/editor/export-button.tsx` — for `kind: "path"`,
  opens the native save dialog and moves the finished file. No bytes pass
  through the page.
- `apps/web/src/services/storage/quota.ts` — capacity comes from `statvfs`
  rather than `navigator.storage.estimate()`, which reports a WebView sandbox
  quota unrelated to where the files go.
- `apps/web/src/services/export/export-sw-bridge.ts` — refuses to register
  the export SW in the Tauri runtime (it would target a `tauri://` origin
  with no fallback scope).
- `apps/web/src/app/editor/[project_id]/page.tsx` — short-circuits the
  `registerExportServiceWorker()` call when `tauriAvailable()`.
- `apps/web/src/components/providers/web-only-scripts.tsx` — wraps
  Databuddy analytics and React Scan in a client component that returns
  null in the Tauri runtime.

## Platforms

Linux and Windows. `bundle.targets` is set per platform, because Tauri filters
the requested targets against the ones the host can actually produce — asking a
Windows runner for `deb` yields an empty target list and therefore no installer
at all, silently.

| Platform | Config | Targets | Output |
|---|---|---|---|
| Linux | `tauri.conf.json` | `deb`, `rpm` | `target/release/bundle/deb/bluper-desktop_<version>_amd64.deb`<br>`target/release/bundle/rpm/bluper-desktop-<version>-1.x86_64.rpm` |
| Windows | `tauri.windows.conf.json` | `nsis` | `target/release/bundle/nsis/Bluper_<version>_x64-setup.exe` |

Both Linux packages come off the same host and the same build. Tauri's `rpm`
target is built by a vendored Rust `rpm` crate rather than by shelling out to
`rpmbuild`, so it needs nothing installed that `deb` didn't already need —
which is why the Ubuntu CI runner grew no new setup step for it, and why a
Debian-family box can produce the `.rpm` too. `rpm.depends` mirrors `deb.depends`
(empty: WebKitGTK is resolved at runtime, not declared), and both share the
`bluper.desktop` Handlebars template, so the desktop entry is identical either
way.

Tauri merges `tauri.<platform>.conf.json` over `tauri.conf.json` automatically,
and arrays replace rather than concatenate — so the Windows file's `targets`
substitutes for the base `deb`, it doesn't add to it.

### Building for Windows

Tauri's bundler is host-only (it shells out to each platform's packaging tools),
so Windows installers must be built on Windows. There is **no supported
cross-compile path for the installer** — `cargo-xwin` can produce a bare `.exe`,
but the NSIS step cannot run off-host.

`.github/workflows/desktop-release.yml` does this on a `windows-latest` runner.
Push a `v*` tag to attach installers to the release, or run the workflow by hand
from the Actions tab; either way the installers arrive as build artifacts. The
Windows runners already ship WebView2, so no extra setup step is needed there.

To build on a Windows machine directly, install the MSVC build tools (the
"Desktop development with C++" workload), then from the repo root:

```powershell
.\script\setup-rust.ps1
rustup target add wasm32-unknown-unknown
bun install
bun run build:wasm
bun run build:desktop
```

### Linux `.AppImage`

The Linux bundle targets `.deb` and `.rpm`. To produce an `.AppImage` as well, add
`"appimage"` to `tauri.conf.json`'s `bundle.targets` and install both
`linuxdeploy` (extracted AppImage, available from GitHub) and `patchelf`
(`dnf install patchelf` on Fedora / `apt install patchelf` on Debian). Without
those, `tauri build` will fail at the AppImage step.

## Notes

- The `rust/` crates are still consumed by the web build as WASM in both
  targets. That is fine for memory: the compositor imports `VideoFrame` and
  `OffscreenCanvas` handles directly into GPU textures, so pixel data never
  enters wasm linear memory and the module stays far below the wasm32 4 GB
  ceiling. What used to hit that ceiling was the export path holding a whole
  render in one `ArrayBuffer`, which no longer happens on desktop.
- Hard-loading `/editor/<id>/` falls back to the projects list, because the
  static export only emits one page for that dynamic route. Opening a project
  by clicking through works; deep links do not.
- `icons/icon.ico` is required on Windows — `tauri-build` refuses to build
  without it, since it embeds it as the executable's resource icon, and the NSIS
  installer uses it too. It carries 16/24/32/48/64/256px so Explorer and the
  taskbar each get a native size instead of a rescale.
- Icons were generated with `tauri icon` from `icons/icon.png` (512px, the
  largest source in the repo). `bun run icons` regenerates from the 192px
  Android PNG instead, which is lower resolution than the current `icon.ico`.
  Prefer `bunx tauri icon src-tauri/icons/icon.png` from `apps/desktop`.
