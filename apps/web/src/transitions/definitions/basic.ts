import type { TransitionDefinition } from "@/transitions/types";
import {
	DEFAULT_TRANSITION_DURATION,
	hiddenSide,
	neutralSide,
	side,
	triangle,
} from "./shared";

/**
 * Straight cross-fade. The outgoing clip keeps full opacity underneath while the
 * incoming one fades up on top of it, which avoids the mid-point dip to the
 * background that fading both sides would produce.
 */
const dissolve: TransitionDefinition = {
	// The stored type stays "dissolve": renaming it would orphan the transition on
	// every clip already saved against it.
	type: "dissolve",
	name: "Fade",
	category: "basic",
	keywords: ["dissolve", "cross", "fade", "blend", "mix"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [],
	resolve: ({ progress }) => ({
		outgoing: neutralSide(),
		incoming: side({ opacity: progress }),
	}),
};

/** Blow the cut out to white — CapCut's "Flash white". */
const flashWhite: TransitionDefinition = {
	type: "flash-white",
	name: "Flash white",
	category: "basic",
	keywords: ["flash", "white", "bloom", "burn"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [],
	resolve: ({ progress }) => ({
		outgoing: progress < 0.5 ? neutralSide() : hiddenSide(),
		incoming: progress < 0.5 ? hiddenSide() : neutralSide(),
		overlay: { color: "#ffffff", opacity: triangle({ progress }) },
	}),
};

export const BASIC_TRANSITIONS: TransitionDefinition[] = [dissolve, flashWhite];
