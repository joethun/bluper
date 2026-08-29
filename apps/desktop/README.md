# `@bluper/desktop`

Tauri 2 wrapper around the existing Next.js web app. The WebView loads the
Next build at `devUrl` (development) or the static export in
`apps/web/out/` (production); no UI is duplicated.

## Run / build

From the repo root:

```bash
bun run build:wasm           # renderer — must run BEFORE bun install on a clean tree
bun install                  # one-time, picks up @bluper/desktop
bun run dev:desktop          # tauri dev — starts the Next dev server and opens the window
bun run build:desktop        # tauri build — installers in target/release/bundle/
bun run build:web            # only the Next static export (used by tauri build via beforeBuildCommand)
bun run check:desktop        # build without bundling, then run the self-check
```

`rust/wasm/pkg` is generated and never committed, and `bluper-wasm` is a `file:`
dependency on it — so on a fresh clone `bun install` has nothing to link until
`build:wasm` has run once. Every path that consumes the renderer rebuilds it
first anyway (`dev:web`, `build:web`, `check:desktop` all begin with
`bun run wasm`), so this ordering only matters the first time.

## Looking at the UI

There is no browser build, and a browser tab could not show media anyway — every
media path needs the Tauri runtime. So the UI is looked at in the shell itself.

`bun run dev:desktop` opens WebKit devtools automatically (debug builds call
`open_devtools()`), which covers working on a screen by hand.

For a screenshot, or for a screen that takes a dozen clicks to reach:

```bash
script/capture-window --route / --out projects.png
script/capture-window --route '/editor/_/?project=<uuid>' --settle 8
script/capture-window --eval 'document.querySelector("a[href*=\"/editor/\"]").click()' --settle 8
```

It opens the release shell on a route, runs the snippet once that page has
finished loading, waits for the picture to settle, and grabs the window. Two
env vars do the work and both are inert when unset, so nothing about this ships:

| Variable | Effect |
|---|---|
| `BLUPER_START_PATH` | Navigate to this route at startup instead of `/`. |
| `BLUPER_EVAL` | Run this snippet once `BLUPER_START_PATH`'s page has loaded. |

The window is forced onto XWayland (`GDK_BACKEND=x11`) because that is what lets
an X11 grab find it by name — KDE and GNOME both refuse a Wayland client to
anything except their own screenshot UI, which wants a human. The capture is a
real WebKitGTK frame, so what comes back is the actual decoded video, not a DOM
approximation.

Bundles land in the Cargo **workspace** target directory at the repo root —
`target/release/bundle/` — not under `apps/desktop/src-tauri/`, because the
crate is a workspace member.

`tauri dev` and `tauri build` both call `beforeDevCommand` / `beforeBuildCommand`
from `apps/desktop/src-tauri/tauri.conf.json`, which delegate to the workspace
scripts above via `apps/desktop/package.json`. `apps/web` has no other build:
`next.config.ts` sets `output: "export"` unconditionally, so `bun run build:web`
always produces `apps/web/out/` and nothing needs a flag to ask for it.

## Importing media

Media is referenced, not copied — the same model Premiere, Resolve and Avid
use. The project records where a file lives and reads it there, so importing a
40 GB card dump costs a probe and no disk, and two projects can cut the same
rushes without a second copy existing.

That needs a real path, and only two things produce one:

- the OS open dialog (`plugin:dialog|open`), and
- an OS drag-and-drop, which is why `dragDropEnabled` is **true** in
  `tauri.conf.json`.

An `<input type="file">` and an HTML `drop` both hand over a `File` whose bytes
the page can read but whose location it can never learn, so neither is used for
import any more. What still arrives that way is the clipboard, and it is the
one thing copied into the project's media store — see `media/processing.ts`,
which has a route for each.

> `dragDropEnabled: true` is what lets the shell report dropped paths, and on
> **Windows** it also stops HTML5 drag-and-drop working in the page. The bundle
> targets here are `deb` and `rpm`, where in-page dragging is unaffected; adding
> a Windows target means finding another way to drag clips within the timeline.

Two things follow from referencing rather than copying:

