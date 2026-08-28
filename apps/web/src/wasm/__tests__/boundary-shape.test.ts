import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { ElementWithBounds } from "@/preview/element-bounds";

mock.module("bluper-wasm", () => wasmNative);

const { applyElementUpdate } = await import("@/wasm/timeline");
const { shiftElementsClearOfElement, applyPlacement } =
	await import("@/wasm/placement");
const { applyRippleAdjustments } = await import("@/wasm/ripple");
const { clampAnimationsToDuration } = await import("@/wasm/keyframes");
const { buildGaussianBlurPasses, intensityToSigma } = await import(
	"@/wasm/gaussian-blur"
);
const {
	buildSeparatedAudioElement,
	isSourceAudioEnabled,
	getSourceAudioActionLabel,
} = await import("@/wasm/audio-separation");
const {
	averageRateOverWindow,
	stretcherWindowPlan,
	sampleLinear,
} = await import("@/wasm/audio");
const { snapBoxMaskInteraction, snapSplitMaskInteraction } =
	await import("@/masks/snap");
const {
	removeFreeformPathPoints,
	getFreeformCanvasGeometry,
	getFreeformSegmentCount,
	getFreeformCanvasSegments,
	recenterFreeformPath,
	buildFreeformSvgPath,
} = await import("@/masks/freeform/path");
const { clampRound, formatNumberForDisplay } = await import("@/utils/math");
const { getRulerConfig, shouldShowLabel, formatRulerLabel } = await import(
	"@/wasm/ruler-utils"
);
const {
	getDefaultBaseMaskParams,
	getStrokeOffset,
	getDefaultSquareMaskParams,
	getBoxLikeGeometry,
	computeBoxMaskParamUpdate,
	computeFeatherUpdate,
} = await import("@/masks/builtin/box-like");
const { textMaskDefinition } = await import("@/masks/builtin/definitions/text");
const { splitMaskDefinition } = await import(
	"@/masks/builtin/definitions/split"
);
const { getLinePosFromDb, getDbFromLinePos, getBarFractionFromOutputAmplitude } =
	await import("@/timeline/audio-display");
const { getTimelineZoomMin, getTimelinePaddingPx, sliderToZoom, zoomToSlider } =
	await import("@/timeline/zoom-utils");
const { dimensionToAspectRatio } = await import("@/utils/geometry");
const { getDefaultCinematicBarsMaskParams } = await import(
	"@/masks/builtin/shapes"
);
const {
	floatToFrameRate,
	getHighestImportedVideoFps,
	getRaisedProjectFpsForImportedMedia,
} = await import("@/fps/utils");
const { canvasToOverlay, getDisplayScale } = await import(
	"@/preview/preview-coords"
);
const { getHitElements, resolvePreferredHit } = await import(
	"@/preview/hit-test"
);
const { RenderScaleController } = await import("@/preview/render-scale");
const { replaceSelection, pruneSelection, selectRange } = await import(
	"@/selection/state"
);
const { buildAdjustmentFilterPasses } = await import(
	"@/adjustments/filter-passes"
);
const { evaluateStorageCapacity, formatStorageBytes } = await import(
	"@/services/storage/quota"
);

/**
 * Everything Rust hands back has to be a plain object, not a JS `Map`.
 *
 * `serde_wasm_bindgen` emits a `Map` for anything that serialises *as* a map —
 * a `HashMap`, a `serde_json::Value` object, or any struct using
 * `#[serde(flatten)]`, which `TimelineElement` does. A `Map` type-checks
 * perfectly at the façade, survives every Rust unit test, and then reads
 * `undefined` for every property: `element.duration` is gone, arithmetic on it
 * is `NaN`, and the first thing to notice is a validator several layers away.
 *
 * tsify's `hashmap_as_object` is what turns it off, and it is **off by default**.
 * These tests exist so forgetting it on a new type fails here rather than in the
 * desktop self-check.
 */

const element = {
	id: "e1",
	name: "clip",
	type: "video" as const,
	mediaId: "m1",
	duration: 1000,
	startTime: 0,
	trimStart: 0,
	trimEnd: 0,
	params: { opacity: 1 },
};

/**
 * The generated signatures take the untyped element model — Rust flattens it and
 * tsify cannot render that as valid TypeScript — so anything going in has to be
 * widened. Funnelled through one place so the escape hatch is a single line.
 */
function wasmArg(value: unknown): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as never;
}

const anElement = wasmArg(element);

