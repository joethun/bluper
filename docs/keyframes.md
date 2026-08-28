# Keyframe System

Keyframes allow element properties to change over time. The system is split into three layers: the **data model** (how keyframes are stored), the **param registry** (which properties exist, their type and range, and how to read/write them on an element), and the **UI** (hooks and components that wire it all together).

All paths below are relative to `apps/web/`.

> The old `animation/property-registry.ts` — with per-path `valueKind` / `getValue` / `setValue` entries — no longer exists, and neither do `resolveNumberAtTime` / `resolveColorAtTime`. Property identity and read/write now live in `src/params/`, and resolution goes through a single `resolveAnimationPathValueAtTime`.

## How It Works

### Data model

Every `BaseTimelineElement` has an optional `animations?: ElementAnimations` field:

```typescript
interface ElementAnimations {
    channels: Record<string, AnimationChannel | undefined>;
}
```

A channel is a typed bucket of keyframes keyed by property path (e.g. `"opacity"`, `"background.color"`). Three channel types exist: `NumberAnimationChannel`, `ColorAnimationChannel`, and `DiscreteAnimationChannel`. Types live in `src/animation/types.ts`.

### Property paths

There are three kinds, all ultimately `AnimationPath` (a `string`):

- **Built-in paths** — the literal list `ANIMATION_PROPERTY_PATHS` in `src/animation/types.ts` (`"opacity"`, `"transform.scaleX"`, `"background.paddingX"`, the `"adjust.*"` sliders, …). `AnimationPropertyPath` is derived from it, and `isAnimationPath` in `src/animation/path.ts` is the runtime guard.
- **Graphic params** — `params.${key}`, built by `buildGraphicParamPath({ paramKey })`.
- **Effect params** — `effects.${id}.params.${key}`, built by `buildEffectParamPath(...)`.

### Param registry

`src/params/` defines what a property *is*. `ParamDefinition` is a union over `number | boolean | color | select | text | font`, each carrying `key`, `label`, `default`, an optional `group`, an optional `channels` layout, and — the flag that matters here — `keyframable?: boolean`.

`src/params/registry.ts` holds the `DefinitionRegistry` plus the read/write helpers that replaced the old registry's `getValue`/`setValue`: `getElementParams`, `getElementParam`, `readElementParamValue`, `writeElementParamValue`.

Behaviour derived from a definition rather than hand-written per path:

- `getParamChannelLayout({ param })` — how a value decomposes into channels. A colour decomposes into `r/g/b/a` with `easingMode: "shared"`, so its components cannot drift apart.
- `getParamDefaultInterpolation({ param })`
- `getParamNumericRange({ param })`
- `coerceParamValue(...)` — validates and narrows a value on the way in.

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

### 1. Register the path

For a built-in property, add it to `ANIMATION_PROPERTY_PATHS` in `src/animation/types.ts`:

```typescript
export const ANIMATION_PROPERTY_PATHS = [
    // ...existing paths
    "background.paddingX",
] as const;
```

Graphic and effect params don't need an entry — their paths are constructed by `buildGraphicParamPath` / `buildEffectParamPath`.

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

**A built-in path has to appear in both places.** `getElementKeyframes` filters an element's channels through `isAnimationPath`, so a path that is registered as a param but missing from `ANIMATION_PROPERTY_PATHS` keyframes correctly and still draws no diamond on the clip and never snaps the playhead. This trap is called out in a comment above the `"adjust.*"` entries in `src/animation/types.ts`.

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

- [ ] Built-in path added to `ANIMATION_PROPERTY_PATHS` (not needed for graphic/effect params)
- [ ] Param definition has `keyframable: true`, plus `min`/`step` for a number
- [ ] Value read through `resolveAnimationPathValueAtTime` with a fallback that includes defaults
- [ ] Renderer node uses the resolved value, not the static one
- [ ] Checked whether the generic params tab already renders the field before hand-writing one
- [ ] If bespoke: uses `useKeyframedParamProperty` (not `usePropertyDraft`) and puts `KeyframeToggle` in `beforeLabel`
- [ ] Gestures go through `onPreview` + `onCommit`, never `updateElements` directly
