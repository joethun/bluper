# Agents.md

## Architecture

An ongoing migration is moving all business logic into `rust/`. Each app under `apps/` is a UI shell — it owns rendering, interaction, and platform-specific concerns, but never owns logic. The UI framework for any given app is a replaceable detail.

### `rust/`

The single source of truth for all non-UI code. Everything platform-agnostic belongs here: no components, no hooks, no framework imports.

### `apps/`

Each app is a frontend that calls into Rust. Logic is never duplicated between apps — only UI is, because each platform may use an entirely different framework and language to build it.

- `web/` — Next.js UI. Not a deployment target of its own: it exists to be statically exported into the shell.
- `desktop/` — Tauri 2 shell that wraps it

There is exactly one build. `desktop/` targets Linux (`.deb` and `.rpm`) and Windows (NSIS `-setup.exe`), and serves the Next.js static export in `apps/web/out/` from the Tauri webview. Nothing is hosted: no server, no `next start`, no Cloudflare/OpenNext, no image, no route handlers, no SEO surface. `next dev` exists only as the shell's `devUrl` — don't add anything that needs a server behind it.

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.

## Desktop (Tauri)

### Tauri runtime detection

Use `tauriAvailable()` from `apps/web/src/lib/tauri-runtime.ts` before touching any `__TAURI__` global or invoking a plugin command. It is no longer a fork in the road — nothing answers `false` and still works — but it is still the honest guard for code that runs where the runtime is absent: the export's prerender pass, which renders every page with no `window` at all, and a plain browser tab on `next dev`, which now loads the editor and fails the moment it needs storage.

### Native integrations

There is one path and it is the native one. The browser fallbacks that used to sit beside it are gone: no OPFS media store, no service-worker export delivery, no `<a download>`, no `navigator.storage` quota, no in-memory `Blob` collector behind the streaming exporter. Do not reintroduce one as a safety net — a fallback that buffers a render or writes media under an origin quota is the ceiling this shell exists to remove, and it will be found by a user with a two-hour timeline rather than by a test. When a native call fails, fail the operation and say so. Reach for the runtime through the `tauri-runtime.ts` helpers rather than scattering `if (tauriAvailable())` checks.

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

`script/capture-window` screenshots the running shell — `--route` to open a screen, `--eval` to drive it into the state you want. That is how a UI change gets *looked* at: `tsc` and `next build` both pass on a layout that renders wrong, and there is no browser build to open instead. It drives the real window, so what it captures is the real media pipeline.

