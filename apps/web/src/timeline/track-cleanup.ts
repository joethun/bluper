import type { SceneTracks, TimelineTrack } from "@/timeline";

export function autoDeleteEmptyTracks({
	tracks,
	oldTracks,
}: {
	tracks: SceneTracks;
	oldTracks: SceneTracks;
}): SceneTracks {
	return {
		...tracks,
		overlay: tracks.overlay.filter((track) =>
			shouldKeepTrack({
				track,
				oldTrack: findOldTrack({
					oldTracks: oldTracks.overlay,
					trackId: track.id,
				}),
			}),
		),
		audio: tracks.audio.filter((track) =>
			shouldKeepTrack({
				track,
				oldTrack: findOldTrack({
					oldTracks: oldTracks.audio,
					trackId: track.id,
				}),
			}),
		),
	};
}

function findOldTrack({
	oldTracks,
	trackId,
}: {
	oldTracks: TimelineTrack[];
	trackId: string;
}): TimelineTrack | undefined {
	return oldTracks.find((oldTrack) => oldTrack.id === trackId);
}

function shouldKeepTrack({
	track,
	oldTrack,
}: {
	track: TimelineTrack;
	oldTrack: TimelineTrack | undefined;
}): boolean {
	if (!oldTrack) {
		return true;
	}
	if (oldTrack.elements.length === 0) {
		return true;
	}
	return track.elements.length > 0;
}