const tracks = wasmArg({
	overlay: [],
	audio: [],
	main: {
		id: "main",
		name: "Main",
		type: "video" as const,
		muted: false,
		hidden: false,
		elements: [element],
	},
});

/** Fails on a `Map`, and on anything whose fields have gone missing. */
function expectReadableElement({ value }: { value: unknown }): void {
	expect(value).not.toBeInstanceOf(Map);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const readable = value as { duration?: number; params?: unknown };
	expect(typeof readable.duration).toBe("number");
	expect(readable.params).not.toBeInstanceOf(Map);
	expect(typeof readable.params).toBe("object");
}

function firstElement({ result }: { result: unknown }): unknown {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const scene = result as { main?: { elements?: unknown[] } };
	expect(scene.main).not.toBeInstanceOf(Map);
	return scene.main?.elements?.[0];
}

test("applyElementUpdate returns a readable element", () => {
	const updated = applyElementUpdate({
		element: anElement,
		patch: { name: "renamed" },
	});
	expectReadableElement({ value: updated });
	expect(updated.name).toBe("renamed");
});

test("shiftElementsClearOfElement returns readable elements", () => {
	const shifted = shiftElementsClearOfElement({
		tracks,
		trackId: "main",
		element: anElement,
	});
	expectReadableElement({ value: firstElement({ result: shifted }) });
});

test("applyPlacement returns readable elements", () => {
	const applied = applyPlacement({
		tracks,
		placementResult: {
			kind: "existingTrack",
			trackId: "main",
			trackIndex: 0,
			trackType: "video",
		},
		elements: [anElement],
	});
	expect(applied).not.toBeNull();
	expectReadableElement({
		value: firstElement({ result: applied?.updatedTracks }),
	});
});

test("applyRippleAdjustments returns readable elements", () => {
	const rippled = applyRippleAdjustments({ tracks, adjustments: [] });
	expectReadableElement({ value: firstElement({ result: rippled }) });
});

test("an animations bag comes back keyed, not as a Map", () => {
	const animations = clampAnimationsToDuration({
		animations: wasmArg({
			opacity: {
				keys: [
					{
						id: "k",
						time: 0,
						value: 1,
						segmentToNext: "linear",
						tangentMode: "flat",
					},
				],
			},
		}),
		duration: wasmArg(1000),
	});
	expect(animations).not.toBeInstanceOf(Map);
	expect(Object.keys(animations ?? {})).toContain("opacity");
});

test("a media format comes back as a plain object", async () => {
	// Imported here rather than at the top so this block is self-contained: the
	// module is already mocked above.
	const { getMediaFormatFromName } = await import("@/wasm/file-types");
	const format = getMediaFormatFromName({ name: "clip.mkv" });
	expect(format).not.toBeInstanceOf(Map);
	expect(format?.label).toBe("Matroska (MKV)");
	expect(format?.extensions).toEqual(["mkv", "mk3d"]);
});

test("snapBoxMaskInteraction returns readable params and lines", () => {
	const result = snapBoxMaskInteraction({
		handleId: { kind: "position" },
		startParams: {
			feather: 0,
			inverted: false,
			strokeColor: "#000",
			strokeWidth: 1,
			strokeAlign: "inside",
			centerX: 0,
			centerY: 0,
			width: 0.5,
			height: 0.5,
			rotation: 0,
			scale: 1,
		},
		proposedParams: {
			feather: 0,
			inverted: false,
			strokeColor: "#000",
			strokeWidth: 1,
			strokeAlign: "inside",
			centerX: 0,
			centerY: 0,
			width: 0.5,
			height: 0.5,
			rotation: 0,
			scale: 1,
		},
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
		canvasSize: { width: 1920, height: 1080 },
		snapThreshold: { x: 8, y: 8 },
	});
	expect(result).not.toBeInstanceOf(Map);
	expect(result.params).not.toBeInstanceOf(Map);
	expect(typeof result.params.centerX).toBe("number");
	expect(Array.isArray(result.activeLines)).toBe(true);
});

test("snapSplitMaskInteraction returns readable params", () => {
	const result = snapSplitMaskInteraction({
		handleId: { kind: "position" },
		proposedParams: {
			feather: 0,
			inverted: false,
			strokeColor: "#000",
			strokeWidth: 1,
			strokeAlign: "inside",
			centerX: 0,
			centerY: 0,
			rotation: 0,
		},
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
		canvasSize: { width: 1920, height: 1080 },
		snapThreshold: { x: 8, y: 8 },
	});
	expect(result).not.toBeInstanceOf(Map);
	expect(result.params).not.toBeInstanceOf(Map);
	expect(typeof result.params.centerX).toBe("number");
});

