/**
 * Snapping moved to `editor-core::timeline::snapping`. The composition that used
 * to take a list of source closures is now one call that names which sources a
 * gesture wants: functions cannot cross the wasm boundary, and the three call
 * sites only ever varied in which sources they included and in what order.
 */
export {
	buildElementGestureSnapPoints,
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/wasm/snapping";
