import { upsertPathKeyframe as _upsertPathKeyframe } from "bluper-wasm";
import type {
	AnimationInterpolation,
	AnimationPath,
	ElementAnimations,
} from "@/animation/types";
import type { ParamDefinition, ParamValue } from "@/params";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Setting one property's value at one time, now owned by
 * `editor-core::animation::keyframes`.
 *
 * This used to take a channel layout and a `coerceValue` callback. It takes the
 * parameter itself instead: Rust derives the layout, the coercion and the
 * decomposition into components from it, and a closure cannot cross a wasm
 * boundary. Every caller already had the param in hand.
 */
export function upsertPathKeyframe({
	animations,
	propertyPath,
	time,
	value,
	interpolation,
	keyframeId,
	param,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	time: MediaTime;
	value: ParamValue;
	interpolation?: AnimationInterpolation;
	keyframeId?: string;
	param: ParamDefinition;
}): ElementAnimations | undefined {
	return (
		_upsertPathKeyframe({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			animations: animations as never,
			propertyPath,
			time,
			value,
			interpolation,
			keyframeId,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			param: param as never,
			idSeed: crypto.randomUUID(),
		}).animations ?? undefined
	);
}