test("freeform path results arrive as plain objects", () => {
	const points = [
		{ id: "p0", x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
		{ id: "p1", x: 0.5, y: 0.5, inX: 0, inY: 0, outX: 0, outY: 0 },
	];
	expect(removeFreeformPathPoints({ points, pointIds: [] })).toHaveLength(2);
	expect(getFreeformSegmentCount({ points, closed: false })).toBe(1);
	const geometry = getFreeformCanvasGeometry({
		points,
		centerX: 0,
		centerY: 0,
		rotation: 0,
		scale: 1,
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
	});
	expect(geometry).not.toBeInstanceOf(Map);
	expect(Array.isArray(geometry.anchors)).toBe(true);
	const segments = getFreeformCanvasSegments({
		points,
		centerX: 0,
		centerY: 0,
		rotation: 0,
		scale: 1,
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
		closed: false,
	});
	expect(segments).toHaveLength(1);
	expect(segments[0]?.pathData).toMatch(/^M /);
	const recentered = recenterFreeformPath({
		points,
		centerX: 0,
		centerY: 0,
		rotation: 0,
		scale: 1,
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
	});
	expect(recentered).not.toBeInstanceOf(Map);
	expect(Array.isArray(recentered.points)).toBe(true);
	const svg = buildFreeformSvgPath({
		points,
		centerX: 0,
		centerY: 0,
		rotation: 0,
		scale: 1,
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
		closed: false,
	});
	expect(typeof svg).toBe("string");
	expect(svg).toMatch(/^M /);
});

test("formatNumberForDisplay handles the toFixed parity case", () => {
	expect(formatNumberForDisplay({ value: 0.5, fractionDigits: 0 })).toBe("1");
	expect(formatNumberForDisplay({ value: 0.125, fractionDigits: 2 })).toBe(
		"0.13",
	);
});

test("clampRound stays a primitive number", () => {
	const result = clampRound({ value: 0.5, min: 0, max: 1 });
	expect(typeof result).toBe("number");
	expect(result).toBe(1);
});

test("ruler-utils results arrive as plain objects and primitives", () => {
	const config = getRulerConfig({
		zoomLevel: 1,
		fps: wasmArg({ numerator: 30, denominator: 1 }),
	});
	expect(config).not.toBeInstanceOf(Map);
	expect(typeof config.tickIntervalSeconds).toBe("number");
	expect(typeof shouldShowLabel({ time: 1, labelIntervalSeconds: 1 })).toBe(
		"boolean",
	);
	const label = formatRulerLabel({
		timeInSeconds: 1,
		fps: wasmArg({ numerator: 30, denominator: 1 }),
	});
	expect(typeof label).toBe("string");
});

test("box-like mask defaults are plain objects with the expected narrow types", () => {
	const defaults = getDefaultBaseMaskParams();
	expect(defaults).not.toBeInstanceOf(Map);
	expect(typeof defaults.strokeColor).toBe("string");
	expect(["inside", "center", "outside"]).toContain(defaults.strokeAlign);
	const square = getDefaultSquareMaskParams({
		elementSize: { width: 1000, height: 500 },
	});
	expect(square).not.toBeInstanceOf(Map);
	expect(square.width).toBeGreaterThan(0);
	expect(square.height).toBeGreaterThan(0);
	const geometry = getBoxLikeGeometry({
		params: square,
		width: 1000,
		height: 500,
	});
	expect(geometry).not.toBeInstanceOf(Map);
	expect(typeof geometry.centerX).toBe("number");
});

test("stroke offset and feather update return primitives", () => {
	expect(typeof getStrokeOffset({ strokeAlign: "center", strokeWidth: 4 })).toBe(
		"number",
	);
	const feather = computeFeatherUpdate({
		startFeather: 0,
		deltaX: 5,
		deltaY: 0,
		directionX: -1,
		directionY: 0,
	});
	expect(typeof feather.feather).toBe("number");
});

test("box mask param update returns a plain partial object", () => {
	const update = computeBoxMaskParamUpdate({
		handleId: { kind: "position" },
		startParams: {
			feather: 0,
			inverted: false,
			strokeColor: "#000",
			strokeWidth: 0,
			strokeAlign: "center",
			centerX: 0,
			centerY: 0,
			width: 0.5,
			height: 0.5,
			rotation: 0,
			scale: 1,
		},
		deltaX: 10,
		deltaY: 0,
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
		startCanvasX: 0,
		startCanvasY: 0,
		canvasSize: { width: 1920, height: 1080 },
	});
	expect(update).not.toBeInstanceOf(Map);
});

test("text mask param update returns a plain partial object", () => {
	const update = textMaskDefinition.computeParamUpdate?.({
		handleId: { kind: "rotation" },
		startParams: {
			feather: 0,
			inverted: false,
			strokeColor: "#000",
			strokeWidth: 0,
			strokeAlign: "center",
			content: "Mask",
			fontSize: 15,
			fontFamily: "Arial",
			fontWeight: "normal",
			fontStyle: "normal",
			textDecoration: "none",
			letterSpacing: 0,
			lineHeight: 1.2,
			centerX: 0,
			centerY: 0,
			rotation: 0,
			scale: 1,
		},
		deltaX: 0,
		deltaY: 0,
		startCanvasX: 0,
		startCanvasY: 100,
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
		canvasSize: { width: 1920, height: 1080 },
	});
	expect(update).not.toBeInstanceOf(Map);
});

test("split mask param update returns a plain partial object", () => {
	const update = splitMaskDefinition.computeParamUpdate?.({
		handleId: { kind: "position" },
		startParams: {
			feather: 0,
			inverted: false,
			strokeColor: "#000",
			strokeWidth: 0,
			strokeAlign: "center",
			centerX: 0,
			centerY: 0,
			rotation: 0,
		},
		deltaX: 0,
		deltaY: 0,
		startCanvasX: 0,
		startCanvasY: 0,
		bounds: { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 },
		canvasSize: { width: 1920, height: 1080 },
	});
	expect(update).not.toBeInstanceOf(Map);
});

test("audio-display returns primitives", () => {
	expect(typeof getLinePosFromDb({ db: 0 })).toBe("number");
	expect(typeof getDbFromLinePos({ percent: 50 })).toBe("number");
	expect(typeof getBarFractionFromOutputAmplitude({ outputAmplitude: 0.5 })).toBe(
		"number",
	);
});

test("zoom-utils returns primitives", () => {
	const min = getTimelineZoomMin({
		duration: 5_000_000,
		containerWidth: 1000,
	});
	expect(typeof min).toBe("number");
	expect(
		typeof getTimelinePaddingPx({
			containerWidth: 1000,
			zoomLevel: min,
			minZoom: min,
		}),
	).toBe("number");
	expect(typeof sliderToZoom({ sliderPosition: 0.5, minZoom: 1 })).toBe(
		"number",
	);
	expect(typeof zoomToSlider({ zoomLevel: 10, minZoom: 1 })).toBe("number");
});

test("an aspect ratio comes back as a string, reduced", () => {
	expect(dimensionToAspectRatio({ width: 1920, height: 1080 })).toBe("16:9");
});

test("a mask shape outline is an array of tagged plain commands", () => {
	// Path2D does not exist here, so the outline is read straight off the
	// bridge: what the façade replays is this array, and a `Map` would leave
	// every coordinate undefined and draw nothing.
	const outline = wasmNative.buildMaskShapeOutline({
		shape: "star",
		params: {
			feather: 0,
			inverted: false,
			strokeColor: "#fff",
			strokeWidth: 0,
			strokeAlign: "center",
			centerX: 0,
			centerY: 0,
			width: 0.5,
			height: 0.5,
			rotation: 0,
			scale: 1,
		},
		width: 200,
		height: 100,
		outline: "body",
	});
	expect(outline).not.toBeInstanceOf(Map);
	expect(Array.isArray(outline.commands)).toBe(true);
	expect(outline.commands[0]).not.toBeInstanceOf(Map);
	expect(outline.commands[0].kind).toBe("moveTo");
	expect(
		wasmNative.buildMaskShapeOverlayPath({
			shape: "diamond",
			width: 100,
			height: 50,
		}),
	).toBe("M 50,0 L 100,25 L 50,50 L 0,25 Z");
});

test("cinematic bars defaults arrive as a plain param object", () => {
	const params = getDefaultCinematicBarsMaskParams({
		elementSize: { width: 1600, height: 900 },
	});
	expect(params).not.toBeInstanceOf(Map);
	expect(params.height).toBe(0.6);
	expect(params.width).toBeGreaterThan(1);
	expect(params.strokeAlign).toBe("center");
});

test("frame rates cross as plain fractions, and absent answers as null", () => {
	const rate = floatToFrameRate(29.97);
	expect(rate).not.toBeInstanceOf(Map);
	expect(rate.numerator).toBe(30_000);
	expect(rate.denominator).toBe(1_001);

	// `Option` arrives as `undefined`; the façade is what turns it into the
	// `null` the callers branch on.
	expect(getHighestImportedVideoFps({ mediaAssets: [] })).toBeNull();
	expect(
		getRaisedProjectFpsForImportedMedia({
			currentFps: { numerator: 60, denominator: 1 },
			importedAssets: [{ type: "video", fps: 24 }],
		}),
	).toBeNull();
});

test("preview coordinate conversions return plain points", () => {
	const geometry = {
		canvasWidth: 1920,
		canvasHeight: 1080,
		centerX: 960,
		centerY: 540,
		scale: 0.5,
		viewportWidth: 800,
		viewportHeight: 450,
	};
	const overlay = canvasToOverlay({ canvasX: 960, canvasY: 540, geometry });
	expect(overlay).not.toBeInstanceOf(Map);
	expect(overlay.x).toBe(400);
	expect(getDisplayScale({ geometry }).y).toBe(0.5);
});

test("hit testing maps indexes back onto the caller's own elements", () => {
	const bounds = { cx: 0, cy: 0, width: 100, height: 100, rotation: 0 };
	const elements: ElementWithBounds[] = wasmArg([
		{ trackId: "t1", elementId: "under", element, bounds },
		{ trackId: "t1", elementId: "over", element, bounds },
	]);
	const hits = getHitElements({
		canvasX: 0,
		canvasY: 0,
		elementsWithBounds: elements,
	});
	// Topmost first, and the objects that come back are the caller's own.
	expect(hits.map((hit) => hit.elementId)).toEqual(["over", "under"]);
	expect(hits[0]).toBe(elements[1]);
	expect(
		resolvePreferredHit({
			hits,
			preferredElements: [{ trackId: "t1", elementId: "under" }],
		}),
	).toBe(elements[0]);
	expect(resolvePreferredHit({ hits, preferredElements: [] })).toBeNull();
});

test("the render-scale controller carries its state across the bridge", () => {
	const controller = new RenderScaleController();
	for (let index = 0; index < 4; index++) {
		controller.recordFrame({ durationMs: 40, budgetMs: 16 });
	}
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(0.5);
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: false })).toBe(1);
});

