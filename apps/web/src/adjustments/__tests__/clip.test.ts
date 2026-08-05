import { describe, expect, test } from "bun:test";
import { registerDefaultAdjustments } from "@/adjustments";
import {
	resolveClipAdjustments,
	resolveClipAdjustmentsAtTime,
} from "@/adjustments/clip";
import { isAnimationPath } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import {
	ADJUSTMENT_PARAM_GROUPS,
	ADJUSTMENT_PARAM_KEYS,
	getBuiltInElementParams,
} from "@/params/registry";
import { ADJUSTABLE_ELEMENT_TYPES } from "@/timeline";
import { mediaTime } from "@/wasm";

registerDefaultAdjustments();

describe("clip adjustments", () => {
	test("only footage and stills carry the Adjust params", () => {
		expect([...ADJUSTABLE_ELEMENT_TYPES]).toEqual(["video", "image"]);

		for (const type of ADJUSTABLE_ELEMENT_TYPES) {
			const keys = getBuiltInElementParams({ type }).map((p) => p.key);
			for (const key of ADJUSTMENT_PARAM_KEYS) {
				expect(keys, `${type} is missing ${key}`).toContain(key);
			}
		}

		// Text, stickers and shapes must not even have the params to animate.
		for (const type of ["text", "sticker", "graphic"] as const) {
			const keys = getBuiltInElementParams({ type }).map((p) => p.key);
			for (const key of ADJUSTMENT_PARAM_KEYS) {
				expect(keys, `${type} should not have ${key}`).not.toContain(key);
			}
			// Blending still has to be reachable for them.
			expect(keys).toContain("opacity");
			expect(keys).toContain("blendMode");
		}
	});

	test("every Adjust param is keyframable", () => {
		// `keyframable: false` makes buildParamDescriptor return null, which silently
		// disables the keyframe toggle and the animation channel behind it.
		const params = getBuiltInElementParams({ type: "video" });
		for (const key of ADJUSTMENT_PARAM_KEYS) {
			const param = params.find((p) => p.key === key);
			expect(param, key).toBeDefined();
			expect(param!.keyframable, `${key} is not keyframable`).not.toBe(false);
		}
	});

	test("every Adjust param is a recognised animation path", () => {
		// getElementKeyframes filters an element's channels through isAnimationPath,
		// so a key missing from ANIMATION_PROPERTY_PATHS still keyframes but draws no
		// diamond on the timeline clip and never snaps the playhead.
		for (const key of ADJUSTMENT_PARAM_KEYS) {
			expect(isAnimationPath(key), `${key} is not an animation path`).toBe(true);
		}
	});

	test("every grouped key resolves through to an adjustment definition", () => {
		// A key the bindings do not mention would render as a slider that moves and
		// changes nothing, which is the one failure this panel must not have.
		for (const key of ADJUSTMENT_PARAM_KEYS) {
			const resolved = resolveClipAdjustments({ params: { [key]: 100 } });
			expect(resolved, `${key} resolved to nothing`).not.toBeNull();
			expect(
				resolved!.filter.length > 0 || resolved!.overlays.length > 0,
				`${key} produced no filter and no overlay`,
			).toBe(true);
		}
	});

	test("neutral sliders resolve to null so the raw frame is uploaded", () => {
		expect(resolveClipAdjustments({ params: {} })).toBeNull();
		expect(
			resolveClipAdjustments({
				params: Object.fromEntries(ADJUSTMENT_PARAM_KEYS.map((k) => [k, 0])),
			}),
		).toBeNull();
	});

	test("brightness/contrast/saturation become one filter chain", () => {
		const resolved = resolveClipAdjustments({
			params: {
				"adjust.brightness": 50,
				"adjust.contrast": -25,
				"adjust.saturation": 100,
			},
		});
		expect(resolved!.filter).toBe("brightness(1.4) contrast(0.75) saturate(2)");
		expect(resolved!.overlays).toEqual([]);
	});

	test("temperature becomes a warm or cool wash, not a filter", () => {
		const warm = resolveClipAdjustments({
			params: { "adjust.temperature": 100 },
		});
		expect(warm!.filter).toBe("");
		expect(warm!.overlays).toEqual([
			{
				kind: "wash",
				color: "#ff7a2f",
				alpha: 0.45,
				compositeOperation: "soft-light",
			},
		]);
		expect(
			resolveClipAdjustments({ params: { "adjust.temperature": -100 } })!
				.overlays[0],
		).toMatchObject({ color: "#2f9dff" });
	});

	test("no slider duplicates another one's pass", () => {
		// Shine was Brightness with a softer roll-off and Fade was Shadow plus
		// Saturation, so both went. Nothing may quietly reintroduce them.
		for (const key of ["adjust.shine", "adjust.fade"]) {
			expect(ADJUSTMENT_PARAM_KEYS, key).not.toContain(key);
			expect(resolveClipAdjustments({ params: { [key]: 100 } }), key).toBeNull();
		}
	});

	test("the Texture group only adds, so it cannot go negative", () => {
		const texture = ADJUSTMENT_PARAM_GROUPS.find((g) => g.title === "Texture");
		expect(texture).toBeDefined();
		const params = getBuiltInElementParams({ type: "video" });
		for (const key of texture!.keys) {
			const param = params.find((p) => p.key === key);
			expect(param, key).toBeDefined();
			expect(param!.type === "number" && param!.min, key).toBe(0);
		}
	});

	test("a keyframed slider grades each frame differently", () => {
		const animations: ElementAnimations = {
			"adjust.saturation": {
				keys: [
					{
						id: "a",
						time: mediaTime({ ticks: 0 }),
						value: 0,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
					{
						id: "b",
						time: mediaTime({ ticks: 1000 }),
						value: 100,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		};
		const params = { "adjust.saturation": 0 };

		const atStart = resolveClipAdjustmentsAtTime({
			params,
			animations,
			localTime: 0,
		});
		const atEnd = resolveClipAdjustmentsAtTime({
			params,
			animations,
			localTime: 1000,
		});

		// Neutral at the first key, fully saturated at the last.
		expect(atStart).toBeNull();
		expect(atEnd!.filter).toBe("saturate(2)");
	});

	test("with nothing keyframed the stored values are used as-is", () => {
		const params = { "adjust.saturation": 100 };
		expect(
			resolveClipAdjustmentsAtTime({
				params,
				animations: undefined,
				localTime: 500,
			}),
		).toEqual(resolveClipAdjustments({ params }));
	});

	test("groups cover every Adjust param exactly once", () => {
		const grouped = ADJUSTMENT_PARAM_GROUPS.flatMap((g) => [...g.keys]);
		expect(new Set(grouped).size).toBe(grouped.length);
		expect(grouped).toEqual([...ADJUSTMENT_PARAM_KEYS]);
	});
});
