import type {
	AnimationPath,
	ElementAnimations,
} from "@/animation/types";
import type { ParamValue } from "@/params";
import {
	getElementLocalTime as _getElementLocalTime,
	resolveAnimationPathValueAtTime as _resolveAnimationPathValueAtTime,
} from "@/wasm/animation";

/**
 * Map a timeline time onto a clip's local span, owned by
 * `editor-core::animation::keyframes_query`. A thin wrapper so the TS code can
 * keep the three-number signature it already uses.
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
	return _getElementLocalTime({
		timelineTime,
		elementStartTime,
		elementDuration,
	});
}

/**
 * `as unknown as never` keeps ESLint happy and matches the pattern in
 * `apps/web/src/wasm/keyframes.ts`. Pulled into its own helper so the
 * per-line eslint-disable lives on the line it actually covers.
 */
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

/**
 * Per-frame orchestrator for resolving a property path's value at a tick.
 * Owned by `editor-core::animation::keyframes_query`; the Rust side does the
 * shape dispatch and the per-component channel reads internally, so this
 * collapses up to four wasm calls into one.
 */
export function resolveAnimationPathValueAtTime({
	animations,
	propertyPath,
	localTime,
	fallbackValue,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	localTime: number;
	fallbackValue: number;
}): number;
export function resolveAnimationPathValueAtTime({
	animations,
	propertyPath,
	localTime,
	fallbackValue,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	localTime: number;
	fallbackValue: string;
}): string;
export function resolveAnimationPathValueAtTime({
	animations,
	propertyPath,
	localTime,
	fallbackValue,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	localTime: number;
	fallbackValue: boolean;
}): boolean;
export function resolveAnimationPathValueAtTime({
	animations,
	propertyPath,
	localTime,
	fallbackValue,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	localTime: number;
	fallbackValue: ParamValue;
}): ParamValue;
export function resolveAnimationPathValueAtTime({
	animations,
	propertyPath,
	localTime,
	fallbackValue,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPath;
	localTime: number;
	fallbackValue: ParamValue;
}): ParamValue {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _resolveAnimationPathValueAtTime({
		...wasmAnimations({ animations }),
		propertyPath,
		localTime: Math.max(0, localTime),
		fallbackValue,
	}) as ParamValue;
}