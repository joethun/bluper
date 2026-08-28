import {
	buildGroupMoveSnapPoints as _buildGroupMoveSnapPoints,
	buildMoveGroupValue as _buildMoveGroupValue,
	resolveGroupMoveSnapValue as _resolveGroupMoveSnapValue,
	resolveGroupMoveValue as _resolveGroupMoveValue,
} from "bluper-wasm";
import type {
	ElementRef,
	ElementType,
	SceneTracks,
	TrackType,
} from "@/timeline/types";
import type { SnapPoint } from "@/wasm/snapping";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Moving a selection of clips as one block, owned by
 * `editor-core::timeline::group_move`.
 *
 * Nothing here mutates the scene. Every function answers with a plan, or with
 * `null` when the move is not possible, which is what lets the drag preview show
 * the same verdict the drop will reach.
 */

function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

type GroupTrackSection = "overlay" | "main" | "audio";

interface GroupMember extends ElementRef {
	elementType: ElementType;
	duration: MediaTime;
	/**
	 * Signed offset from the anchor's start, so a member ahead of the anchor
	 * carries a negative one.
	 */
	timeOffset: MediaTime;
	trackSection: GroupTrackSection;
	sectionIndex: number;
	displayIndex: number;
}

export interface MoveGroup {
	anchor: GroupMember;
	members: GroupMember[];
}

export interface PlannedTrackCreation {
	id: string;
	type: TrackType;
	index: number;
}

export interface PlannedElementMove {
	sourceTrackId: string;
	targetTrackId: string;
	elementId: string;
	newStartTime: MediaTime;
}

export interface GroupMoveResult {
	moves: PlannedElementMove[];
	createTracks: PlannedTrackCreation[];
	targetSelection: ElementRef[];
}

type GroupMoveTarget =
	| { kind: "existingTrack"; anchorTargetTrackId: string }
	| {
			kind: "newTracks";
			anchorInsertIndex: number;
			newTrackIds: string[];
	  };

/**
 * Read the selection into a group: the anchor, and every other selected element
 * with its offset from it recorded. Elements that no longer exist are dropped
 * rather than failing the whole gesture.
 */
export function buildMoveGroup({
	anchorRef,
	selectedElements,
	tracks,
}: {
	anchorRef: ElementRef;
	selectedElements: ElementRef[];
	tracks: SceneTracks;
}): MoveGroup | null {
	const { group }: { group: unknown } = _buildMoveGroupValue(
		wasmArgs({ args: { anchorRef, selectedElements, tracks } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (group as MoveGroup | undefined) ?? null;
}

export function resolveGroupMove({
	group,
	tracks,
	anchorStartTime,
	target,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	target: GroupMoveTarget;
}): GroupMoveResult | null {
	const { result }: { result: unknown } = _resolveGroupMoveValue(
		wasmArgs({ args: { group, tracks, anchorStartTime, target } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (result as GroupMoveResult | undefined) ?? null;
}

/**
 * Snap candidates for a group move, excluding the members being dragged.
 * Callers that resolve snap every mousemove should build this once at gesture
 * start — the inputs are fixed for the duration of the drag.
 */
export function buildGroupMoveSnapPoints({
	group,
	tracks,
	playheadTime,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	playheadTime: MediaTime;
}): SnapPoint[] {
	const { snapPoints }: { snapPoints: unknown } = _buildGroupMoveSnapPoints(
		wasmArgs({ args: { group, tracks, playheadTime } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return snapPoints as SnapPoint[];
}

/**
 * The anchor start time that puts whichever group edge is closest to a candidate
 * onto it. Every member's start *and* end is a candidate edge, so a clip at the
 * back of the selection can be what snaps.
 */
export function resolveGroupMoveSnap({
	group,
	anchorStartTime,
	snapPoints,
	zoomLevel,
}: {
	group: MoveGroup;
	anchorStartTime: MediaTime;
	snapPoints: SnapPoint[];
	zoomLevel: number;
}): {
	snappedAnchorStartTime: MediaTime;
	snapPoint: SnapPoint | null;
} {
	const value: unknown = _resolveGroupMoveSnapValue(
		wasmArgs({ args: { group, anchorStartTime, snapPoints, zoomLevel } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const result = value as {
		snappedAnchorStartTime: MediaTime;
		snapPoint?: SnapPoint;
	};
	return {
		snappedAnchorStartTime: result.snappedAnchorStartTime,
		snapPoint: result.snapPoint ?? null,
	};
}
