import type { TransitionDefinition } from "@/transitions/types";
import {
	DEFAULT_TRANSITION_DURATION,
	neutralSide,
	readSoftness,
	readStagger,
	readTileCount,
	side,
	SOFTNESS_PARAM,
	TILE_COUNT_PARAM,
	TILE_STAGGER_PARAM,
} from "./shared";

/**
 * Wipes and irises only ever mask the *incoming* clip. The incoming clip is the
 * later element on the track, so it composites above the outgoing one — punching
 * a hole in it shows the outgoing clip through, while masking the outgoing clip
 * would only show the project background.
 */
function buildLinearWipe({
	type,
	name,
	angleDegrees,
	keywords,
}: {
	type: string;
	name: string;
	angleDegrees: number;
	keywords: string[];
}): TransitionDefinition {
	return {
		type,
		name,
		category: "wipe",
		keywords: ["wipe", ...keywords],
		defaultDuration: DEFAULT_TRANSITION_DURATION,
		params: [SOFTNESS_PARAM],
		resolve: ({ progress, params }) => ({
			outgoing: neutralSide(),
			incoming: side({
				shape: {
					kind: "linear",
					angleDegrees,
					progress,
					softness: readSoftness({ value: params.softness }),
				},
			}),
		}),
	};
}

const wipeRight = buildLinearWipe({
	type: "wipe-right",
	name: "Wipe right",
	angleDegrees: 0,
	keywords: ["right", "reveal", "sweep"],
});

const wipeLeft = buildLinearWipe({
	type: "wipe-left",
	name: "Wipe left",
	angleDegrees: 180,
	keywords: ["left", "reveal", "sweep"],
});

const wipeDown = buildLinearWipe({
	type: "wipe-down",
	name: "Wipe down",
	angleDegrees: 90,
	keywords: ["down", "reveal", "sweep"],
});

const wipeUp = buildLinearWipe({
	type: "wipe-up",
	name: "Wipe up",
	angleDegrees: 270,
	keywords: ["up", "reveal", "sweep"],
});

const irisOpen: TransitionDefinition = {
	type: "iris-open",
	name: "Iris open",
	category: "wipe",
	keywords: ["iris", "circle", "open", "reveal", "zoom"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [SOFTNESS_PARAM],
	resolve: ({ progress, params }) => ({
		outgoing: neutralSide(),
		incoming: side({
			shape: {
				kind: "radial",
				progress,
				softness: readSoftness({ value: params.softness }),
				inverted: false,
			},
		}),
	}),
};

/**
 * The outgoing clip appears to shrink into a closing circle. Expressed as the
 * complement on the incoming clip: everything outside a shrinking hole.
 */
const irisClose: TransitionDefinition = {
	type: "iris-close",
	name: "Iris close",
	category: "wipe",
	keywords: ["iris", "circle", "close", "shrink"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [SOFTNESS_PARAM],
	resolve: ({ progress, params }) => ({
		outgoing: neutralSide(),
		incoming: side({
			shape: {
				kind: "radial",
				progress: 1 - progress,
				softness: readSoftness({ value: params.softness }),
				inverted: true,
			},
		}),
	}),
};

/**
 * Clipchamp's "Tiles". The incoming clip arrives as a grid of squares that grow
 * into place in a wave across the frame, so the outgoing clip shows through the
 * gaps until the last one lands.
 *
 * `Tiles` sets the grid density and `Stagger` how spread out their arrivals are —
 * turn it down and every tile lands together, which is a dissolve in a grid's
 * clothing.
 */
const tiles: TransitionDefinition = {
	type: "tiles",
	name: "Tiles",
	category: "wipe",
	keywords: ["tiles", "grid", "squares", "blocks", "mosaic", "checker"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [TILE_COUNT_PARAM, TILE_STAGGER_PARAM],
	resolve: ({ progress, params }) => ({
		outgoing: neutralSide(),
		incoming: side({
			shape: {
				kind: "tiles",
				progress,
				count: readTileCount({ value: params.tiles }),
				stagger: readStagger({ value: params.stagger }),
			},
		}),
	}),
};

const clockWipe: TransitionDefinition = {
	type: "clock-wipe",
	name: "Clock wipe",
	category: "wipe",
	keywords: ["clock", "radar", "sweep", "angular", "rotate"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [SOFTNESS_PARAM],
	resolve: ({ progress, params }) => ({
		outgoing: neutralSide(),
		incoming: side({
			shape: {
				kind: "angular",
				progress,
				softness: readSoftness({ value: params.softness }),
				startDegrees: 0,
			},
		}),
	}),
};

export const WIPE_TRANSITIONS: TransitionDefinition[] = [
	wipeRight,
	wipeLeft,
	wipeDown,
	wipeUp,
	irisOpen,
	irisClose,
	clockWipe,
	tiles,
];