test("selection state crosses as plain arrays, with null for no anchor", () => {
	const replaced = replaceSelection({ ids: ["a", "b", "a"], anchorId: null });
	expect(replaced).not.toBeInstanceOf(Map);
	expect(replaced.selectedIds).toEqual(["a", "b"]);
	// `Option` arrives as `undefined`; the callers store `null`.
	expect(replaceSelection({ ids: [] }).anchorId).toBeNull();

	const ranged = selectRange({
		state: replaced,
		orderedIds: ["a", "b", "c", "d"],
		targetId: "d",
		isAdditive: false,
	});
	expect(ranged.selectedIds).toEqual(["b", "c", "d"]);
});

test("pruning an untouched selection hands back the very same object", () => {
	// The surface calls this from a setState updater, where a new object with
	// equal contents re-renders every row.
	const state = replaceSelection({ ids: ["a", "b"] });
	expect(pruneSelection({ state, orderedIds: ["a", "b", "c"] })).toBe(state);
	expect(pruneSelection({ state, orderedIds: ["a"] })).not.toBe(state);
});

test("adjustment filter passes arrive as plain objects with plain uniforms", () => {
	const passes = buildAdjustmentFilterPasses({
		filter: "brightness(1.2) hue-rotate(45deg)",
	});
	expect(passes).not.toBeInstanceOf(Map);
	expect(passes[0]).not.toBeInstanceOf(Map);
	// `uniforms` is a HashMap: without `hashmap_as_object` it would be a Map
	// and `u_amount` would read undefined all the way into the shader.
	expect(passes[0].uniforms).not.toBeInstanceOf(Map);
	expect(passes[0]).toEqual({
		shader: "brightness",
		uniforms: { u_amount: 1.2 },
	});
	expect(passes[1].uniforms.u_amount).toBe(45);
});

