import { computeGroupResizeValue as _computeGroupResizeValue } from "bluper-wasm";
import type { FrameRate } from "bluper-wasm";
import type { ElementRef, RetimeConfig } from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Dragging the edge of one clip, or of several at once — owned by
 * `editor-core::timeline::group_resize`.
 *
 * A group resize applies a single delta to every member rather than dragging
 * each one, so the block keeps its shape. The delta is first narrowed to what
 * *every* member allows, and only then turned into patches.
 */

function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

export type ResizeSide = "left" | "right";

export interface GroupResizeMember extends ElementRef {
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	retime?: RetimeConfig;
	/**
	 * A held still. It shows one frame, so there is no source to run out of and
	 * no trim to walk — only the neighbours limit how far it can stretch.
	 */
	isFrozen?: boolean;
	leftNeighborBound: MediaTime | null;
	rightNeighborBound: MediaTime | null;
}

export interface GroupResizeUpdate extends ElementRef {
	patch: {
		trimStart: MediaTime;
		trimEnd: MediaTime;
		startTime: MediaTime;
		duration: MediaTime;
	};
}

export interface GroupResizeResult {
	deltaTime: MediaTime;
	updates: GroupResizeUpdate[];
}

export function computeGroupResize({
	members,
	side,
	deltaTime,
	fps,
}: {
	members: GroupResizeMember[];
	side: ResizeSide;
	deltaTime: MediaTime;
	fps: FrameRate;
}): GroupResizeResult {
	const result: unknown = _computeGroupResizeValue(
		wasmArgs({ args: { members, side, deltaTime, fps } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return result as GroupResizeResult;
}
