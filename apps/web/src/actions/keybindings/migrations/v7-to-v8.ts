import { getPersistedKeybindingsState } from "../persisted-state";

/**
 * Hands the new freeze-frame action its default key to anyone whose keybindings
 * were saved before it existed. Persisted state is a full snapshot rather than
 * an overlay on the defaults, so without this the action would be unreachable
 * from the keyboard until the user reset their bindings.
 *
 * Skipped when the user has already put something else on the key — their
 * choice outranks a new default.
 */
export function v7ToV8({ state }: { state: unknown }): unknown {
	const v7 = getPersistedKeybindingsState({ state });
	if (!v7) return state;
	if (Object.values(v7.keybindings).includes("freeze-frame")) return state;
	if (v7.keybindings["shift+f"] !== undefined) return state;

	return {
		...v7,
		keybindings: { ...v7.keybindings, "shift+f": "freeze-frame" },
	};
}
