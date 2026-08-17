import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { EditorCore } from "@/core";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { MANAGER_KEYS, type ManagerKey } from "./manager-tracking";
import { isShallowEqual, trackManagerAccess } from "./snapshot-cache";

const SNAPSHOT_UNSET = Symbol("snapshotUnset");

export function useEditor(): EditorCore;
export function useEditor<T>(selector: (editor: EditorCore) => T): T;
export function useEditor<T>(
	selector?: (editor: EditorCore) => T,
): EditorCore | T {
	const editor = useMemo(() => EditorCore.getInstance(), []);

	// Stash the latest selector in a ref so the subscribe/getSnapshot callbacks
	// themselves stay reference-stable. Inline `useEditor((e) => e.x)` produces
	// a new function on every render; without the ref, useSyncExternalStore
	// would re-subscribe on every render and we'd churn through manager
	// subscriptions constantly.
	const selectorRef = useCommittedRef(selector);

	// Track which managers the selector reads across calls. Steady across the
	// hook's lifetime so conditional branches (e.g. `cond ? e.timeline.x :
	// e.scenes.y`) cover every manager the selector might touch.
	const accessedRef = useRef<Set<ManagerKey>>(new Set());

	const snapshotCacheRef = useRef<T | typeof SNAPSHOT_UNSET>(SNAPSHOT_UNSET);

	const subscribe = useCallback(
		(onChange: () => void) => {
			const currentSelector = selectorRef.current;
			if (!currentSelector) {
				// No selector → caller is just grabbing the editor handle for
				// imperative method calls. The snapshot is the stable singleton,
				// so it never changes: subscribing would fire change events that
				// produce identical snapshots and get filtered out, but we still
				// pay for the listener bookkeeping. Just no-op.
				return () => {};
			}

			const accessed = accessedRef.current;
			accessed.clear();
			try {
				trackManagerAccess({
					editor,
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
					selector: currentSelector as (editor: unknown) => T,
					accessed,
				});
			} catch {
				for (const k of MANAGER_KEYS) accessed.add(k);
			}

			const keys = MANAGER_KEYS.filter((k) => accessed.has(k));
			const unsubscribers = keys.map((k) => editor[k].subscribe(onChange));
			return () => {
				for (const unsubscribe of unsubscribers) {
					unsubscribe();
				}
			};
		},
		[editor, selectorRef],
	);

	const getSnapshot = useCallback((): EditorCore | T => {
		const currentSelector = selectorRef.current;
		if (!currentSelector) {
			return editor;
		}

		const next = currentSelector(editor);
		if (
			snapshotCacheRef.current !== SNAPSHOT_UNSET &&
			isShallowEqual({
				a: snapshotCacheRef.current,
				b: next,
			})
		) {
			return snapshotCacheRef.current;
		}

		snapshotCacheRef.current = next;
		return next;
	}, [editor, selectorRef]);

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
