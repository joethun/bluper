# bluper-wasm

Shared video editor logic compiled to WebAssembly. Used by the Bluper web app.

## Install

```bash
npm install bluper-wasm
```

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "bluper-wasm";

const ticks = mediaTimeFromSeconds(1.5);
const label = formatTimecode({ ticks });
```

All exports are documented in the [TypeScript definitions](./bluper_wasm.d.ts).

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). This package is the compiled WebAssembly output — do not edit it directly.

## Local development

The web app depends on the published `bluper-wasm` package by default. If you are editing the WASM source in this repo and want `apps/web` to use your local build instead:

```bash
# From the repo root
bun run build:wasm

cd rust/wasm/pkg
bun link

cd ../../../apps/web
bun link bluper-wasm
```

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```