- **The asset protocol is scoped per file.** `assetProtocol.scope` covers only
  what the app writes itself, so each referenced file is granted by name as it
  is imported and again each time the project loads — `bluper_allow_media_file`
  in `native_fs.rs`. The grant lives in memory for the life of the process, and
  a directory glob wide enough to cover "wherever the user keeps video" would
  hand the webview most of the disk.
- **A file can go missing.** Removing an asset removes the project's record of
  it and never the file. A file that has moved leaves the asset *offline*: it
  keeps every piece of metadata recorded at import, so the timeline lays out
  exactly as before and only the pixels are absent, and `Relink media…` on the
  asset points it at a file again.

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
    ├── bluper.desktop                 # Handlebars desktop-entry template, shared by deb and rpm
    ├── icons/                         # Linux PNGs (32, 128, 128@2x, 512) + icon.ico for Windows
    └── src/
        ├── main.rs                    # calls bluper_desktop_lib::run()
        ├── lib.rs                     # tauri::Builder, plugin + command registration
        ├── native_fs.rs               # streaming write bridge, media store, asset-protocol grants
        ├── media_readers.rs           # LRU pool of open ffmpeg containers, shared by the modules below
        ├── media_decode.rs            # video demux — per-GOP scratch files the webview feeds to WebCodecs
        ├── media_frames.rs            # single-frame decode in Rust, for seeking and scrubbing
        ├── media_audio.rs             # audio decode — waveform peaks, and PCM written per channel
        └── mp4_export.rs              # the native encoder: RGBA frames + f32 audio in, a file out
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
| `bluper_stat_file` | Size and mtime of a referenced file, or `null` when it has moved — how an asset is found to be offline. |
| `bluper_allow_media_file` | Grants the asset protocol one referenced file by name, and returns the URL for it. |
| `bluper_diagnostic_log` | Prints a self-check result to stdout. |

Streams may only be opened inside the app's own data and cache directories.
The one path the webview can name freely is a `bluper_move_file` destination,
which is whatever the user picked in a native save dialog.

Media bytes never come back through IPC. They are served over Tauri's `asset:`
protocol, scoped in `tauri.conf.json` to `$APPDATA/projects/**`,
`$APPCACHE/exports/**`, `$APPCACHE/decode/**` and `$APPCACHE/audio/**`, plus
whatever `bluper_allow_media_file` has granted this run. It answers range
requests, so a `<video>` or a Mediabunny `UrlSource` pulls only the bytes it
needs — and it is also how the decode commands below return their output: they
write a scratch file and hand back its path.

## The media pipeline

Container parsing, seeking, audio decode and encoding all run in the shell. Only
the webview's forward-playback `VideoDecoder` still decodes in the page, because
that is the one case it is good at.

| Module | Commands | Why it is here |
|---|---|---|
| `media_readers.rs` | — | An LRU pool of open `ffmpeg` contexts shared by the three modules below. Reopening per request re-parsed the container header every time: 11 ms for a 7 MB clip, 44 ms for a 2.3 GB one, against 0.3–8 ms for the seek it was opened *for*. |
| `media_decode.rs` | `bluper_decode_video_gop`, `bluper_probe_media`, `bluper_media_thumbnail`, `bluper_clear_decode_cache` | Demux only — packets out, per-GOP scratch file in, no pixels cross back. The webview never has to ship a demuxer. |
| `media_frames.rs` | `bluper_decode_video_frame` | Single frames, for seeking and scrubbing. A `VideoDecoder` handed a 1,499-frame GOP spends ~700 ms catching up to the requested time; ffmpeg threads it across cores and does the same in ~125 ms, sending back one frame. |
| `media_audio.rs` | `bluper_audio_waveform_segment`, `bluper_audio_shape`, `bluper_decode_audio_window`, `bluper_decode_audio_pcm`, `bluper_release_audio_pcm` | Waveform peaks are folded here, so samples never cross IPC at all. Playback and mixing get one `f32` file per channel written to the cache and read over `asset:` — one per channel because `AudioBuffer.copyToChannel` wants a contiguous channel. |
| `mp4_export.rs` | `bluper_export_capabilities`, `bluper_export_start`, `bluper_export_write_frame`, `bluper_export_write_audio`, `bluper_export_finish`, `bluper_export_cancel` | The encoder. `MediaSink` lives in `editor-core` and links `ffmpeg-next`, which does not build for `wasm32`, so the desktop process is the only place it can run. Frames and audio arrive over the same raw-body bridge the write streams use. |

