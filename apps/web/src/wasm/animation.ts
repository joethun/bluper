import {
	getChannelValueAtTime as _getChannelValueAtTime,
	getElementKeyframesValue as _getElementKeyframesValue,
	getElementLocalTimeValue as _getElementLocalTimeValue,
	getKeyframeAtTimeValue as _getKeyframeAtTimeValue,
	getKeyframeByIdValue as _getKeyframeByIdValue,
	hasKeyframesForPathValue as _hasKeyframesForPathValue,
	isScalarChannel as _isScalarChannel,
	normalizeChannel as _normalizeChannel,
	resolveAnimationPathValueAtTimeValue as _resolveAnimationPathValueAtTimeValue,
	resolveTransformAtTimeValue as _resolveTransformAtTimeValue,
	type AnimationChannel as WasmAnimationChannel,
	getCurveHandlesForNormalizedCubicBezier as _getCurveHandlesForNormalizedCubicBezier,
	getNormalizedCubicBezierForScalarSegment as _getNormalizedCubicBezierForScalarSegment,
	getBezierPoint as _getBezierPoint,
	getDefaultLeftHandle as _getDefaultLeftHandle,
	getDefaultRightHandle as _getDefaultRightHandle,
	solveBezierProgress as _solveBezierProgress,
	type ScalarAnimationKey as WasmScalarAnimationKey,
} from "bluper-wasm";
import type {
	AnimationChannel,
	Channel,
	CurveHandle,
	DiscreteAnimationChannel,
	DiscreteValue,
	NormalizedCubicBezier,
	ScalarAnimationChannel,
	ScalarAnimationKey,
} from "@/animation/types";
import type { ParamValue } from "@/params";

/**
 * Cubic-bezier segments, now owned by `editor-core::animation::bezier`.
 *
 * This replaces the old `@/animation/bezier`, which computed the same values in
 * TypeScript. The two were held to bit-exact agreement over generated inputs
 * before the TypeScript was removed; the Rust side keeps unit tests for the
 * behaviour that agreement pinned.
 *
 * Handle offsets are plain numbers, not `MediaTime`. A *default* handle is a
 * third of the span between two keys, which is fractional for all but every
 * third tick — the previous TypeScript relied on an inferred return type to
 * allow that, and `CurveHandle` in `@/animation/types` still brands `dt` because
 * a *stored* handle really is a whole number of ticks.
 */

/** A handle offset as the solver works with it: possibly fractional ticks. */
export interface BezierHandleOffset {
	dt: number;
	dv: number;
}

/**
 * The wasm view of a keyframe. Structurally what `@/animation/types` describes —
 * `MediaTime` collapses to `number` across the boundary — so this only exists to
 * satisfy the generated signatures without spreading casts over the callers.
 */
function toWasmKey({
	key,
}: {
	key: ScalarAnimationKey;
}): WasmScalarAnimationKey {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return key as unknown as WasmScalarAnimationKey;
}

export function getBezierPoint({
	progress,
	p0,
	p1,
	p2,
	p3,
}: {
	progress: number;
	p0: number;
	p1: number;
	p2: number;
	p3: number;
}): number {
	return _getBezierPoint({ progress, p0, p1, p2, p3 });
}

export function getDefaultRightHandle({
	leftKey,
	rightKey,
}: {
	leftKey: ScalarAnimationKey;
	rightKey: ScalarAnimationKey;
}): BezierHandleOffset {
	return _getDefaultRightHandle({
		leftKey: toWasmKey({ key: leftKey }),
		rightKey: toWasmKey({ key: rightKey }),
	});
}

export function getDefaultLeftHandle({
	leftKey,
	rightKey,
}: {
	leftKey: ScalarAnimationKey;
	rightKey: ScalarAnimationKey;
}): BezierHandleOffset {
	return _getDefaultLeftHandle({
		leftKey: toWasmKey({ key: leftKey }),
		rightKey: toWasmKey({ key: rightKey }),
	});
}

export function solveBezierProgressForTime({
	time,
	leftKey,
	rightKey,
}: {
	time: number;
	leftKey: ScalarAnimationKey;
	rightKey: ScalarAnimationKey;
}): number {
	return _solveBezierProgress({
		time,
		leftKey: toWasmKey({ key: leftKey }),
		rightKey: toWasmKey({ key: rightKey }),
	});
}