test("storage capacity answers with null, not undefined, when nothing is known", () => {
	const unknown = evaluateStorageCapacity({
		requiredBytes: 1024,
		quotaStatus: { headroomBytes: null, availableBytes: null },
	});
	expect(unknown).not.toBeInstanceOf(Map);
	expect(unknown.canStore).toBe(true);
	expect(unknown.reason).toBe("estimate-unavailable");
	expect(unknown.availableBytes).toBeNull();

	const refused = evaluateStorageCapacity({
		requiredBytes: 2048,
		quotaStatus: { headroomBytes: 4096, availableBytes: 1024 },
	});
	expect(refused.canStore).toBe(false);
	expect(refused.reason).toBe("insufficient-space");
	expect(formatStorageBytes({ bytes: 1024 })).toBe("1.0 KB");
});

test("a graphic outline is an array of tagged plain commands", () => {
	// Path2D does not exist here either, so the outline is read off the bridge.
	const outline = wasmNative.buildGraphicShapeOutline({
		shape: "polygon",
		width: 200,
		height: 100,
		sides: 5,
		cornerRadius: 25,
	});
	expect(outline).not.toBeInstanceOf(Map);
	expect(outline.commands[0]).not.toBeInstanceOf(Map);
	expect(outline.commands[0].kind).toBe("moveTo");
	expect(outline.commands[1].kind).toBe("arcTo");

	const rounded = wasmNative.buildGraphicShapeOutline({
		shape: "rectangle",
		width: 200,
		height: 100,
		strokeWidth: 10,
		strokeAlign: "center",
		cornerRadius: 50,
	});
	expect(rounded.commands).toEqual([
		{ kind: "roundRect", x: 5, y: 5, width: 190, height: 90, radius: 45 },
	]);
});

