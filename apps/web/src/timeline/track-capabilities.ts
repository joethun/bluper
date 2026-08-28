import type {
	AdjustmentTrack,
	TimelineTrack,
	VideoTrack,
	AudioTrack,
	GraphicTrack,
	TextTrack,
	EffectTrack,
} from "@/timeline";

export function canTrackHaveAudio(
	track: TimelineTrack,
): track is VideoTrack | AudioTrack {
	return track.type === "audio" || track.type === "video";
}

export function canTrackBeHidden(
	track: TimelineTrack,
): track is
	| VideoTrack
	| TextTrack
	| GraphicTrack
	| EffectTrack
	| AdjustmentTrack {
	return track.type !== "audio";
}
