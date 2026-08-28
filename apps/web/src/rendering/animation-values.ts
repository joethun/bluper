import type { ElementAnimations } from "@/animation/types";
import { resolveTransformAtTime as _resolveTransformAtTime } from "@/wasm/animation";
import type { Transform } from "./index";

/**
 * Resolve a transform's animated properties at a tick. The Rust side does the
 * five property reads internally, collapsing what was five wasm calls per
 * element per frame into one. Per-frame hot path.
 */
export function resolveTransformAtTime({
	baseTransform,
	animations,
	localTime,
}: {
	baseTransform: Transform;
	animations: ElementAnimations | undefined;
	localTime: number;
}): Transform {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _resolveTransformAtTime({
		animations: animations as never,
		baseTransform,
		localTime: Math.max(0, localTime),
	}) as Transform;
}