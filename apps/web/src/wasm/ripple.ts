import {
	applyRippleAdjustments as _applyRippleAdjustments,
	computeRippleAdjustments as _computeRippleAdjustments,
} from "bluper-wasm";
import type { SceneTracks } from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Ripple editing, now owned by `editor-core::timeline::ripple`.
 *
 * `SceneTracks` crosses untyped: the element model uses `#[serde(flatten)]` in
 * Rust, which tsify cannot render as valid TypeScript. The typing lives on these
 * signatures, and field-name agreement is covered by the model's round-trip
 * tests.
 */

export interface RippleAdjustment {
	trackId: string;
	afterTime: MediaTime;
	shiftAmount: MediaTime;
}

/** What space an edit freed, per track. */
export function computeRippleAdjustments({
	beforeTracks,
	afterTracks,
}: {
	beforeTracks: SceneTracks;
	afterTracks: SceneTracks;
}): RippleAdjustment[] {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _computeRippleAdjustments({
		beforeTracks,
		afterTracks,
	} as never).adjustments as RippleAdjustment[];
}

/** Close those gaps, pulling everything after each one to the left. */
export function applyRippleAdjustments({
	tracks,
	adjustments,
}: {
	tracks: SceneTracks;
	adjustments: RippleAdjustment[];
}): SceneTracks {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _applyRippleAdjustments({
		tracks,
		adjustments,
	} as never) as SceneTracks;
}
