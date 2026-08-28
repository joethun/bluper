import {
	clampAnimationsToDuration as _clampAnimationsToDuration,
	cloneAnimations as _cloneAnimations,
	removeElementKeyframe as _removeElementKeyframe,
	retimeElementKeyframe as _retimeElementKeyframe,
	setChannel as _setChannel,
	splitAnimationsAtTime as _splitAnimationsAtTime,
	updateScalarKeyframeCurve as _updateScalarKeyframeCurve,
} from "bluper-wasm";
import type {
	AnimationChannel,
	AnimationPath,
	ElementAnimations,
	ScalarCurveKeyframePatch,
} from "@/animation/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Keyframe editing, now owned by `editor-core::animation::keyframes`.
 *
 * The Rust side takes an `idSeed` rather than generating ids itself: minting a
 * UUID needs randomness, and wiring `getrandom` into a wasm build to produce
 * opaque strings is not worth it. Ids only have to be unique within the
 * document, so one fresh seed per call gives that, and the seed is generated
 * here where `crypto` already exists. Callers see the same signatures they did.
 */

function idSeed(): string {
	return crypto.randomUUID();
}

/** Cast helper: `MediaTime` flattens to `number` across the boundary. */
function toWasm<T>({ value }: { value: T }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as unknown as never;
}

export function splitAnimationsAtTime({
	animations,
	splitTime,
	shouldIncludeSplitBoundary = true,
}: {
	animations: ElementAnimations | undefined;
	splitTime: MediaTime;
	shouldIncludeSplitBoundary?: boolean;
}): {
	leftAnimations: ElementAnimations | undefined;
	rightAnimations: ElementAnimations | undefined;
} {
	const split = _splitAnimationsAtTime({
		animations: toWasm({ value: animations }),
		splitTime,
		shouldIncludeSplitBoundary,
		idSeed: idSeed(),
	});
	return {
		leftAnimations: split.leftAnimations ?? undefined,
		rightAnimations: split.rightAnimations ?? undefined,
	};
}

export function clampAnimationsToDuration({
	animations,
	duration,
}: {
	animations: ElementAnimations | undefined;
	duration: MediaTime;
}): ElementAnimations | undefined {
	return (
		_clampAnimationsToDuration({
			animations: toWasm({ value: animations }),
			duration,
			idSeed: idSeed(),
		}).animations ?? undefined
	);
}

export function cloneAnimations({
	animations,
	shouldRegenerateKeyframeIds = false,
}: {
	animations: ElementAnimations | undefined;
	shouldRegenerateKeyframeIds?: boolean;
}): ElementAnimations | undefined {
	return (
		_cloneAnimations({
			animations: toWasm({ value: animations }),
			shouldRegenerateKeyframeIds,
			idSeed: idSeed(),
		}).animations ?? undefined
	);
}

export function setChannel({
	animations,
	propertyPath,
	channel,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	channel: AnimationChannel | undefined;
}): ElementAnimations | undefined {
	return (
		_setChannel({
			animations: toWasm({ value: animations }),
			propertyPath,
			channel: toWasm({ value: channel }),
		}).animations ?? undefined
	);
}

export function removeElementKeyframe({
	animations,
	propertyPath,
	keyframeId,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	keyframeId: string;
}): ElementAnimations | undefined {
	return (
		_removeElementKeyframe({
			animations: toWasm({ value: animations }),
			propertyPath,
			keyframeId,
		}).animations ?? undefined
	);
}

export function retimeElementKeyframe({
	animations,
	propertyPath,
	keyframeId,
	time,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	keyframeId: string;
	time: MediaTime;
}): ElementAnimations | undefined {
	return (
		_retimeElementKeyframe({
			animations: toWasm({ value: animations }),
			propertyPath,
			keyframeId,
			time,
		}).animations ?? undefined
	);
}

export function updateScalarKeyframeCurve({
	animations,
	propertyPath,
	componentKey,
	keyframeId,
	patch,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	componentKey: string;
	keyframeId: string;
	patch: ScalarCurveKeyframePatch;
}): ElementAnimations | undefined {
	return (
		_updateScalarKeyframeCurve({
			animations: toWasm({ value: animations }),
			propertyPath,
			componentKey,
			keyframeId,
			patch: toWasm({ value: patch }),
		}).animations ?? undefined
	);
}
