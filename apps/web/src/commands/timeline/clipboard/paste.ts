import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement } from "@/timeline";
import type { ElementClipboardItem } from "@/clipboard";
import { generateUUID } from "@/utils/id";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { createGroupId } from "@/wasm/timeline";
import { cloneAnimations } from "@/animation";
import {
	addMediaTime,
	type MediaTime,
	maxMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export class PasteCommand extends Command {
	private savedState: SceneTracks | null = null;
	private pastedElements: { trackId: string; elementId: string }[] = [];
	private readonly time: MediaTime;
	private readonly clipboardItems: ElementClipboardItem[];

	constructor({
		time,
		clipboardItems,
	}: {
		time: MediaTime;
		clipboardItems: ElementClipboardItem[];
	}) {
		super();
		this.time = time;
		this.clipboardItems = clipboardItems;
	}

	execute(): CommandResult | undefined {
		if (this.clipboardItems.length === 0) return undefined;

		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		this.pastedElements = [];

		const minStart = this.clipboardItems.reduce(
			(earliestStartTime, item) =>
				item.element.startTime < earliestStartTime
					? item.element.startTime
					: earliestStartTime,
			this.clipboardItems[0].element.startTime,
		);

		let updatedTracks = this.savedState;
		const itemsByTrackId = groupClipboardItemsByTrackId({
			clipboardItems: this.clipboardItems,
		});
		// Pasted copies form groups of their own rather than rejoining the ones
		// they were cut from. Shared across tracks so a group whose members sat on
		// different tracks arrives as one group again.
		const groupIdRemap = new Map<string, string>();

		for (const [trackId, items] of itemsByTrackId) {
			const elementsToAdd = buildPastedElements({
				items,
				minStart,
				time: this.time,
				groupIdRemap,
			});

			if (elementsToAdd.length === 0) {
				continue;
			}

			const trackType = items[0].trackType;
			const sourceTrackIndex = [
				...updatedTracks.overlay,
				updatedTracks.main,
				...updatedTracks.audio,
			].findIndex((track) => track.id === trackId);
			const placementResult = resolveTrackPlacement({
				tracks: updatedTracks,
				trackType,
				timeSpans: elementsToAdd.map((element) => ({
					startTime: element.startTime,
					duration: element.duration,
				})),
				strategy: { type: "aboveSource", sourceTrackIndex },
			});
			if (!placementResult) {
				continue;
			}

			const applied = applyPlacement({
				tracks: updatedTracks,
				placementResult,
				elements: elementsToAdd,
			});
			if (!applied) {
				continue;
			}

			updatedTracks = applied.updatedTracks;

			for (const element of elementsToAdd) {
				this.pastedElements.push({
					trackId: applied.targetTrackId,
					elementId: element.id,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);

		if (this.pastedElements.length > 0) {
			return createElementSelectionResult(this.pastedElements);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getPastedElements(): { trackId: string; elementId: string }[] {
		return this.pastedElements;
	}
}

function groupClipboardItemsByTrackId({
	clipboardItems,
}: {
	clipboardItems: ElementClipboardItem[];
}): Map<string, ElementClipboardItem[]> {
	const groupedItems = new Map<string, ElementClipboardItem[]>();

	for (const item of clipboardItems) {
		const existingItems = groupedItems.get(item.trackId) ?? [];
		groupedItems.set(item.trackId, [...existingItems, item]);
	}

	return groupedItems;
}

function buildPastedElements({
	items,
	minStart,
	time,
	groupIdRemap,
}: {
	items: ElementClipboardItem[];
	minStart: MediaTime;
	time: MediaTime;
	groupIdRemap: Map<string, string>;
}): TimelineElement[] {
	const elementsToAdd: TimelineElement[] = [];

	for (const item of items) {
		const relativeOffset = subMediaTime({
			a: item.element.startTime,
			b: minStart,
		});
		const startTime = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: addMediaTime({ a: time, b: relativeOffset }),
		});
		const newElementId = generateUUID();

		elementsToAdd.push({
			...item.element,
			id: newElementId,
			startTime,
			groupId: remapGroupId({
				groupId: item.element.groupId,
				remap: groupIdRemap,
			}),
			animations: cloneAnimations({
				animations: item.element.animations,
				shouldRegenerateKeyframeIds: true,
			}),
		} as TimelineElement);
	}

	return elementsToAdd;
}

function remapGroupId({
	groupId,
	remap,
}: {
	groupId: string | undefined;
	remap: Map<string, string>;
}): string | undefined {
	if (!groupId) {
		return undefined;
	}

	const existing = remap.get(groupId);
	if (existing) {
		return existing;
	}

	const nextGroupId = createGroupId();
	remap.set(groupId, nextGroupId);
	return nextGroupId;
}
