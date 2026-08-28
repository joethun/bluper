import {
	applyBoxSelectionState as _applyBoxSelectionState,
	clearSelectionState as _clearSelectionState,
	isSelectionIdSelected as _isSelectionIdSelected,
	pruneSelectionState as _pruneSelectionState,
	replaceSelectionState as _replaceSelectionState,
	selectRangeState as _selectRangeState,
	toggleSelectionState as _toggleSelectionState,
} from "bluper-wasm";
import type { BoxSelectionChange, SelectionState } from "@/selection/types";
import type { SelectionState as WasmSelectionState } from "bluper-wasm";

/**
 * Multi-select over an ordered list. Owned by `editor-core::selection`.
 *
 * `pruneSelection` hands back the *same* state object when nothing moved.
 * Rust cannot preserve an object's identity across the bridge, so it reports
 * whether anything changed and the identity is restored here — the surface
 * calls it from a `setState` updater, where returning the previous state is
 * what stops React re-rendering every row for a list change that touched
 * nothing selected.
 *
 * "No anchor" is `null` on this side and `undefined` on the wire — a Rust
 * `Option` has no null — so every state is mapped in both directions.
 */

function toWasmState(state: SelectionState): WasmSelectionState {
	return {
		selectedIds: state.selectedIds,
		anchorId: state.anchorId ?? undefined,
	};
}

function fromWasmState(state: WasmSelectionState): SelectionState {
	return {
		selectedIds: state.selectedIds,
		anchorId: state.anchorId ?? null,
	};
}

export function replaceSelection({
	ids,
	anchorId,
}: {
	ids: string[];
	anchorId?: string | null;
}): SelectionState {
	return fromWasmState(
		_replaceSelectionState({ ids, anchorId: anchorId ?? undefined }),
	);
}

export function clearSelection(): SelectionState {
	return fromWasmState(_clearSelectionState());
}

export function pruneSelection({
	state,
	orderedIds,
}: {
	state: SelectionState;
	orderedIds: string[];
}): SelectionState {
	const pruned = _pruneSelectionState({
		state: toWasmState(state),
		orderedIds,
	});
	return pruned.unchanged ? state : fromWasmState(pruned.state);
}

export function isSelected({
	state,
	id,
}: {
	state: SelectionState;
	id: string;
}): boolean {
	return _isSelectionIdSelected({ state: toWasmState(state), id });
}

export function toggleSelection({
	state,
	id,
}: {
	state: SelectionState;
	id: string;
}): SelectionState {
	return fromWasmState(
		_toggleSelectionState({ state: toWasmState(state), id }),
	);
}

export function selectRange({
	state,
	orderedIds,
	targetId,
	isAdditive,
}: {
	state: SelectionState;
	orderedIds: string[];
	targetId: string;
	isAdditive: boolean;
}): SelectionState {
	return fromWasmState(
		_selectRangeState({
			state: toWasmState(state),
			orderedIds,
			targetId,
			isAdditive,
		}),
	);
}

export function applyBoxSelection({
	intersectedIds,
	initialSelectedIds,
	initialAnchorId,
	isAdditive,
}: BoxSelectionChange): SelectionState {
	return fromWasmState(
		_applyBoxSelectionState({
			intersectedIds,
			initialSelectedIds,
			initialAnchorId: initialAnchorId ?? undefined,
			isAdditive,
		}),
	);
}