The self-check exercises the renderer through the prebuilt `rust/wasm/pkg`, which `tauri build` does **not** regenerate. Every path that consumes it now rebuilds it first: `bun run check:desktop`, `bun run build:web` (which is also tauri's `beforeBuildCommand`) and `bun run dev:web` all begin with `bun run wasm`. That is a turbo task keyed on `rust/crates/**` and `rust/wasm/src/**`, so it is a ~20 ms cache hit when the Rust has not changed and a ~35 s rebuild when it has — don't route around it with a bare `wasm-pack` call, because `node_modules/bluper-wasm` is a *copy*, not a symlink, and only the `bun install` inside `build:wasm` refreshes it.

`bun test` cannot initialise the bundler-target wasm. Tests reach real Rust through `bluper-wasm-native` — the nodejs-target build of the same crate, produced by `bun run wasm:test` and wired up as a `tsconfig` path. Use `bun run test:web`, which builds it first. The shipped bundler artifact stays covered by `/desktop-check`.

To let a module under test use `@/wasm` for real, mock the **package**, never the façade:

```ts
import * as wasmNative from "bluper-wasm-native";
mock.module("bluper-wasm", () => wasmNative);
```

`mock.module` is process-global in bun and persists across files for the whole run, so stubbing `@/wasm` itself leaves every later test file holding a partial façade, failing on whichever export it happens to need — and the failure surfaces in the *other* file, which makes it hard to place. Mocking the package keeps the real façade, brands and invariant checks included.

### Porting logic to Rust

`rust/crates/editor-core` is the destination for domain logic (`model`, `project`, `commands`, `params`, `animation`). It is named `editor-core`, not `core`: a local crate called `core` shadows Rust's built-in `core` in the extern prelude of every dependent crate, which makes `::core::mem` and friends unreachable there.

What crosses matters as much as what moves. A module is ready for Rust when its payload is small and its callers are user-paced; it is *not* ready while its cost model depends on caching JS object identity. `animation/interpolation.ts` is the standing example: `normalizeScalarChannel` memoises on a `WeakMap` keyed by the channel object, and `rendering/animation-values.ts` reads six or more animated properties per element per frame. Moving the evaluator now would serialise a whole channel per read on the path `perf::record("wasm.deserialize", …)` already exists to watch — so it waits until Rust owns the channel and there is nothing to serialise. `adjustments/clip.ts` has the same `WeakMap` shape and the same answer. `animation/curve_bridge` moved instead: same maths, but two keys per call and only while someone is dragging a curve.

That claim about `interpolation.ts` was measured, not argued. The Rust evaluator exists, in `editor-core::animation::interpolation`, and it is bit-exact against the TypeScript over 6,000 generated channels. It is still not what runs, because crossing the boundary per read costs this, at 120 reads per frame:

| keys per channel | TypeScript | Rust across the boundary |
|---|---|---|
| 3 | 0.35 ms/frame | 1.70 ms/frame |
| 10 | 0.40 ms/frame | 4.31 ms/frame |
| 30 | 0.40 ms/frame | 11.73 ms/frame |

TypeScript stays flat because the `WeakMap` normalises once per channel and reads bisect. Rust grows with the key count because every call re-serialises the channel *and* re-normalises it — it has no stable identity to cache against. At 30 keys that is 70% of a 16.6 ms frame. The code is not the problem; the boundary is, and it stops being one when Rust owns the channel and there is nothing to send.

The two implementations are held equal by `interpolation-parity.test.ts` in the meantime. That test is the whole reason keeping both is safe: delete it and they drift.

Two more things block a port, both found the same way — by reading before writing:

- **Behaviour stored as data.** `ParamChannelLayout` in `apps/web/src/params/index.ts` carries `decompose`/`compose` closures. Functions do not serialise, so `getParamChannelLayout` cannot cross until the layout is redescribed as a discriminant Rust can switch on rather than a pair of callbacks.
- **`toFixed` is not round-half-even.** `snapToStep` in `apps/web/src/utils/math.ts` ends with `Number(x.toFixed(digits))`. JavaScript rounds an exact tie away from zero; Rust's `{:.N}` and most other languages round half to even. `(0.5).toFixed(0)` is `"1"` in JS and `"0"` under half-even, and `(0.125).toFixed(2)` is `"0.13"` against `"0.12"`. Anything ported through this needs the JS rule written out and pinned by a parity case on exact binary ties, not a `format!` call.

Validation at the storage boundary lives in `editor-core::project`. Two rules it establishes, both worth keeping:

- **Defects are a typed enum, not a string.** A rejected project is an expected outcome, and the caller has to tell "written by another build" from "the frame rate has no exact frame boundaries". `describeProjectDefect` in `apps/web/src/wasm/project.ts` switches exhaustively, so adding a Rust variant regenerates the type and breaks the switch — which is the reminder to write the sentence.
- **Severity is part of the model.** `DefectSeverity::Tolerated` exists because the editor already repairs several things a naive validator would refuse: `ensureMainScene` prepends a missing main scene (covering an empty scene list too) and `initializeScenes` falls back when `currentSceneId` names nothing. Refusing those would lose a project the editor fixes by itself, which is worse than the missing validation it replaced. Only `Fatal` stops a load.

Two boundary traps have already cost a full green test run each:

- **`rust/wasm/src/wasm.rs` is not decoration.** The `pub use editor_core::<module>::*;` lines are what put a module's `#[export]` bindings on the wasm crate's public surface, which is where `wasm-bindgen`'s glue generation looks. Drop a module from that file and every function it exports silently disappears from the built package — the Rust still compiles, the Rust tests still pass, and the failure surfaces as `Module '"bluper-wasm"' has no exported member` across dozens of unrelated files. Adding a module to `editor-core` means adding it there too.
- **A struct that serialises as a map arrives in JavaScript as a `Map`.** `#[serde(flatten)]` and `HashMap` both go through `serialize_map`, and `serde_wasm_bindgen` renders that as a real `Map`, whose `.duration` is `undefined`. `tsify_next`'s `hashmap_as_object` is off by default, so **every** container attribute needs it spelled out: `tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)`. Field-level `tsify(...)` accepts only `type` and `optional`, so the attribute has to go on the container. The same category bites `Vec<f64>`, which crosses as an object with numeric keys — use a named struct instead. Rust tests cannot catch either, because `serde_json` keeps a map a map; `apps/web/src/wasm/__tests__/boundary-shape.test.ts` is the guard, and every new return shape belongs in it.

A generated name collides silently, too. Two `#[export]` option structs called `TrackOptions` in different modules emit two `export interface TrackOptions` blocks into one `.d.ts`; TypeScript merges same-shaped interfaces without complaint and starts lying the moment they differ. `grep -o "^export interface [A-Za-z]*" rust/wasm/pkg/bluper_wasm.d.ts | sort | uniq -d` should print nothing.

While a module is being ported, both implementations exist. Assert they agree with `findParityMismatch` from `@/testing/parity` — seeded generation, so a failure replays from the seed it reports — and delete the TypeScript only once parity holds. `equalsExact` is the default because the failure mode worth catching is numeric drift, which every "does it run" check in this repo passes.

### Platform differences

Linux and Windows. Nothing platform-specific belongs in the UI: prefer a runtime probe over a compile-time or user-agent branch, because the same bundle ships to both webviews (WebKitGTK and WebView2) and to the browser. `supportsCanvasFilter()` is the pattern to copy — it draws a pixel and reads it back rather than trusting that a property exists.

- **Rust**: platform code is `#[cfg]`-gated with a `#[cfg(not(any(unix, windows)))]` fallback, and its dependency is target-gated in `Cargo.toml` so neither platform pulls the other's. `available_bytes` in `native_fs.rs` is the only such split.
- **Bundle targets**: set per platform — `deb` + `rpm` on Linux, `nsis` on Windows. Tauri filters requested targets against what the host can build, so a target list naming the wrong platform produces *no* installer rather than an error — see `apps/desktop/README.md`.
- **Origins differ**: Linux serves the app from `tauri://localhost` and Windows from `http://tauri.localhost`. Never hard-code either. Build asset URLs with `tauriConvertFileSrc()`, and if you add a check that inspects one, accept both forms.
- **Storage**: media goes through `TauriMediaStore` on every platform — a per-project directory under `AppData`, never OPFS. WebKitGTK's broken OPFS forced the decision; WebView2 having working OPFS does not reverse it, because the objection is the origin quota, not the implementation. IndexedDB stays, and only for what is small: project and timeline JSON.

Build-time system dependencies are Linux-only: WebViewGTK 4.1, libsoup-3.0, and javascriptcoregtk-4.1. Windows runners ship WebView2 already.