/**
 * Convert a segment's stored handles to the normalised
 * `cubic-bezier(x1, y1, x2, y2)` the curve editor works in, or `null` when the
 * segment has no shape to describe — zero length, or flat with no usable
 * reference scale.
 *
 * Rust names the control points rather than returning a sequence, because a
 * `Vec` crosses the boundary as an object with numeric keys and a caller
 * destructuring it as a tuple would silently get `undefined`s. The tuple is
 * rebuilt here, where TypeScript expects one.
 */
export function getNormalizedCubicBezierForScalarSegment({
	leftKey,
	rightKey,
	referenceSpanValue,
}: {
	leftKey: ScalarAnimationKey;
	rightKey: ScalarAnimationKey;
	referenceSpanValue?: number;
}): NormalizedCubicBezier | null {
	const curve = _getNormalizedCubicBezierForScalarSegment({
		leftKey: toWasmKey({ key: leftKey }),
		rightKey: toWasmKey({ key: rightKey }),
		referenceSpanValue,
	});
	return curve ? [curve.x1, curve.y1, curve.x2, curve.y2] : null;
}

/** The inverse: normalised control points back to handles on the two keys. */
export function getCurveHandlesForNormalizedCubicBezier({
	leftKey,
	rightKey,
	cubicBezier,
	referenceSpanValue,
}: {
	leftKey: ScalarAnimationKey;
	rightKey: ScalarAnimationKey;
	cubicBezier: NormalizedCubicBezier;
	referenceSpanValue?: number;
}): { rightHandle: CurveHandle; leftHandle: CurveHandle } | null {
	const pair = _getCurveHandlesForNormalizedCubicBezier({
		leftKey: toWasmKey({ key: leftKey }),
		rightKey: toWasmKey({ key: rightKey }),
		cubicBezier: [...cubicBezier],
		referenceSpanValue,
	});
	if (!pair) return null;
	// `dt` here is a whole number of ticks — the Rust side rounds it — so it
	// really is a `MediaTime`, which the generated type flattens to `number`.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return pair as unknown as {
		rightHandle: CurveHandle;
		leftHandle: CurveHandle;
	};
}

/**
 * Channel evaluation, now owned by `editor-core::animation::interpolation`.
 *
 * Held to bit-exact agreement with the TypeScript it replaces over 6,000
 * generated channels — shared key times, all three segment types, stored
 * handles, both extrapolation modes.
 *
 * There is no cache here. The TypeScript memoised normalisation on the channel
 * object because rebuilding one in JS allocated per key; Rust normalises inside
 * each call instead. That makes a read cost more than it used to, and the way
 * that comes back down is Rust holding the channel rather than being handed one
 * — at which point there is nothing to serialise and nothing to re-normalise.
 */

export function isScalarChannel(
	channel: AnimationChannel,
): channel is ScalarAnimationChannel {
	return _isScalarChannel({ channel: toWasmChannel({ channel }) });
}

function normalizeChannel({
	channel,
}: {
	channel: ScalarAnimationChannel;
}): ScalarAnimationChannel;
function normalizeChannel({
	channel,
}: {
	channel: DiscreteAnimationChannel;
}): DiscreteAnimationChannel;
function normalizeChannel({
	channel,
}: {
	channel: AnimationChannel;
}): AnimationChannel;
function normalizeChannel({
	channel,
}: {
	channel: AnimationChannel;
}): AnimationChannel {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _normalizeChannel({
		channel: toWasmChannel({ channel }),
	}) as unknown as AnimationChannel;
}

/**
 * Normalising is shape-preserving, so this only exists to keep the caller's
 * narrowing. Rust decides scalar-vs-discrete from the same evidence the
 * TypeScript did, so a scalar channel in is a scalar channel out.
 */
export function normalizeScalarChannel({
	channel,
}: {
	channel: ScalarAnimationChannel;
}): ScalarAnimationChannel {
	return normalizeChannel({ channel });
}

