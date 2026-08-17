import type { ElementRef, SceneTracks, TimelineElement } from "./types";

/**
 * Grouping ties elements together across tracks so a cut assembled out of
 * several layers — a shot, its title, the sting under it — moves and dies as
 * one thing. Membership is a shared id on each element rather than a container
 * object, which keeps a group free of any position in the track order and lets
 * an element leave one simply by losing the id.
 */
export function createGroupId(): string {
	return `group-${crypto.randomUUID()}`;
}

function allTracks({ tracks }: { tracks: SceneTracks }) {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function elementRefsWhere({
	tracks,
	predicate,
}: {
	tracks: SceneTracks;
	predicate: (element: TimelineElement) => boolean;
}): ElementRef[] {
	return allTracks({ tracks }).flatMap((track) =>
		track.elements
			.filter(predicate)
			.map((element) => ({ trackId: track.id, elementId: element.id })),
	);
}

function findElement({
	tracks,
	ref,
}: {
	tracks: SceneTracks;
	ref: ElementRef;
}): TimelineElement | null {
	const track = allTracks({ tracks }).find(
		(candidate) => candidate.id === ref.trackId,
	);
	return (
		track?.elements.find((element) => element.id === ref.elementId) ?? null
	);
}

/** Every element carrying `groupId`, wherever it sits. */
function getGroupMembers({
	tracks,
	groupId,
}: {
	tracks: SceneTracks;
	groupId: string;
}): ElementRef[] {
	return elementRefsWhere({
		tracks,
		predicate: (element) => element.groupId === groupId,
	});
}

/** The group ids touched by a set of elements, deduplicated. */
function getGroupIds({
	tracks,
	elements,
}: {
	tracks: SceneTracks;
	elements: readonly ElementRef[];
}): string[] {
	const groupIds = new Set<string>();
	for (const ref of elements) {
		const groupId = findElement({ tracks, ref })?.groupId;
		if (groupId) {
			groupIds.add(groupId);
		}
	}
	return [...groupIds];
}

function dedupeRefs({ refs }: { refs: readonly ElementRef[] }): ElementRef[] {
	const seen = new Set<string>();
	const result: ElementRef[] = [];
	for (const ref of refs) {
		const key = `${ref.trackId}:${ref.elementId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(ref);
	}
	return result;
}

/**
 * Pulls in the rest of every group the given elements belong to.
 *
 * Applied wherever a selection is set, so picking up one member of a group
 * always picks up the whole of it — the property that makes a group behave as
 * one object for dragging, deleting and every other selection-driven edit.
 */
export function expandToGroups({
	tracks,
	elements,
}: {
	tracks: SceneTracks;
	elements: readonly ElementRef[];
}): ElementRef[] {
	const groupIds = getGroupIds({ tracks, elements });
	if (groupIds.length === 0) {
		return [...elements];
	}

	return dedupeRefs({
		refs: [
			...elements,
			...groupIds.flatMap((groupId) => getGroupMembers({ tracks, groupId })),
		],
	});
}

/**
 * Drops the given elements *and* the rest of their groups. The inverse of
 * {@link expandToGroups} for the deselect path: removing one member alone would
 * be undone by the next expansion, so the whole group leaves together.
 */
export function removeWithGroups({
	tracks,
	elements,
	remove,
}: {
	tracks: SceneTracks;
	elements: readonly ElementRef[];
	remove: readonly ElementRef[];
}): ElementRef[] {
	const doomed = new Set(
		expandToGroups({ tracks, elements: remove }).map(
			(ref) => `${ref.trackId}:${ref.elementId}`,
		),
	);
	return elements.filter(
		(ref) => !doomed.has(`${ref.trackId}:${ref.elementId}`),
	);
}

export function isGroupedElement({
	element,
}: {
	element: TimelineElement;
}): boolean {
	return typeof element.groupId === "string" && element.groupId.length > 0;
}
