import type { SceneTracks, TrackType, TimelineTrack } from "@/timeline";
import {
	getDefaultInsertIndexForTrack,
	getHighestInsertIndexForTrack,
	resolvePreferredNewTrackPlacement,
} from "./insert-index";
import { getTrackTypeForElementType } from "./compatibility";
import { canPlaceTimeSpansOnTrack } from "./overlap";
import type {
	PlacementResult,
	PlacementStrategy,
	PlacementSubject,
	PlacementTimeSpan,
} from "./types";

type ResolveTrackPlacementParams = PlacementSubject & {
	tracks: SceneTracks;
	timeSpans: PlacementTimeSpan[];
	strategy: PlacementStrategy;
};

/**
 * Placement answers which track something lands on, never when. A track takes
 * an element wherever the caller asked for it, so long as nothing is already
 * there — the main track included, which is free to start with a gap like any
 * other.
 */
function buildExistingTrackResult({
	track,
	trackIndex,
}: {
	track: TimelineTrack;
	trackIndex: number;
}): PlacementResult {
	return {
		kind: "existingTrack",
		trackId: track.id,
		trackIndex,
		trackType: track.type,
	};
}

function buildNewTrackResult({
	trackType,
	insertIndex,
	insertPosition,
}: {
	trackType: TrackType;
	insertIndex: number;
	insertPosition: "above" | "below" | null;
}): PlacementResult {
	return {
		kind: "newTrack",
		trackType,
		insertIndex,
		insertPosition,
	};
}

function findFirstAvailableTrackIndex({
	tracks,
	trackType,
	timeSpans,
}: {
	tracks: TimelineTrack[];
	trackType: TrackType;
	timeSpans: PlacementTimeSpan[];
}): number {
	return tracks.findIndex((track) => {
		return (
			track.type === trackType &&
			canPlaceTimeSpansOnTrack({
				track,
				timeSpans,
			})
		);
	});
}

function resolveAlwaysNewTrack({
	tracks,
	trackType,
	position,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
	position: "highest" | "default";
}): PlacementResult {
	const insertIndex =
		position === "highest"
			? getHighestInsertIndexForTrack({
					tracks,
					trackType,
				})
			: getDefaultInsertIndexForTrack({
					tracks,
					trackType,
				});

	return buildNewTrackResult({
		trackType,
		insertIndex,
		insertPosition: null,
	});
}

function getInsertDirection({
	hoverDirection,
	verticalDragDirection,
}: {
	hoverDirection: "above" | "below";
	verticalDragDirection?: "up" | "down" | null;
}): "above" | "below" {
	if (verticalDragDirection === "up") {
		return "above";
	}

	if (verticalDragDirection === "down") {
		return "below";
	}

	return hoverDirection;
}

export function resolveTrackPlacement({
	tracks,
	sourceTrackId,
	...placement
}: ResolveTrackPlacementParams & {
	sourceTrackId?: string;
}): PlacementResult | null {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const trackType =
		"trackType" in placement
			? placement.trackType
			: getTrackTypeForElementType({
					elementType: placement.elementType,
				});
	const { timeSpans, strategy } = placement;

	if (strategy.type === "explicit") {
		const trackIndex = orderedTracks.findIndex(
			(track) => track.id === strategy.trackId,
		);
		if (trackIndex < 0) {
			return null;
		}

		const track = orderedTracks[trackIndex];
		if (track.type !== trackType) {
			return null;
		}

		return buildExistingTrackResult({
			track,
			trackIndex,
		});
	}

	if (strategy.type === "firstAvailable") {
		const existingTrackIndex = findFirstAvailableTrackIndex({
			tracks: orderedTracks,
			trackType,
			timeSpans,
		});
		if (existingTrackIndex >= 0) {
			return buildExistingTrackResult({
				track: orderedTracks[existingTrackIndex],
				trackIndex: existingTrackIndex,
			});
		}

		return resolveAlwaysNewTrack({
			tracks,
			trackType,
			position: "highest",
		});
	}

	if (strategy.type === "preferIndex") {
		const preferredTrack = orderedTracks[strategy.trackIndex];
		const isPreferredTrackCompatible =
			!!preferredTrack && preferredTrack.type === trackType;
		const canUseExistingTrack =
			!strategy.createNewTrackOnly &&
			isPreferredTrackCompatible &&
			canPlaceTimeSpansOnTrack({
				track: preferredTrack,
				timeSpans,
			});
		if (canUseExistingTrack) {
			return buildExistingTrackResult({
				track: preferredTrack,
				trackIndex: strategy.trackIndex,
			});
		}

		const { insertIndex, insertPosition, wasRedirected } =
			resolvePreferredNewTrackPlacement({
				tracks,
				trackType,
				preferredIndex: strategy.trackIndex,
				direction: getInsertDirection({
					hoverDirection: strategy.hoverDirection,
					verticalDragDirection: !isPreferredTrackCompatible
						? strategy.verticalDragDirection
						: null,
				}),
			});

		if (wasRedirected && sourceTrackId) {
			const sourceTrackIndex = orderedTracks.findIndex(
				(track) => track.id === sourceTrackId && track.type === trackType,
			);
			if (sourceTrackIndex >= 0) {
				return buildExistingTrackResult({
					track: orderedTracks[sourceTrackIndex],
					trackIndex: sourceTrackIndex,
				});
			}
		}

		return buildNewTrackResult({
			trackType,
			insertIndex,
			insertPosition,
		});
	}

	if (strategy.type === "aboveSource") {
		const aboveTrackIndex = strategy.sourceTrackIndex - 1;
		const aboveTrack = orderedTracks[aboveTrackIndex];
		if (
			aboveTrack &&
			aboveTrack.type === trackType &&
			canPlaceTimeSpansOnTrack({
				track: aboveTrack,
				timeSpans,
			})
		) {
			return buildExistingTrackResult({
				track: aboveTrack,
				trackIndex: aboveTrackIndex,
			});
		}

		const firstAvailableTrackIndex = findFirstAvailableTrackIndex({
			tracks: orderedTracks,
			trackType,
			timeSpans,
		});
		if (firstAvailableTrackIndex >= 0) {
			return buildExistingTrackResult({
				track: orderedTracks[firstAvailableTrackIndex],
				trackIndex: firstAvailableTrackIndex,
			});
		}

		const insertIndex = getHighestInsertIndexForTrack({
			tracks,
			trackType,
		});

		return buildNewTrackResult({
			trackType,
			insertIndex,
			insertPosition: null,
		});
	}

	return resolveAlwaysNewTrack({
		tracks,
		trackType,
		position: strategy.position,
	});
}
