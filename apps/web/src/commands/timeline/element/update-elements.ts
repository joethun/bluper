import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import {
	findTrackInSceneTracks,
	updateElementInSceneTracks,
} from "@/timeline";
import { shiftElementsClearOfElement } from "@/timeline/make-room";
import { applyElementUpdate } from "@/timeline/update-pipeline";

export class UpdateElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly updates: Array<{
		trackId: string;
		elementId: string;
		patch: Partial<TimelineElement>;
	}>;

	constructor({
		updates,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			patch: Partial<TimelineElement>;
		}>;
	}) {
		super();
		this.updates = updates;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		let updatedTracks = this.savedState;

		for (const updateEntry of this.updates) {
			const currentTrack = findTrackInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
			});
			const currentElement = currentTrack?.elements.find(
				(element) => element.id === updateEntry.elementId,
			);
			if (!currentTrack || !currentElement) {
				continue;
			}

			const nextElement = applyElementUpdate({
				element: currentElement,
				patch: updateEntry.patch,
				context: {
					tracks: updatedTracks,
					trackId: updateEntry.trackId,
				},
			});

			updatedTracks = updateElementInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
				elementId: updateEntry.elementId,
				update: () => nextElement,
			});

			// A speed change derives a new length rather than being dragged to one,
			// so nothing has already stopped it at the neighbour. Where the clip now
			// reaches past what follows it, the rest of the track gives way.
			const previousEnd = currentElement.startTime + currentElement.duration;
			const nextEnd = nextElement.startTime + nextElement.duration;
			if (nextEnd > previousEnd) {
				updatedTracks = shiftElementsClearOfElement({
					tracks: updatedTracks,
					trackId: updateEntry.trackId,
					element: nextElement,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
