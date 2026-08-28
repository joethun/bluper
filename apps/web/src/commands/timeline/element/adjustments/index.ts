import { Command, type CommandResult } from "@/commands/base-command";
import { buildAdjustmentInstance } from "@/adjustments";
import type { Adjustment } from "@/adjustments/types";
import { EditorCore } from "@/core";
import type { ParamValues } from "@/params";
import type { AdjustmentElement, SceneTracks, TimelineElement } from "@/timeline";
import { updateElementInSceneTracks } from "@/timeline";

function isAdjustmentElement(
	element: TimelineElement,
): element is AdjustmentElement {
	return element.type === "adjustment";
}

/**
 * Shared plumbing for the adjustment-stack commands: snapshot the scene, rewrite
 * one adjustment layer's stack, push the result.
 */
abstract class AdjustmentStackCommand extends Command {
	private savedState: SceneTracks | null = null;
	protected readonly trackId: string;
	protected readonly elementId: string;

	constructor({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
	}

	protected abstract nextStack({
		adjustments,
	}: {
		adjustments: Adjustment[];
	}): Adjustment[];

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		editor.timeline.updateTracks(
			updateElementInSceneTracks({
				tracks: this.savedState,
				trackId: this.trackId,
				elementId: this.elementId,
				elementPredicate: isAdjustmentElement,
				update: (element) => {
					if (!isAdjustmentElement(element)) {
						return element;
					}
					return {
						...element,
						adjustments: this.nextStack({ adjustments: element.adjustments }),
					};
				},
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

export class AddAdjustmentCommand extends AdjustmentStackCommand {
	private readonly adjustmentType: string;
	private adjustmentId: string | null = null;

	constructor({
		trackId,
		elementId,
		adjustmentType,
	}: {
		trackId: string;
		elementId: string;
		adjustmentType: string;
	}) {
		super({ trackId, elementId });
		this.adjustmentType = adjustmentType;
	}

	getAdjustmentId(): string | null {
		return this.adjustmentId;
	}

	protected nextStack({
		adjustments,
	}: {
		adjustments: Adjustment[];
	}): Adjustment[] {
		const existing = adjustments.find(
			(adjustment) => adjustment.type === this.adjustmentType,
		);
		if (existing) {
			// One entry per adjustment group: a second copy of the same sliders would
			// silently fight the first.
			this.adjustmentId = existing.id;
			return adjustments;
		}

		const instance = buildAdjustmentInstance({
			adjustmentType: this.adjustmentType,
		});
		this.adjustmentId = instance.id;
		return [...adjustments, instance];
	}
}

export class RemoveAdjustmentCommand extends AdjustmentStackCommand {
	private readonly adjustmentId: string;

	constructor({
		trackId,
		elementId,
		adjustmentId,
	}: {
		trackId: string;
		elementId: string;
		adjustmentId: string;
	}) {
		super({ trackId, elementId });
		this.adjustmentId = adjustmentId;
	}

	protected nextStack({
		adjustments,
	}: {
		adjustments: Adjustment[];
	}): Adjustment[] {
		return adjustments.filter(
			(adjustment) => adjustment.id !== this.adjustmentId,
		);
	}
}

export class ToggleAdjustmentCommand extends AdjustmentStackCommand {
	private readonly adjustmentId: string;

	constructor({
		trackId,
		elementId,
		adjustmentId,
	}: {
		trackId: string;
		elementId: string;
		adjustmentId: string;
	}) {
		super({ trackId, elementId });
		this.adjustmentId = adjustmentId;
	}

	protected nextStack({
		adjustments,
	}: {
		adjustments: Adjustment[];
	}): Adjustment[] {
		return adjustments.map((adjustment) =>
			adjustment.id === this.adjustmentId
				? { ...adjustment, enabled: !adjustment.enabled }
				: adjustment,
		);
	}
}

export class UpdateAdjustmentParamsCommand extends AdjustmentStackCommand {
	private readonly adjustmentId: string;
	private readonly params: Partial<ParamValues>;

	constructor({
		trackId,
		elementId,
		adjustmentId,
		params,
	}: {
		trackId: string;
		elementId: string;
		adjustmentId: string;
		params: Partial<ParamValues>;
	}) {
		super({ trackId, elementId });
		this.adjustmentId = adjustmentId;
		this.params = params;
	}

	protected nextStack({
		adjustments,
	}: {
		adjustments: Adjustment[];
	}): Adjustment[] {
		return adjustments.map((adjustment) => {
			if (adjustment.id !== this.adjustmentId) {
				return adjustment;
			}

			const params: ParamValues = { ...adjustment.params };
			for (const [key, value] of Object.entries(this.params)) {
				if (value !== undefined) {
					params[key] = value;
				}
			}
			return { ...adjustment, params };
		});
	}
}
