/**
 * Group moves moved to `editor-core::timeline::group_move`.
 */
export {
	buildGroupMoveSnapPoints,
	buildMoveGroup,
	resolveGroupMove,
	resolveGroupMoveSnap,
	type GroupMoveResult,
	type MoveGroup,
	type PlannedElementMove,
	type PlannedTrackCreation,
} from "@/wasm/group-move";
