import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";
import { updateElementInSceneTracks } from "@/timeline";
import { stripTransitionIn } from "@/transitions";

export class RemoveElementTransitionCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;

	constructor({ trackId, elementId }: { trackId: string; elementId: string }) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		editor.timeline.updateTracks(
			updateElementInSceneTracks({
				tracks: this.savedState,
				trackId: this.trackId,
				elementId: this.elementId,
				update: (element) => stripTransitionIn({ element }),
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
