import { getSourceTimeAtClipTime } from "@/retime";
import {
	FREEZABLE_ELEMENT_TYPES,
	type FreezableElement,
	type FreezeConfig,
	type ImageElement,
	type RetimeConfig,
	type SceneTracks,
	type TimelineElement,
} from "@/timeline/types";
import {
	addMediaTime,
	clampMediaTime,
	mediaTime,
	resolveSampledSourceTime as _resolveSampledSourceTime,
	roundMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/** CapCut inserts a three second still, and so do we. */
export const DEFAULT_FREEZE_DURATION = mediaTime({
	ticks: 3 * TICKS_PER_SECOND,
});

export function isFreezableElement(
	element: TimelineElement,
): element is FreezableElement {
	return (FREEZABLE_ELEMENT_TYPES as readonly string[]).includes(element.type);
}

export function isFrozenElement({
	element,
}: {
	element: TimelineElement;
}): boolean {
	return "freeze" in element && element.freeze !== undefined;
}

/**
 * The source time a clip samples at `clipTime`. A frozen clip ignores its own
 * progress and holds the pinned frame for its whole span; everything else walks
 * the source at whatever rate retime asks for. `clipDuration` is what places a
 * speed curve's handles in time, so a curved clip needs it to answer exactly.
 *
 * Both the preview and the exporter go through here, so a still looks the same
 * on screen as it does in the finished file.
 *
 * Math now owned by `editor-core::freeze`.
 */
export function resolveSampledSourceTime({
	freeze,
	trimStart,
	clipTime,
	clipDuration,
	retime,
}: {
	freeze?: FreezeConfig;
	trimStart: number;
	clipTime: number;
	clipDuration?: number;
	retime?: RetimeConfig;
}): MediaTime {
	return _resolveSampledSourceTime({
		freeze,
		trimStart,
		clipTime,
		clipDuration,
		retime,
	});
}

/**
 * Whether a still can be dropped at `time` on this element. The span is
 * half-open, the same way the renderer treats it: a clip owns its start frame
 * but not the frame at its end, so at a cut you freeze the frame you can see
 * rather than the one that just left the screen.
 */
export function canFreezeElementAtTime({
	element,
	time,
}: {
	element: TimelineElement;
	time: MediaTime;
}): boolean {
	if (!isFreezableElement(element)) {
		return false;
	}

	const end = addMediaTime({ a: element.startTime, b: element.duration });
	return time >= element.startTime && time < end;
}

/**
 * Picks the clip a freeze should act on: the selection when it names exactly one
 * freezable clip under the playhead, otherwise the topmost visible clip the
 * playhead is over. Overlay tracks are searched before the main track, so an
 * unprompted freeze lands on the layer the user is actually looking at.
 *
 * An explicit selection wins even if it is hidden — the user named it.
 */
export function findFreezeTarget({
	tracks,
	time,
	selectedElements,
}: {
	tracks: SceneTracks;
	time: MediaTime;
	selectedElements: readonly { trackId: string; elementId: string }[];
}): { trackId: string; elementId: string } | null {
	const candidates =
		selectedElements.length === 1
			? selectedElements
			: [...tracks.overlay, tracks.main]
					.filter((track) => !track.hidden)
					.flatMap((track) =>
						track.elements
							.filter((element) => !("hidden" in element && element.hidden))
							.map((element) => ({
								trackId: track.id,
								elementId: element.id,
							})),
					);

	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	for (const candidate of candidates) {
		const element = allTracks
			.find((track) => track.id === candidate.trackId)
			?.elements.find(({ id }) => id === candidate.elementId);
		if (element && canFreezeElementAtTime({ element, time })) {
			return candidate;
		}
	}

	return null;
}

/**
 * The source time a clip is showing at a given timeline time — the frame a freeze
 * has to hold. Retime is folded in, so freezing a slowed-down clip holds the
 * frame that is actually on screen.
 */
export function getSourceTimeAtTimelineTime({
	element,
	time,
}: {
	element: FreezableElement;
	time: MediaTime;
}): MediaTime {
	if (element.freeze) {
		// Already a still: every timeline time maps to the one held frame.
		return element.freeze.sourceTime;
	}

	const clipTime = subMediaTime({ a: time, b: element.startTime });
	const sourceSpan = roundMediaTime({
		time: getSourceTimeAtClipTime({
			clipTime,
			clipDuration: element.duration,
			retime: element.retime,
		}),
	});
	const availableSpan = roundMediaTime({
		time: getSourceTimeAtClipTime({
			clipTime: element.duration,
			clipDuration: element.duration,
			retime: element.retime,
		}),
	});

	return clampMediaTime({
		time: mediaTime({ ticks: element.trimStart + sourceSpan }),
		min: ZERO_MEDIA_TIME,
		max: mediaTime({ ticks: element.trimStart + availableSpan }),
	});
}

/**
 * Turns a clip into a held still. The freeze marker pins the sampled frame, and
 * the trim is collapsed onto that frame so resizing the segment stretches the
 * hold instead of scrubbing the source.
 */
export function buildFrozenElement({
	element,
	sourceTime,
	startTime,
	duration,
	id,
}: {
	element: FreezableElement;
	sourceTime: MediaTime;
	startTime: MediaTime;
	duration: MediaTime;
	id: string;
}): FreezableElement {
	const frozen: FreezableElement = {
		...element,
		id,
		name: `${element.name} (frozen)`,
		startTime,
		duration,
		trimStart: sourceTime,
		trimEnd: ZERO_MEDIA_TIME,
		freeze: { sourceTime },
		params: {
			...element.params,
			// A still has no audio to play, and holding one sample would either
			// click or drone. CapCut mutes the frozen segment for the same reason.
			muted: true,
		},
		animations: undefined,
	};

	// Retime is meaningless on a still and would only confuse the speed panel.
	delete frozen.retime;
	// The invented boundary never had a transition of its own.
	delete frozen.transitionIn;

	return frozen;
}

/**
 * A still whose picture was rendered ahead of time and stored as an image, used
 * when the freeze lands inside a transition. Everything the clip contributes —
 * its transform, opacity, effects, masks and the transition blend itself — is
 * already in those pixels, so the element carries none of it: applying any of it
 * again would double it up.
 */
export function buildBakedStillElement({
	element,
	mediaId,
	startTime,
	duration,
	id,
}: {
	element: TimelineElement;
	mediaId: string;
	startTime: MediaTime;
	duration: MediaTime;
	id: string;
}): ImageElement {
	return {
		id,
		type: "image",
		name: `${element.name} (frozen)`,
		startTime,
		duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId,
		params: { opacity: 1 },
	};
}
