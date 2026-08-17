import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { ParamValues } from "@/params";
import type { SceneTracks } from "@/timeline";
import { updateElementInSceneTracks } from "@/timeline";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	canElementHaveTransition,
	getTransitionCutForElement,
} from "@/transitions";
import type { ElementTransition } from "@/transitions/types";
import { minMediaTime, type MediaTime } from "@/wasm";

/** Edits the transition already on a cut: its length or its own parameters. */
export class UpdateElementTransitionCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly duration?: MediaTime;
	private readonly params?: Partial<ParamValues>;

	constructor({
		trackId,
		elementId,
		duration,
		params,
	}: {
		trackId: string;
		elementId: string;
		duration?: MediaTime;
		params?: Partial<ParamValues>;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.duration = duration;
		this.params = params;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		const track = findTrackInSceneTracks({ tracks, trackId: this.trackId });
		if (!track) {
			return undefined;
		}

		const cut = getTransitionCutForElement({
			track,
			elementId: this.elementId,
		});
		if (!cut?.transition) {
			return undefined;
		}

		const existing = cut.transition;
		const transition: ElementTransition = {
			...existing,
			duration:
				this.duration === undefined
					? existing.duration
					: minMediaTime({ a: this.duration, b: cut.maxDuration }),
			params: this.params
				? { ...existing.params, ...stripUndefined({ params: this.params }) }
				: existing.params,
		};

		this.savedState = tracks;
		editor.timeline.updateTracks(
			updateElementInSceneTracks({
				tracks,
				trackId: this.trackId,
				elementId: cut.incomingId,
				elementPredicate: (candidate) =>
					canElementHaveTransition({ element: candidate }),
				update: (candidate) => ({ ...candidate, transitionIn: transition }),
			}),
		);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}

function stripUndefined({
	params,
}: {
	params: Partial<ParamValues>;
}): ParamValues {
	const result: ParamValues = {};
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}
