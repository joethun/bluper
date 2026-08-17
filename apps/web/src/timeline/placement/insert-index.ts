import type { SceneTracks, TrackType } from "@/timeline";

export function getDefaultInsertIndexForTrack({
	tracks,
	trackType,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
}): number {
	if (trackType === "audio") {
		return tracks.overlay.length + 1 + tracks.audio.length;
	}

	if (trackType === "effect") {
		return 0;
	}

	return tracks.overlay.length;
}

export function getHighestInsertIndexForTrack({
	tracks,
	trackType,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
}): number {
	if (trackType === "audio") {
		return tracks.overlay.length + 1;
	}

	return 0;
}

export function resolvePreferredNewTrackPlacement({
	tracks,
	trackType,
	preferredIndex,
	direction,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
	preferredIndex: number;
	direction: "above" | "below";
}): {
	insertIndex: number;
	insertPosition: "above" | "below" | null;
	wasRedirected: boolean;
} {
	const trackCount = tracks.overlay.length + 1 + tracks.audio.length;
	if (trackCount === 0) {
		return {
			insertIndex: 0,
			insertPosition: trackType === "audio" ? "below" : null,
			wasRedirected: false,
		};
	}

	const safePreferredIndex = Math.min(
		Math.max(preferredIndex, 0),
		trackCount - 1,
	);
	const mainTrackIndex = tracks.overlay.length;

	if (trackType === "audio") {
		if (safePreferredIndex <= mainTrackIndex) {
			return {
				insertIndex: mainTrackIndex + 1,
				insertPosition: "below",
				wasRedirected: true,
			};
		}

		return {
			insertIndex:
				direction === "above" ? safePreferredIndex : safePreferredIndex + 1,
			insertPosition: direction,
			wasRedirected: false,
		};
	}

	const insertIndex =
		direction === "above" ? safePreferredIndex : safePreferredIndex + 1;
	if (mainTrackIndex >= 0 && insertIndex > mainTrackIndex) {
		return {
			insertIndex: mainTrackIndex,
			insertPosition: "above",
			wasRedirected: true,
		};
	}

	return {
		insertIndex,
		insertPosition: direction,
		wasRedirected: false,
	};
}