## Self-check

```bash
BLUPER_SELFTEST=1 ./target/release/bluper-desktop          # Linux
$env:BLUPER_SELFTEST=1; .\target\release\bluper-desktop.exe  # Windows
```

Each result also goes to the log file, which is the reliable place to read them
on Windows: release builds are compiled as a GUI subsystem binary, so
`attach_parent_console()` reattaches stdout to the launching terminal, but
piping to a file (`> out.txt`) works regardless.

Opens `/desktop-check/?autorun=1`, runs every check against the real modules,
and prints each result to stdout. There are around forty-five of them and they
cover the whole native path, not only storage:

- **Bytes** — binary IPC round trips, positioned writes, `asset:` range
  requests, the media store, moving a finished file into place, capacity read
  from the disk rather than a sandbox quota.
- **Decode** — frames straight off disk, playback continuing past a GOP
  boundary, backwards scrubbing landing on the right frame every step, idle
  decoders being retired, a decoder torn down under a reader failing as
  cancellation, and a long HD clip surviving a scrub.
- **Audio** — decoding sample-for-sample against the shell, waveform geometry
  while a wave is still filling, a stored waveform coming back the same shape,
  summarising without holding the whole track, and the path taken when
  WebCodecs refuses the codec outright.
- **Picture** — effects, chroma key, Adjust sliders, mask feathering, cropping,
  reduced render scale, compositing a clip's first decoded frame, the preview
  canvas holding its picture on a frame nothing renders, and Rust readback
  parity.
- **Export** — every container an export may pick actually encoding, an
  audio-only export having sound in it, and a clip exporting the right way up
  with unbroken audio.
- **Projects** — a project finishing its load, loaded assets reading through a
  URL rather than a `File`, and saving an asset whose bytes are gone being
  refused.

A run that stops reporting for 90 seconds is killed and fails: a check can take
the webview's process down rather than throwing, and without the watchdog the
shell would just sit there with a window nobody closes.

Open the same page from a running app to run them by hand.
`BLUPER_START_PATH=/some/route/` opens any other route the same way.

## Desktop-specific web behavior

`apps/web/src/lib/tauri-runtime.ts` exposes a `tauriAvailable()` runtime check
plus typed wrappers around everything the shell offers — the dialog and opener
plugins, the `native_fs` commands, the decode / audio / export commands, and the
`tauri://drag-*` window events.

- `apps/web/src/services/storage/tauri-media-store.ts` — media lives on the
  real filesystem. Writes stream in 8 MiB chunks over binary IPC; reads hand
  back a path and an `asset:` URL instead of a `File`, so a clip is never
  copied into the page.
- `apps/web/src/media/source.ts` — the one place that decides whether media is
  read from a `Blob` or a URL. Everything that decodes takes a
  `MediaSourceRef` rather than a `File`.
- `apps/web/src/media/native-drop.ts` — OS file drops, which arrive as window
  events rather than DOM ones because `dragDropEnabled` is on. The shell
  reports a position and knows nothing about what is under it, so panels
  register themselves and the point is hit-tested with
  `document.elementFromPoint`. In-page dragging — an asset tile onto the
  timeline — never leaves the webview and stays on the HTML drag events.
- `apps/web/src/media/processing.ts` — the import routes: a path is referenced,
  a pasted `File` is copied into the project's media store.
- `apps/web/src/services/renderer/scene-exporter.ts` — exports stream to a
  scratch file as they encode, muxed by the shell's `mp4_export.rs`, and produce
  `kind: "path"`, the only shape an `ExportArtifact` has. An export that cannot
  open its file fails; there is no `Blob` fallback to fall into.
- `apps/web/src/components/editor/export-button.tsx` — for `kind: "path"`,
  opens the native save dialog and moves the finished file. No bytes pass
  through the page.
