# Keyframe System

Keyframes allow element properties to change over time. The system is split into three layers: the **data model** (how keyframes are stored), the **param registry** (which properties exist, their type and range, and how to read/write them on an element), and the **UI** (hooks and components that wire it all together).

All paths below are relative to `apps/web/`.

> The old `animation/property-registry.ts` — with per-path `valueKind` / `getValue` / `setValue` entries — no longer exists, and neither do `resolveNumberAtTime` / `resolveColorAtTime`. Property identity and read/write now live in `src/params/`, and resolution goes through a single `resolveAnimationPathValueAtTime`.
>
> Most of the behaviour described below has since moved into Rust
> (`editor-core::animation`, `editor-core::params`). The TypeScript names are
> unchanged — `src/wasm/*.ts` are thin typed wrappers — but the *list* of
> property paths and the channel layout rules are now owned by Rust, which
> changes where you add a new one. See step 1.

## How It Works

### Data model

Every `BaseTimelineElement` has an optional `animations?: ElementAnimations` field. It is keyed by property path directly — there is no `channels` wrapper object:

```typescript
export interface ElementAnimations {
    [propertyPath: AnimationPath]: ChannelData | undefined;
}
```

A `ChannelData` is either a single channel or a `CompositeChannelData` — a `Record<string, AnimationChannel | undefined>` — for a value that decomposes into components. Two channel shapes exist, both in `src/animation/types.ts`:

- `ScalarAnimationChannel` — numeric keys, each with an easing segment, optional Bézier handles and a tangent mode, plus optional before/after extrapolation.
- `DiscreteAnimationChannel` — booleans and strings, which just hold.

There is no separate colour channel. A colour is a composite of four scalar channels (`r`/`g`/`b`/`a`) sharing one easing mode, which is what keeps its components from drifting apart.

> `"bindings"` and `"channels"` are reserved: an older version of the editor stored channels under those keys, so `isAnimationStorageKey` excludes them and reading one as a property path would invent keyframes.

### Property paths

There are three kinds, all ultimately `AnimationPath` (a `string`):

- **Built-in paths** — a fixed list (`"opacity"`, `"transform.scaleX"`, `"background.paddingX"`, the `"adjust.*"` sliders, …). It exists twice on purpose: as the `ANIMATION_PROPERTY_PATHS` const in `rust/crates/editor-core/src/animation/path.rs`, which is what the runtime checks read, and as the type-only `AnimationPropertyPath` union in `src/animation/types.ts`, which is what makes a typo a compile error. `isAnimationPath` in `src/wasm/path.ts` is the runtime guard.
- **Graphic params** — `params.${key}`, built by `buildGraphicParamPath({ paramKey })`.
- **Effect params** — `effects.${id}.params.${key}`, built by `buildEffectParamPath(...)`.

The last two are open-ended and recognised by shape rather than by being listed, so they need no entry anywhere.

### Param registry

`src/params/` defines what a property *is*. `ParamDefinition` is a union over `number | boolean | color | select | text | font`, each carrying `key`, `label`, `default`, an optional `group`, an optional `channels` layout, and — the flag that matters here — `keyframable?: boolean`.

`src/params/registry.ts` holds the `DefinitionRegistry` plus the read/write helpers that replaced the old registry's `getValue`/`setValue`: `getElementParams`, `getBuiltInElementParams`, `getElementParam`, `readElementParamValue`, `writeElementParamValue`.

Behaviour derived from a definition rather than hand-written per path. All of it now lives in `editor-core::params` and is re-exported through `src/wasm/params.ts`:

- `getParamDefaultInterpolation({ param })`
- `getParamNumericRange({ param })`
- `coerceParamValue(...)` — validates and narrows a value on the way in.

**How a value decomposes into channels is no longer something you can hand in.** It used to be a `ParamChannelLayout` object carrying `decompose`/`compose` closures, returned by `getParamChannelLayout`; both are gone. Closures cannot cross a wasm boundary, and the layout is a function of the param's `type` anyway, so Rust derives it — which is why `upsertPathKeyframe` takes the `ParamDefinition` itself rather than a layout. A colour still decomposes into `r/g/b/a` with a shared easing mode, so its components cannot drift apart; you just don't describe that anywhere on the TypeScript side.

### Resolver

`src/animation/resolve.ts` provides `getElementLocalTime` and `resolveAnimationPathValueAtTime`, which returns the effective value of a path at a given local time and falls back to the element's static value when no keyframes exist. This one function covers numbers, colours and discrete values — there is no per-kind resolver.

For graphic params specifically, `resolveGraphicParamsAtTime` (`src/animation/graphic-param-channel.ts`) resolves a whole `ParamValues` bag at once.

### Renderer

Nodes in `src/services/renderer/nodes/` call the resolve functions before drawing, so animated properties interpolate correctly during preview and export.

### UI

`src/components/editor/panels/properties/hooks/`:

- `useKeyframedParamProperty` — the single keyframe-aware field hook, for every param type.
- `useElementPlayhead` — supplies `{ localTime, isPlayheadWithinElementRange }`.
- `usePropertyDraft` — for fields that are *not* keyframable.

---

## Adding a New Animatable Property

### 1. Register the path — in Rust *and* in the type

A built-in property goes in two places, and both are required.

`rust/crates/editor-core/src/animation/path.rs` is the runtime list:

