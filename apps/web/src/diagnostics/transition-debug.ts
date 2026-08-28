/**
 * Reports what each side of a cut contributes while a transition is running.
 *
 * A transition needs two clips on the frame at once, and every link in that
 * chain is silent when it breaks: a side that cannot decode a frame resolves to
 * `null` and simply is not drawn, which looks exactly like no transition at all.
 * The stored transition, the marker on the clip and the surrounding playback all
 * keep working, so there is nothing to see from the outside.
 *
 * Enable in the browser console, scrub through the cut, then disable:
 *
 *   window.__transitionDebug = true
 *
 * Zero overhead when off: `isTransitionDebugEnabled()` short-circuits on a
 * global read before anything is formatted.
 */

declare global {
	interface Window {
		__transitionDebug?: boolean;
	}
}

function isTransitionDebugEnabled(): boolean {
	return typeof window !== "undefined" && window.__transitionDebug === true;
}

function format({ value }: { value: number }): string {
	return Number(value.toFixed(3)).toString();
}

/**
 * A side that asked its decoder for a frame and got nothing. Inside a transition
 * window this is the failure that reads as a hard cut.
 */
export function logTransitionFrameMiss({
	mediaId,
	sinkKey,
	clipTime,
}: {
	mediaId: string;
	sinkKey: string | undefined;
	clipTime: number;
}): void {
	if (!isTransitionDebugEnabled()) {
		return;
	}

	console.warn(
		`[transition] NO FRAME  media=${mediaId} decoder=${
			sinkKey ?? "shared"
		} clipTime=${format({ value: clipTime })}`,
	);
}

/**
 * What one side resolved to for this frame. A healthy cross-fade prints an
 * `incoming` line whose opacity climbs and an `outgoing` line alongside it; a
 * missing line means that side produced no layer at all.
 */
export function logTransitionSide({
	clipTime,
	role,
	opacity,
	hasShape,
}: {
	clipTime: number;
	role: string;
	opacity: number;
	hasShape: boolean;
}): void {
	if (!isTransitionDebugEnabled()) {
		return;
	}

	console.log(
		`[transition] ${role.padEnd(8)} clipTime=${format({
			value: clipTime,
		})} opacity=${format({ value: opacity })}${hasShape ? " masked" : ""}`,
	);
}
