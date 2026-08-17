# Agents.md

## Architecture

An ongoing migration is moving all business logic into `rust/`. Each app under `apps/` is a UI shell — it owns rendering, interaction, and platform-specific concerns, but never owns logic. The UI framework for any given app is a replaceable detail.

### `rust/`

The single source of truth for all non-UI code. Everything platform-agnostic belongs here: no components, no hooks, no framework imports.

### `apps/`

Each app is a frontend that calls into Rust. Logic is never duplicated between apps — only UI is, because each platform may use an entirely different framework and language to build it.

- `web/` — Next.js (Cloudflare / standalone deployment)
- `desktop/` — Tauri 2 shell that wraps the same Next.js app

Both apps render identical UI and call into the same `rust/` crates. The web build targets Cloudflare Workers via OpenNext; the desktop build targets Linux (`.deb` and `.rpm`) and Windows (NSIS `-setup.exe`) and uses a Next.js static export served from the Tauri webview.

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.

## Desktop (Tauri)

### Tauri runtime detection

Use `tauriAvailable()` from `apps/web/src/lib/tauri-runtime.ts` before touching any `__TAURI__` global or invoking a plugin command. Never assume the runtime exists — the same web bundle runs in both targets.

### Native integrations

When adding a feature that already has a browser fallback (file picker, save dialog, persistent storage), prefer the native path on desktop and keep the browser fallback for the web build. Wrap the choice behind the existing `tauri-runtime.ts` helpers rather than scattering `if (tauriAvailable())` checks.

### Bytes never travel as JSON

The desktop build exists to escape the browser's memory and storage ceilings, so nothing may move a media-sized payload through an ordinary IPC argument. Tauri serialises command arguments with `JSON.stringify`, which turns a `Uint8Array` into an array of numbers — a gigabyte of video becomes a billion JS numbers before Rust sees a byte.

- **Writing**: open a `TauriWriteStream` and write chunks. The typed array is passed as the *whole* payload so Tauri sends it as a raw body; scalars ride in headers. Never `blob.arrayBuffer()` a whole file to hand it over.
- **Reading**: don't. Media is served over the `asset:` protocol, which answers range requests straight off disk. `readMediaSourceBytes` exists for the few things that genuinely need every byte (decoding an audio track), and nothing else should use it.

### Media has no `File` on desktop

`MediaAsset.file` is optional. An asset loaded from disk carries `path` and `url` instead, and materialising a `File` for it would put the whole clip back in memory. Anything that decodes media takes a `MediaSourceRef` from `createMediaSource()` — see `apps/web/src/media/source.ts` — never a `File` directly.

### Exports stream

`SceneExporter` writes into a target, it doesn't collect a result. On desktop that target is a scratch file in the app cache, and the artifact is `{ kind: "path" }`; the UI moves the finished file to wherever the user asks. Adding a code path that buffers a whole export re-introduces the `ArrayBuffer` ceiling this replaced.

### Permissions

Capabilities live in `apps/desktop/src-tauri/capabilities/default.json`. Add a permission there whenever a new plugin command is invoked; Tauri 2 enforces this at runtime. Commands defined by the app itself (`native_fs.rs`) don't need an entry, so they carry their own path checks: streams may only be opened under the app's data and cache directories.

New paths the webview needs to *read* go in `assetProtocol.scope` in `tauri.conf.json`, as narrowly as possible. `tauri-plugin-fs` is intentionally not registered — see `apps/desktop/README.md`.

### Verifying a change

`BLUPER_SELFTEST=1 ./target/release/bluper-desktop` runs `/desktop-check` against the real modules and prints results to stdout. Add a check there for any new desktop-only path; it is the only place these paths are covered, since `bun test` has no Tauri runtime. Build with `bunx tauri build --no-bundle` — a plain `cargo build` produces a binary that still points at the dev server.

The self-check exercises the renderer through the prebuilt `rust/wasm/pkg`, which `tauri build` does **not** regenerate. After touching `rust/crates/*`, run `bun run build:wasm` first or the checks pass against stale WASM.

### Platform differences

Linux and Windows. Nothing platform-specific belongs in the UI: prefer a runtime probe over a compile-time or user-agent branch, because the same bundle ships to both webviews (WebKitGTK and WebView2) and to the browser. `supportsCanvasFilter()` is the pattern to copy — it draws a pixel and reads it back rather than trusting that a property exists.

- **Rust**: platform code is `#[cfg]`-gated with a `#[cfg(not(any(unix, windows)))]` fallback, and its dependency is target-gated in `Cargo.toml` so neither platform pulls the other's. `available_bytes` in `native_fs.rs` is the only such split.
- **Bundle targets**: set per platform — `deb` + `rpm` on Linux, `nsis` on Windows. Tauri filters requested targets against what the host can build, so a target list naming the wrong platform produces *no* installer rather than an error — see `apps/desktop/README.md`.
- **Origins differ**: Linux serves the app from `tauri://localhost` and Windows from `http://tauri.localhost`. Never hard-code either. Build asset URLs with `tauriConvertFileSrc()`, and if you add a check that inspects one, accept both forms.
- **Storage**: `OPFSAdapter.isSupported()` returns `false` whenever `tauriAvailable()` is `true` on *every* platform — media belongs on the real filesystem there, routed through `TauriMediaStore` (per-project directory under `AppData`). WebKitGTK's broken OPFS forced the decision; WebView2 having working OPFS does not reverse it.

Build-time system dependencies are Linux-only: WebViewGTK 4.1, libsoup-3.0, and javascriptcoregtk-4.1. Windows runners ship WebView2 already.