- `apps/web/src/services/storage/quota.ts` — capacity comes from `statvfs`
  alone. `navigator.storage.estimate()` reports a WebView sandbox quota
  unrelated to where the files go, so it is not consulted at all.
- `apps/web/src/utils/browser.ts` — `downloadBlob` opens the save dialog and
  streams to the chosen path. An `<a download>` click is silently ignored in
  the WebView, so there is nothing else it could do.

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

`.github/workflows/desktop-release.yml` builds both platforms as a matrix —
`windows-latest` for the NSIS installer, `ubuntu-latest` for the `.deb` and
`.rpm`. Push a `v*` tag to attach installers to the release, or run the workflow
by hand from the Actions tab; either way the installers arrive as build
artifacts, and it also runs on PRs that touch the packaging path so a broken
bundle is found before a tag. The Windows runners already ship WebView2, so
Linux is the only leg with a system-dependency step.

To build on a Windows machine directly, install the MSVC build tools (the
"Desktop development with C++" workload), then from the repo root:

```powershell
.\script\setup-rust.ps1
rustup target add wasm32-unknown-unknown
bun run build:wasm
bun install
bun run build:desktop
```

### Linux `.AppImage`

The Linux bundle targets `.deb` and `.rpm`. To produce an `.AppImage` as well, add
`"appimage"` to `tauri.conf.json`'s `bundle.targets` and install both
`linuxdeploy` (extracted AppImage, available from GitHub) and `patchelf`
(`dnf install patchelf` on Fedora / `apt install patchelf` on Debian). Without
those, `tauri build` will fail at the AppImage step.

## Notes

- The `rust/` crates are consumed twice: as WASM by the webview (`rust/wasm`,
  which re-exports `editor-core`, `compositor`, `effects`, `gpu`, `masks` and
  `time`), and natively by this crate, which depends on `editor-core` directly
  so the waveform peak fold is literally the same function on both sides rather
  than two that are hoped to agree. The WASM half is fine for memory: the
  compositor imports `VideoFrame` and `OffscreenCanvas` handles directly into
  GPU textures, so pixel data never enters wasm linear memory and the module
  stays far below the wasm32 4 GB ceiling. What used to hit that ceiling was
  the export path holding a whole render in one `ArrayBuffer`, which no longer
  happens on desktop.
- `ffmpeg-next` is a native-only dependency. It does not build for
  `wasm32-unknown-unknown`, which is why demuxing, frame decode, audio decode
  and encoding all live in this crate rather than in `editor-core`'s wasm
  surface.
- Hard-loading `/editor/<id>/` falls back to the projects list, because the
  static export only emits one page for that dynamic route. Opening a project
  by clicking through works; deep links do not.
- `icons/icon.ico` is required on Windows — `tauri-build` refuses to build
  without it, since it embeds it as the executable's resource icon, and the NSIS
  installer uses it too. It carries 16/24/32/48/64/256px so Explorer and the
  taskbar each get a native size instead of a rescale.
- The window icon comes from a desktop entry on Wayland, not from the app.
  Wayland has no per-window icon, so `window.set_icon()` in `lib.rs` only lands
  under X11/XWayland and Windows; a Wayland compositor instead matches the
  toplevel's app_id — `bluper-desktop`, which GTK takes from the binary name —
  against `bluper-desktop.desktop` in the XDG data dirs and reads its `Icon=`.
  The `.deb` and `.rpm` install that entry alongside the hicolor PNGs, so
  packaged builds are already right. A bare `target/release/bluper-desktop`
  installs nothing and so gets the compositor's generic placeholder;
  `script/install-desktop-entry` puts the same pair in `~/.local/share`
  pointed at the built binary (`--uninstall` removes it). The entry's basename
  has to keep matching the app_id, which is why renaming `productName` would
  break the icon.
- Icons were generated with `tauri icon` from `icons/icon.png` (512px, the
  largest source in the repo). `bun run icons` regenerates from the 192px
  Android PNG instead, which is lower resolution than the current `icon.ico`.
  Prefer `bunx tauri icon src-tauri/icons/icon.png` from `apps/desktop`.
