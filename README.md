<div align="center">

<img src="apps/web/public/logos/bluper/svg/logotext.svg" alt="Bluper" width="500"/>

-----

Bluper is a video editor based on [OpenCut Classic](https://github.com/opencut-app/opencut-classic) that fixes bugs and adds a bunch of missing features that are in CapCut.

**Bluper is vibe coded and is not meant for professional use.**

</div>


## Features Added

- Freeze frame
- Cropping
- Grouping
- Transitions
- Fade in and out
- Speed / retime
- Adjust
- Effects
- Minor UI changes
- Numerous bug fixes

## Install

Download installer from the [releases page](https://github.com/joethun/bluper/releases)

## Build from source

You need [Bun](https://bun.sh), a Rust toolchain with the
`wasm32-unknown-unknown` target, and `wasm-pack`. On Linux you also need
WebKitGTK 4.1, libsoup-3.0 and javascriptcoregtk-4.1; Windows already ships
WebView2.

```bash
bun run build:wasm    # must precede bun install on a clean tree — the renderer is a file: dependency
bun install
bun run dev:desktop   # run it
bun run build:desktop # installers land in target/release/bundle/
```

`script/setup-rust` (or `script/setup-rust.ps1` on Windows) installs the Rust
side if you don't have it.

## Why?

- **Privacy**: Your videos stay on your device
- **Free features**: Most basic CapCut features are now paywalled
- **Simple**: People want editors that are easy to use - CapCut proved that

## Docs

| | |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Architecture, invariants, and the rules a change has to keep |
| [`apps/desktop/README.md`](apps/desktop/README.md) | The Tauri shell: build, native commands, packaging |
| [`rust/README.md`](rust/README.md) | The Rust crates and how `#[export]` reaches TypeScript |
| [`docs/actions.md`](docs/actions.md) | Keyboard shortcuts, buttons, and the action layer |
| [`docs/keyframes.md`](docs/keyframes.md) | Animating a property over time |
| [`docs/effects-renderer.md`](docs/effects-renderer.md) | Adding an effect and writing its shader |