export function getChannelValueAtTime({
	channel,
	time,
	fallbackValue,
}: {
	channel: Channel<number> | undefined;
	time: number;
	fallbackValue: number;
}): number;
export function getChannelValueAtTime<TValue extends DiscreteValue>({
	channel,
	time,
	fallbackValue,
}: {
	channel: DiscreteAnimationChannel | undefined;
	time: number;
	fallbackValue: TValue;
}): TValue;
export function getChannelValueAtTime({
	channel,
	time,
	fallbackValue,
}: {
	channel: AnimationChannel | undefined;
	time: number;
	fallbackValue: ParamValue;
}): ParamValue {
	return _getChannelValueAtTime({
		channel: channel ? toWasmChannel({ channel }) : undefined,
		time,
		fallbackValue,
	}) as ParamValue;
}

/**
 * `MediaTime` flattens to `number` across the boundary, so the wasm view of a
 * channel is structurally what `@/animation/types` describes.
 */
function toWasmChannel({
	channel,
}: {
	channel: AnimationChannel;
}): WasmAnimationChannel {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return channel as unknown as WasmAnimationChannel;
}

/**
 * Whether a property path has any keyframes, owned by
 * `editor-core::animation::keyframes_query`. Wraps the wasm call so the TS
 * signature can take the branded `ElementAnimations` directly without going
 * through the wasm-shape cast at every call site.
 */
export function hasKeyframesForPath({
	animations,
	propertyPath,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	animations: any;
	propertyPath: string;
}): boolean {
	return _hasKeyframesForPathValue({
		animations,
		propertyPath,
	});
}

/**
 * Map a timeline time onto a clip's local span, clamped to `[0, duration]`.
 * Owned by `editor-core::animation::keyframes_query`.
 */
export function getElementLocalTime({
	timelineTime,
	elementStartTime,
	elementDuration,
}: {
	timelineTime: number;
	elementStartTime: number;
	elementDuration: number;
}): number {
	return _getElementLocalTimeValue({
		timelineTime,
		elementStartTime,
		elementDuration,
	});
}

/**
 * Every keyframe on every property path of one element, owned by
 * `editor-core::animation::keyframes_query`. Wraps the wasm call.
 */
export function getElementKeyframes({
	animations,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	animations: any;
}): unknown {
	return _getElementKeyframesValue({ animations });
}

/**
 * The keyframe at a tick on a property path, owned by
 * `editor-core::animation::keyframes_query`.
 */
export function getKeyframeAtTime({
	animations,
	propertyPath,
	time,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	animations: any;
	propertyPath: string;
	time: number;
}): unknown {
	return _getKeyframeAtTimeValue({ animations, propertyPath, time });
}

/**
 * The keyframe with a given id on a property path, owned by
 * `editor-core::animation::keyframes_query`.
 */
export function getKeyframeById({
	animations,
	propertyPath,
	keyframeId,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	animations: any;
	propertyPath: string;
	keyframeId: string;
}): unknown {
	return _getKeyframeByIdValue({ animations, propertyPath, keyframeId });
}

/**
 * Resolve a property path's value at a tick — the orchestrator the
 * per-frame renderer asks. Owned by
 * `editor-core::animation::keyframes_query`.
 */
export function resolveAnimationPathValueAtTime({
	animations,
	propertyPath,
	localTime,
	fallbackValue,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	animations: any;
	propertyPath: string;
	localTime: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fallbackValue: any;
}): unknown {
	return _resolveAnimationPathValueAtTimeValue({
		animations,
		propertyPath,
		localTime,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		fallback: fallbackValue as never,
	});
}

/**
 * Resolve a transform's animated properties at a tick — the per-frame orchestrator
 * the renderer asks once per element. Owned by
 * `editor-core::animation::keyframes_query`.
 */
export function resolveTransformAtTime({
	animations,
	baseTransform,
	localTime,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	animations: any;
	baseTransform: {
		position: { x: number; y: number };
		scaleX: number;
		scaleY: number;
		rotate: number;
	};
	localTime: number;
}): unknown {
	return _resolveTransformAtTimeValue({
		animations,
		baseTransform,
		localTime: Math.max(0, localTime),
	});
}