test("buildGaussianBlurPasses returns a tagged passes array, not a Map", () => {
	const result = buildGaussianBlurPasses({ sigmaX: 5, sigmaY: 5 });
	expect(result).not.toBeInstanceOf(Map);
	expect(Array.isArray(result)).toBe(true);
	const pass = result[0];
	expect(pass).not.toBeInstanceOf(Map);
	expect(pass.shader).toBe("gaussian-blur");
	expect(pass.uniforms).not.toBeInstanceOf(Map);
	expect(typeof pass.uniforms.u_sigma).toBe("number");
	expect(Array.isArray(pass.uniforms.u_direction)).toBe(true);
	expect(intensityToSigma({ intensity: 5, resolution: 1920, reference: 1920 })).toBe(1);
});

test("buildSeparatedAudioElement returns a plain params object", () => {
	const result = buildSeparatedAudioElement({
		sourceElement: {
			id: "e1",
			type: "video",
			mediaId: "m1",
			name: "clip",
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			duration: 1000 as never,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			startTime: 0 as never,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			trimStart: 0 as never,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			trimEnd: 0 as never,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			sourceDuration: 2000 as never,
			params: { volume: 0, muted: false },
			isSourceAudioEnabled: false,
		},
	});
	expect(result).not.toBeInstanceOf(Map);
	expect(result.sourceType).toBe("upload");
	expect(result.mediaId).toBe("m1");
	expect(result.params).not.toBeInstanceOf(Map);
	expect(typeof result.params.volume).toBe("number");
	expect(typeof result.params.muted).toBe("boolean");
});

test("audio-separation boolean helpers cross as plain numbers", () => {
	const videoElement = {
		id: "e1",
		type: "video" as const,
		mediaId: "m1",
		name: "clip",
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		duration: 1000 as never,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		startTime: 0 as never,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		trimStart: 0 as never,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		trimEnd: 0 as never,
		params: {},
		isSourceAudioEnabled: undefined,
	};
	expect(typeof isSourceAudioEnabled({ element: videoElement })).toBe("boolean");
	expect(getSourceAudioActionLabel({ element: videoElement })).toBe(
		"Extract audio",
	);
});

test("stretcherWindowPlan returns a plain object, not a Map", () => {
	const plan = stretcherWindowPlan({
		clipDuration: 10,
		targetSampleRate: 48000,
	});
	expect(plan).not.toBeInstanceOf(Map);
	expect(typeof plan.windowCount).toBe("number");
	expect(typeof plan.windowSeconds).toBe("number");
	expect(typeof plan.quantumSeconds).toBe("number");
	expect(typeof plan.quantaPerWindow).toBe("number");
});

test("averageRateOverWindow and sampleLinear return primitive numbers", () => {
	const rate = averageRateOverWindow({
		from: 0,
		to: 1,
		clipDuration: 2,
		retime: { rate: 1 },
	});
	expect(typeof rate).toBe("number");
	const sample = sampleLinear({ channelData: [0, 1, 2], position: 1.5 });
	expect(typeof sample).toBe("number");
});
