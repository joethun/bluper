# Effects & GPU Renderer

## How to add a new effect

1. Add the definition to the file for its family in `apps/web/src/effects/definitions/` — `motion.ts`, `tape.ts`, `optics.ts`, `keying.ts`. These are grouped by family, not one file per effect; only add a file if the effect starts a new family.
2. Export an `EffectDefinition` — see `blurEffect` in `optics.ts` as a reference.
3. Add it to a group in `apps/web/src/effects/definitions/index.ts`. Grouping and ordering are the same list, so an effect cannot be filed under one heading and sorted as though it were under another.

An effect definition has:
- `type` — unique string identifier
- `name` — display name
- `keywords` — for search
- `params` — user-facing controls (sliders, toggles, etc.)
- `renderer` — GPU pass templates resolved into shader identifiers + uniforms

All effects use the shared GPU renderer. TypeScript decides which shader identifiers to run and which uniforms to pass. Rust/wgpu owns device creation, textures, and pass execution.

## Single-pass vs multi-pass

The renderer supports a `passes` array. Single-pass effects (e.g. color grading) just have one entry. Multi-pass is needed when an effect has to process its own output — blur (H then V), bloom (extract → blur → composite), glow, etc.

```typescript
renderer: {
  passes: [
    { shader: "my-effect-shader", uniforms: ({ effectParams }) => ({ ... }) },
  ],
}
```

### Dynamic pass counts with `buildPasses`

Some effects need a variable number of passes depending on their parameters (e.g. blur needs more iterations at high intensity to keep quality). For these, add a `buildPasses` function to the renderer:

```typescript
renderer: {
  passes: [ /* static fallback — used if buildPasses is absent */ ],
  buildPasses: ({ effectParams, width, height }) => {
    // return EffectPass[] with pre-computed uniforms
  },
}
```

When `buildPasses` is present, all rendering paths use it instead of the static `passes` array. The static array is kept as a structural reference and fallback for effects that don't need dynamic pass counts.

### Resolving passes — always use `resolveEffectPasses`

All code that consumes effect passes should go through the helper, never access `definition.renderer.passes` directly:

```typescript
import { resolveEffectPasses } from "@/effects";

const passes = resolveEffectPasses({ definition, effectParams, width, height });
```

This handles the `buildPasses` vs static `passes` dispatch automatically.

### Pipeline

Linear effect chains go through `gpuRenderer.applyEffect()` in `apps/web/src/services/renderer/gpu-renderer.ts`. Note that it fails soft: if `initializeGpu()` rejects, `gpuAvailable` goes false and `applyEffect`/`applyMaskFeather` become pass-throughs that return the input canvas unchanged — so a missing effect is a plausible symptom of GPU init failure, not only of a bad definition.

TypeScript resolves `EffectPass[]` from effect definitions. Each pass contains:
- `shader` — a stable identifier such as `"gaussian-blur"`
- `uniforms` — a name → value map, resolved to numbers, using the `u_*` names the Rust side reads by

Rust maps the shader identifier to a precompiled WGSL pipeline in `rust/crates/effects/src/pipeline.rs`. Non-linear GPU work — signed-distance-field generation and mask feathering — lives in `rust/crates/masks/`, not in TypeScript orchestration.

The registered identifiers are `"gaussian-blur"`, `"chroma-key"`, and the five colour passes `"brightness"`, `"contrast"`, `"saturate"`, `"hue-rotate"`, `"invert"`. The colour functions are each a pass of their own so a chain applies in the order written — `brightness(2) contrast(0.5)` and `contrast(0.5) brightness(2)` are different pictures.

## Writing shaders

Effect WGSL lives in `rust/crates/effects/src/shaders/`. There is no separate registry file: add the shader there, then `include_str!` it next to a shader-ID const in `rust/crates/effects/src/pipeline.rs` and register it in the pipeline's dispatch table. (`rust/crates/gpu/src/shaders/` holds only the `blit`/`fullscreen` primitives — effect shaders do not go there.)

`cargo test -p effects` validates the WGSL through `naga`, because `create_shader_module` only fails at runtime, which on the desktop shell means a black preview rather than a build error. Run it after touching a shader.

Bindings are fixed by the pipeline, so a new shader declares them exactly like the existing ones:

```wgsl
@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;
```

The uniform struct is packed by Rust, not named per-field from TypeScript: `resolution: vec2f`, `direction: vec2f`, `scalars: vec4f`. `resolution` comes from `ApplyEffectsOptions.resolution` — deliberately decoupled from `width`/`height` so blur sigma stays scale-invariant when the preview drops render scale — and the scalars are the pass's own `u_*` uniforms in the order that shader's reader expects (`u_sigma`, `u_step`, `u_direction` for blur; `u_amount` for a colour pass).

**Sampling density and step scaling**

A fixed kernel (the blur shader loops ±30 samples) can only cover ±30 texels at step=1. When the target sigma grows beyond ~10, the kernel can't cover enough of the Gaussian curve and the result degrades into a box filter.

The fix is the `u_step` uniform, which spaces samples further apart. With step=4 the same 61-sample kernel covers ±120 texels; bilinear filtering smooths the gaps. For very large sigma, combine step scaling with **multi-iteration stacking** (multiple H+V pass pairs via `buildPasses`) — each iteration compounds the blur, and the effective sigma = per-pass sigma × √iterations.

Keep the step size moderate (≤4) to avoid visible banding. Do **not** use large step sizes (>6) in a single pass — it bands regardless of bilinear interpolation. Add iterations instead.

```wgsl
// u_step scales the distance between samples
let position = f32(index) * step_size;
let weight = exp(-(position * position) / (2.0 * sigma * sigma));
color += textureSample(input_texture, input_sampler, uv + texel_size * uniforms.direction * position) * weight;
```

## Coordinate systems

Source canvases enter the GPU pipeline through `import_offscreen_canvas_texture` / `import_video_frame_texture` in `rust/crates/gpu/src/context.rs`. If a shader or import path changes, validate orientation explicitly — the renderer assumes a consistent top-left canvas origin by the time results come back to TypeScript.
