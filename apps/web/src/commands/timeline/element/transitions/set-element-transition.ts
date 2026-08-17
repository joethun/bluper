import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";
import { updateElementInSceneTracks } from "@/timeline";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	buildTransitionInstance,
	canElementHaveTransition,
	getTransitionCutForElement,
} from "@/transitions";
import type { ElementTransition } from "@/transitions/types";
import { minMediaTime, type MediaTime } from "@/wasm";

/**
 * Applies a transition to the cut at `elementId`'s leading edge. A transition
 * joins two clips, so the call is a no-op when that clip shares no cut with the
 * one before it — dropping onto a lone clip has nothing to bridge.
 *
 * Neither clip moves and the project keeps its length: the blend is paid for out
 * of the material the two clips' trims are hiding, not out of the timeline.
 */
export class SetElementTransitionCommand extends Command {
	private savedState: SceneTracks | null = null;
	private transitionId: string | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly transitionType: string;
	private readonly duration?: MediaTime;

	constructor({
		trackId,
		elementId,
		transitionType,
		duration,
	}: {
		trackId: string;
		elementId: string;
		transitionType: string;
		duration?: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.transitionType = transitionType;
		this.duration = duration;
	}

	getTransitionId(): string | null {
		return this.transitionId;
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
		if (!cut) {
			return undefined;
		}

		const instance = buildTransitionInstance({
			transitionType: this.transitionType,
			duration: this.duration,
		});
		const transition: ElementTransition = {
			...instance,
			duration: minMediaTime({ a: instance.duration, b: cut.maxDuration }),
		};
		if (transition.duration <= 0) {
			return undefined;
		}

		this.savedState = tracks;
		this.transitionId = transition.id;

		editor.timeline.updateTracks(
			updateElementInSceneTracks({
				tracks,
				trackId: this.trackId,
				elementId: cut.incomingId,
				elementPredicate: (element) => canElementHaveTransition({ element }),
				update: (element) => ({ ...element, transitionIn: transition }),
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