```rust
pub const ANIMATION_PROPERTY_PATHS: &[&str] = &[
    // ...existing paths
    "background.paddingX",
];
```

`src/animation/types.ts` is the type-only union that keeps callers honest:

```typescript
type AnimationPropertyPath =
    // ...existing paths
    | "background.paddingX";
```

Rebuild the renderer (`bun run wasm`, or just run anything that depends on it) so the new path reaches the webview. `apps/web/src/animation/__tests__/path-parity.test.ts` holds a hand-rolled reference copy of the list and will fail until it is updated too — that is the point of it.

Graphic and effect params don't need an entry anywhere — their paths are recognised by shape and constructed by `buildGraphicParamPath` / `buildEffectParamPath`.

### 2. Make the param keyframable

In the param definition, set `keyframable: true` and give the numeric bounds the field needs:

```typescript
{
    key: "background.paddingX",
    label: "Width",
    type: "number",
    default: DEFAULT_TEXT_BACKGROUND.paddingX,
    min: 0,
    step: 1,
    keyframable: true,
}
```

**A built-in path has to appear in the param registry *and* in the path list.** `getElementKeyframes` filters an element's channels through `isAnimationPath`, so a path that is registered as a param but missing from the list in `path.rs` keyframes correctly and still draws no diamond on the clip and never snaps the playhead — a silent half-working feature, not an error. This trap is called out in comments in both places: above the `"adjust.*"` entries in `src/animation/types.ts`, and in the module doc of `editor-core::animation::path`.

### 3. Resolve it where it is used

```typescript
import { resolveAnimationPathValueAtTime } from "@/animation";

const resolvedPaddingX = resolveAnimationPathValueAtTime({
    animations: element.animations,
    propertyPath: "background.paddingX",
    localTime,
    fallbackValue: element.background.paddingX ?? DEFAULT_TEXT_BACKGROUND.paddingX,
});
```

The fallback must be the effective value *including* defaults — it is what gets recorded when the first keyframe is added.

### 4. Wire the renderer

In the relevant node under `src/services/renderer/nodes/`, resolve before drawing and use the resolved value — not `this.params.*` — anywhere it affects rendering.

### 5. The UI, usually for free

For a param that belongs to an element's params bag, there is nothing to wire. `element-params-tab.tsx` calls `getElementParams({ element })`, maps each definition through `useKeyframedParamProperty`, and renders it with `PropertyParamField`, which picks the control from `param.type` (number field, slider, switch, colour picker, eyedropper, select, font picker, textarea) and draws the `KeyframeToggle` when a `keyframe` prop is passed. Registering the param in step 2 is what makes the field appear, with keyframing already attached.

Reach for the hook directly only for a **bespoke field outside that loop** — the two call sites today are `element-params-tab.tsx` and `graphics/components/graphic-tab.tsx`, both of which are generic loops of exactly this kind. If you find yourself hand-writing a third, check first whether the param belongs in the generic tab instead.

For that bespoke case:

```typescript
const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
    startTime: element.startTime,
    duration: element.duration,
});

const paddingX = useKeyframedParamProperty({
    param,                       // the ParamDefinition
    trackId,
    elementId: element.id,
    animations: element.animations,
    propertyPath: "background.paddingX", // omit for graphic params — derived from param.key
    localTime,
    isPlayheadWithinElementRange,
    resolvedValue: resolvedPaddingX,
    buildBaseUpdates: ({ value }) => ({
        background: { ...element.background, paddingX: value as number },
    }),
});
```

It returns:

```typescript
{
    hasAnimatedKeyframes: boolean;
    isKeyframedAtTime: boolean;
    keyframeIdAtTime: string | null;
    onPreview: (value: number | string | boolean) => void;
    onCommit: () => void;
    toggleKeyframe: () => void;
}
```

`onPreview` writes through `editor.timeline.previewElements` — the uncommitted preview overlay — and `onCommit` folds the accumulated overlay into a single undoable command. Drive a drag or scrub with `onPreview` and call `onCommit` when the gesture ends; never call `editor.timeline.updateElements` directly from the field, or the gesture lands as one history entry per frame.

In JSX, put a `KeyframeToggle` in the field's `beforeLabel`:

```tsx
<SectionField
    label="Width"
    beforeLabel={
        <KeyframeToggle
            isActive={paddingX.isKeyframedAtTime}
            isDisabled={!isPlayheadWithinElementRange}
            title="Toggle background width keyframe"
            onToggle={paddingX.toggleKeyframe}
        />
    }
>
    {/* number field driven by onPreview / onCommit */}
</SectionField>
```

---

## Checklist

- [ ] Built-in path added to `ANIMATION_PROPERTY_PATHS` in `path.rs`, to the `AnimationPropertyPath` union in `src/animation/types.ts`, and to the reference list in `path-parity.test.ts` (none of this is needed for graphic/effect params)
- [ ] Param definition has `keyframable: true`, plus `min`/`step` for a number
- [ ] Value read through `resolveAnimationPathValueAtTime` with a fallback that includes defaults
- [ ] Renderer node uses the resolved value, not the static one
- [ ] Checked whether the generic params tab already renders the field before hand-writing one
- [ ] If bespoke: uses `useKeyframedParamProperty` (not `usePropertyDraft`) and puts `KeyframeToggle` in `beforeLabel`
- [ ] Gestures go through `onPreview` + `onCommit`, never `updateElements` directly
