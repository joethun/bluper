# rust/

The editor's non-UI logic. Consumed twice: compiled to WebAssembly for the
webview (`rust/wasm`), and linked natively into the Tauri shell
(`apps/desktop/src-tauri`), which depends on `editor-core` directly so that
shared maths is literally the same function on both sides rather than two that
are hoped to agree.

## The crates

| Crate | What it is |
|---|---|
| `bridge` | The `#[export]` proc macro. Nothing else. |
| `time` | `MediaTime` (120,000 ticks/second), frame rates, timecode parse/format. |
| `editor-core` | The domain: `model`, `project`, `params`, `animation`, `timeline`, `clip`, `text`, `masks`, `effects`, `export`, `storage`, and the rest. Most ports land here. |
| `gpu` | wgpu device, surface and texture ownership, plus the `blit`/`fullscreen` primitives. |
| `effects` | Effect shader pipelines built on `gpu`. See [`docs/effects-renderer.md`](../docs/effects-renderer.md). |
| `masks` | Signed-distance-field generation and mask feathering. |
| `compositor` | Puts a frame together: sources, effects, masks, output. |

It is `editor-core`, not `core`: a local crate named `core` shadows Rust's
built-in `core` in the extern prelude of every dependent crate, which makes
`::core::mem` and friends unreachable there.

## Adding a new crate

1. Create it under `rust/crates/`.
2. Add it to `members` in the root `Cargo.toml` — the workspace is not globbed.
3. Add `bridge` as a dependency.
4. Annotate public functions with `#[export]`.
5. If TypeScript should see it, add `pub use <crate>::*;` to `rust/wasm/src/wasm.rs` **and** the crate as a dependency of `rust/wasm`. Skipping this compiles fine and silently ships nothing — see the warning below.

## How `#[export]` works

```rust
use bridge::export;

#[export]
pub fn media_time_from_seconds(
    MediaTimeFromSecondsOptions { seconds }: MediaTimeFromSecondsOptions,
) -> Option<MediaTime> {
    MediaTime::from_seconds_f64(seconds)
}
```

Without the `wasm` feature, the macro is a no-op. With it, it expands to a
`#[wasm_bindgen(js_name = "mediaTimeFromSeconds")]` — snake_case becomes
camelCase automatically.

**One options struct, not positional arguments.** The macro rejects a function
taking more than one typed parameter with a compile error telling you to wrap
them. This mirrors the `bluper/prefer-object-params` ESLint rule on the
TypeScript side: a call site reads the same in both languages, and adding a
field is not a breaking change.

`#[export]` also works on a `const`, where it emits a getter function returning
`f64` under the same JS name:

```rust
#[export]
pub const TICKS_PER_SECOND: i64 = 120_000;
```

## Two boundary traps

Both have cost a full green test run, so they are worth reading before writing:

- **`rust/wasm/src/wasm.rs` is not decoration.** The `pub use` lines are what put a module's `#[export]` bindings on the wasm crate's public surface, which is where `wasm-bindgen`'s glue generation looks. Drop a module and every function it exports disappears from the built package — the Rust still compiles, the Rust tests still pass, and the failure surfaces as `Module '"bluper-wasm"' has no exported member` across dozens of unrelated TypeScript files.
- **A struct that serialises as a map arrives in JavaScript as a `Map`.** `#[serde(flatten)]` and `HashMap` both go through `serialize_map`, which `serde_wasm_bindgen` renders as a real `Map` whose `.duration` is `undefined`. `tsify_next`'s `hashmap_as_object` is off by default, so every container attribute needs it spelled out: `tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)`. It has to go on the container — field-level `tsify(...)` accepts only `type` and `optional`. `Vec<f64>` has the same problem (it crosses as an object with numeric keys); use a named struct. `apps/web/src/wasm/__tests__/boundary-shape.test.ts` is the guard.

Generated names collide silently too. Two `#[export]` option structs called
`TrackOptions` in different modules emit two `export interface TrackOptions`
blocks into one `.d.ts`, and TypeScript merges same-shaped interfaces without
complaint — then starts lying the moment they differ. This should print nothing:

```bash
grep -o "^export interface [A-Za-z]*" rust/wasm/pkg/bluper_wasm.d.ts | sort | uniq -d
```

## Native-only code

`ffmpeg-next` does not build for `wasm32-unknown-unknown`. `editor-core`
target-gates it under `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`,
which is how the encoder (`MediaSink`) lives in the domain crate without the
wasm build ever seeing it. Anything else needing ffmpeg goes behind the same
gate, or into `apps/desktop/src-tauri`.

## Testing

```bash
cargo test -p <crate>          # one crate
cargo test -p effects          # also validates every WGSL shader through naga
cargo test -p bluper-desktop   # the shell; the only place the Windows cfg paths run
```

`cargo test -p effects` matters more than it looks: `create_shader_module` only
fails at runtime, which in the desktop shell means a black preview rather than
a build error.

From the TypeScript side, tests reach real Rust through `bluper-wasm-native` —
the nodejs-target build of the same crate, produced by `bun run wasm:test` and
wired up as a `tsconfig` path. Use `bun run test:web`, which builds it first.
