import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { isEffectableElement, updateElementInSceneTracks } from "@/timeline";
import type { ParamValues } from "@/params";
import type { SceneTracks, EffectableElement } from "@/timeline";

function updateEffectParamsOnElement({
	element,
	effectId,
	params,
}: {
	element: EffectableElement;
	effectId: string;
	params: Partial<ParamValues>;
}): EffectableElement {
	const currentEffects = element.effects ?? [];
	const updated = currentEffects.map((effect) => {
		if (effect.id !== effectId) {
			return effect;
		}

		const nextParams = { ...effect.params };
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				nextParams[key] = value;
			}
		}

		return { ...effect, params: nextParams };
	});
	return { ...element, effects: updated };
}

export class UpdateClipEffectParamsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly effectId: string;
	private readonly params: Partial<ParamValues>;

	constructor({
		trackId,
		elementId,
		effectId,
		params,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		params: Partial<ParamValues>;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.effectId = effectId;
		this.params = params;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: isEffectableElement,
			update: (element) => {
				return updateEffectParamsOnElement({
					element: element as EffectableElement,
					effectId: this.effectId,
					params: this.params,
				});
			},
		});

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
