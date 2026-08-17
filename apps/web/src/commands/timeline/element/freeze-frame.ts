import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import { DEFAULT_FREEZE_DURATION, freezeFrameInTracks } from "@/freeze";
import type { SceneTracks } from "@/timeline";
import { generateUUID } from "@/utils/id";
import type { MediaTime } from "@/wasm";

/**
 * Freezes the frame under the playhead, the way CapCut's snowflake does: the clip
 * is cut at the playhead, a held still is inserted at the cut, and everything
 * after it on the same track slides right to make room.
 */
export class FreezeFrameCommand extends Command {
	private savedState: SceneTracks | null = null;
	private frozenElementId: string | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly freezeTime: MediaTime;
	private readonly freezeDuration: MediaTime;
	private readonly bakedMediaId?: string;

	constructor({
		trackId,
		elementId,
		freezeTime,
		freezeDuration = DEFAULT_FREEZE_DURATION,
		bakedMediaId,
	}: {
		trackId: string;
		elementId: string;
		freezeTime: MediaTime;
		freezeDuration?: MediaTime;
		bakedMediaId?: string;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.freezeTime = freezeTime;
		this.freezeDuration = freezeDuration;
		this.bakedMediaId = bakedMediaId;
	}

	getFrozenElementId(): string | null {
		return this.frozenElementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		const frozenElementId = generateUUID();
		const nextTracks = freezeFrameInTracks({
			tracks,
			trackId: this.trackId,
			elementId: this.elementId,
			freezeTime: this.freezeTime,
			freezeDuration: this.freezeDuration,
			bakedMediaId: this.bakedMediaId,
			ids: { frozenElementId, splitElementId: generateUUID() },
		});
		if (!nextTracks) {
			return undefined;
		}

		this.savedState = tracks;
		this.frozenElementId = frozenElementId;
		editor.timeline.updateTracks(nextTracks);

		return createElementSelectionResult([
			{ trackId: this.trackId, elementId: frozenElementId },
		]);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
