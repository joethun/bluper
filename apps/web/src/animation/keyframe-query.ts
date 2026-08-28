import type {
	AnimationPath,
	ElementAnimations,
	ElementKeyframe,
} from "@/animation/types";
import {
	getElementKeyframes as _getElementKeyframes,
	getKeyframeAtTime as _getKeyframeAtTime,
	getKeyframeById as _getKeyframeById,
	hasKeyframesForPath as _hasKeyframesForPath,
} from "@/wasm/animation";

/**
 * Keyframe queries over an element's animation channels, owned by
 * `editor-core::animation::keyframes_query`.
 *
 * The TS-side originals walked the channel maps and built `ElementKeyframe`
 * records by hand; the Rust side does the same work and hands back records
 * shaped the same way. `MediaTime` flattens to a plain number across the
 * boundary, which is what `ElementKeyframe.time` already is on this side.
 */

/** `as unknown as never` keeps ESLint happy and matches `keyframes.ts`'s pattern. */
function wasmAnimations({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	animations: any;
} {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return { animations: animations as unknown as never };
}

export function getElementKeyframes({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementKeyframe[] {
	if (!animations) {
		return [];
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _getElementKeyframes(wasmAnimations({ animations })) as ElementKeyframe[];
}

export function hasKeyframesForPath({
	animations,
	propertyPath,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
}): boolean {
	return _hasKeyframesForPath({
		...wasmAnimations({ animations }),
		propertyPath,
	});
}

export function getKeyframeAtTime({
	animations,
	propertyPath,
	time,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	time: number;
}): ElementKeyframe | null {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const keyframe = _getKeyframeAtTime({
		...wasmAnimations({ animations }),
		propertyPath,
		time,
	}) as ElementKeyframe | undefined;
	// A Rust `None` arrives as `undefined`, not `null`. Callers that compare
	// against `null` rather than testing truthiness read that as a hit, so the
	// absent case is normalised here rather than at each call site.
	return keyframe ?? null;
}

export function getKeyframeById({
	animations,
	propertyPath,
	keyframeId,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	keyframeId: string;
}): ElementKeyframe | null {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const keyframe = _getKeyframeById({
		...wasmAnimations({ animations }),
		propertyPath,
		keyframeId,
	}) as ElementKeyframe | undefined;
	return keyframe ?? null;
}