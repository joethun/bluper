import {
	resolveSampledSourceTime as _resolveSampledSourceTime,
} from "bluper-wasm";
import type {
	FreezeConfig,
	RetimeConfig,
} from "@/timeline";
import { roundMediaTime, type MediaTime } from "@/wasm";

/**
 * Held-still frame math, now owned by `editor-core::freeze`.
 *
 * The Rust side returns integer ticks; the caller wants a `MediaTime` so the
 * brand is restored after the round trip. `roundMediaTime` is re-applied so the
 * returned value is a real `MediaTime`, which the type system enforces.
 */
export function resolveSampledSourceTime({
	freeze,
	trimStart,
	clipTime,
	clipDuration,
	retime,
}: {
	freeze?: FreezeConfig;
	trimStart: number;
	clipTime: number;
	clipDuration?: number;
	retime?: RetimeConfig;
}): MediaTime {
	return roundMediaTime({
		time: Number(
			_resolveSampledSourceTime({
				freeze,
				trimStart,
				clipTime,
				clipDuration,
				retime,
			}),
		),
	});
}
