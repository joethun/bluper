# bluper-wasm

Shared video editor logic compiled to WebAssembly. This is the package the
Bluper editor imports as `@/wasm`'s underlying module.

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "bluper-wasm";

const time = mediaTimeFromSeconds({ seconds: 1.5 });
const label = time && formatTimecode({ time }); // "00:00:01.50"
```

Every export takes a single options object and returns `undefined` rather than
throwing where a value may not exist — see [`rust/README.md`](../README.md) for
why. All of them are documented in the generated TypeScript definitions at
`pkg/bluper_wasm.d.ts`.

Inside this repo, don't import the package directly: `apps/web/src/wasm/*.ts`
wraps it with the brands and invariant checks the editor relies on, and
`@/wasm` is the façade to import from.

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/), and
`src/wasm.rs` re-exports them onto this crate's public surface. `pkg/` and
`pkg-node/` are compiled output — generated on every build, never committed, and
not to be edited.

## Building

The web app depends on the local build, not on a published package:
`"bluper-wasm": "file:./rust/wasm/pkg"`. On a clean tree the build has to run
**before** `bun install`, or that `file:` dependency resolves to nothing.

```bash
# From the repo root
bun run build:wasm    # wasm-pack --target bundler → pkg/, then bun install
bun install
```

`bun run wasm` is the turbo-cached wrapper around the same thing, keyed on
`rust/crates/**` and `rust/wasm/src/**` — a ~20 ms cache hit when the Rust
hasn't changed and a ~35 s rebuild when it has. `dev:web`, `build:web` and
`check:desktop` all begin with it, so the renderer is rarely stale in practice.

Don't route around it with a bare `wasm-pack` call: `node_modules/bluper-wasm`
is a *copy*, not a symlink, and only the `bun install` inside `build:wasm`
refreshes it.

To rebuild continuously while working on the Rust:

```bash
bun run dev:wasm      # cargo watch on rust/crates + rust/wasm/src
```

`bun run publish:wasm` builds and pushes the package to npm. Nothing in this
repo consumes the published copy — it exists for use outside it — so bumping
`version` in `Cargo.toml` has no effect on the app's build.

### The nodejs build

`bun test` cannot initialise the bundler-target module, so tests import
`bluper-wasm-native` instead — the same crate built with `--target nodejs` into
`pkg-node/`, wired up as a `tsconfig` path. `bun run test:web` builds it first.

To let a module under test use `@/wasm` for real, mock the **package**, never
the façade:

```ts
import * as wasmNative from "bluper-wasm-native";
mock.module("bluper-wasm", () => wasmNative);
```

`mock.module` is process-global in bun and persists across files for the whole
run, so stubbing `@/wasm` itself leaves every later test file holding a partial
façade — and the failure surfaces in the *other* file, which makes it hard to
place.

The shipped bundler artifact is covered by `/desktop-check` instead. See
[`apps/desktop/README.md`](../../apps/desktop/README.md).
