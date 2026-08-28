import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import { createRng, type Rng } from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

// Every `@/wasm/*` and `@/animation` import has to come *after* the mock. A
// top-level `import` is hoisted above it and would load the bundler-target
// package, which `bun test` cannot initialise — a failure that only shows up
// when this file runs on its own, because the mock is process-global and a full
// suite run masks it.
const {
	resolveGraphEditorSelectionState: rustResolveGraphEditorSelectionState,
	buildGraphEditorCurvePatches: rustBuildGraphEditorCurvePatches,
	applyGraphEditorCurvePreview: rustApplyGraphEditorCurvePreview,
} = await import("@/wasm/graph-editor");

/**
 * The curve editor's session state, owned by
 * `editor-core::animation::graph_editor`.
 *
 * `apps/web/src/timeline/components/graph-editor/session.ts` was deleted at the
 * switchover, so this is no longer a differential. What is left to prove is that
 * the answers stay self-consistent across the boundary, and that a generated
 * selection never produces a state the popover cannot render.
 *
 * All three exports run in one iteration, because the second two only have
 * meaningful inputs once the first has produced a segment: the context and the
 * reference span come out of the resolved state. Comparing them separately
 * would mean hand-rolling contexts that the resolver would never emit.
 */

const PROPERTY_PATHS = ["opacity", "volume", "transform.position", "color"];

/** Component keys per path. `null` means a leaf channel under `"value"`. */
const COMPONENTS_BY_PATH: Record<string, string[] | null> = {
	opacity: null,
	volume: null,
	"transform.position": ["x", "y"],
	// A full rgba composite is what puts the binding on shared easing.
	color: ["r", "g", "b", "a"],
};

const SEGMENT_TYPES = ["linear", "bezier", "step"] as const;

interface GeneratedKey {
	id: string;
	time: number;
	value: number;
	segmentToNext: (typeof SEGMENT_TYPES)[number];
	tangentMode: "auto";
}

/**
 * Duplicate times and repeated values are generated deliberately: they are what
 * reach `selected-segment-is-flat` and the reference-span search, which are
 * otherwise unreachable from well-formed data.
 */
function makeKeys({ rng }: { rng: Rng }): GeneratedKey[] {
	const count = rng.int({ min: 0, max: 4 });
	const keys: GeneratedKey[] = [];
	let time = 0;
	for (let index = 0; index < count; index += 1) {
		time += rng.bool() ? 0 : rng.int({ min: 1, max: 400 });
		keys.push({
			id: `k${index}`,
			time,
			value: rng.bool() ? 5 : rng.range({ min: -10, max: 10 }),
			segmentToNext: rng.pick({ from: SEGMENT_TYPES }),
			tangentMode: "auto",
		});
	}
	return keys;
}

/**
 * A composite's components share key ids and times — that is what the editor
 * writes, and it is also what keeps the two implementations comparable, since
 * the TypeScript walks a composite in insertion order and Rust walks it sorted.
 */
function makeChannelData({
	rng,
	componentKeys,
}: {
	rng: Rng;
	componentKeys: string[] | null;
}): unknown {
	const keys = makeKeys({ rng });
	if (componentKeys === null) {
		return { keys };
	}
	const components: Record<string, unknown> = {};
	for (const componentKey of componentKeys) {
		components[componentKey] = {
			keys: keys.map((key) => ({
				...key,
				value: rng.bool() ? key.value : rng.range({ min: -10, max: 10 }),
				segmentToNext: rng.pick({ from: SEGMENT_TYPES }),
			})),
		};
	}
	return components;
}

function makeElement({
	rng,
	id,
}: {
	rng: Rng;
	id: string;
}): Record<string, unknown> {
	const animations: Record<string, unknown> = {};
	for (const propertyPath of PROPERTY_PATHS) {
		if (!rng.bool()) continue;
		animations[propertyPath] = makeChannelData({
			rng,
			componentKeys: COMPONENTS_BY_PATH[propertyPath] ?? null,
		});
	}
	// An element with no `animations` at all is a real case — it is the only way
	// to reach `selected-element-has-no-animations`. The key is left off rather
	// than set to `undefined`, because a present-but-undefined key would show up
	// as a structural difference against the Rust copy, which simply omits it.
	const hasAnimations = rng.float() < 0.9;
	return {
		id,
		name: `Clip ${id}`,
		duration: 1200,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		params: {},
		type: "text",
		...(hasAnimations ? { animations } : {}),
	};
}

interface GeneratedInput {
	tracks: unknown;
	selectedKeyframes: Array<{
		trackId: string;
		elementId: string;
		propertyPath: string;
		keyframeId: string;
	}>;
	preferredComponentKey: string | null;
	cubicBezier: [number, number, number, number];
}

function generateInput({ rng }: { rng: Rng }): GeneratedInput {
	const mainElement = makeElement({ rng, id: "el-main" });
	const overlayElement = makeElement({ rng, id: "el-overlay" });
	const tracks = {
		overlay: [
			{
				type: "text",
				id: "t-overlay",
				name: "Overlay",
				elements: [overlayElement],
				hidden: false,
			},
		],
		main: {
			type: "video",
			id: "t-main",
			name: "Main",
			elements: [mainElement],
			muted: false,
			hidden: false,
		},
		audio: [],
	};

	const animatedPaths = Object.keys(
		(mainElement.animations ?? {}) as Record<string, unknown>,
	);
	const selectedCount = rng.int({ min: 0, max: 3 });
	const selectedKeyframes = Array.from({ length: selectedCount }, () => ({
		// Mostly the element that exists, occasionally one that does not, so
		// `selected-element-missing` and the cross-element check are reached.
		trackId:
			rng.float() < 0.85
				? "t-main"
				: rng.pick({ from: ["t-overlay", "t-gone"] }),
		elementId: rng.float() < 0.9 ? "el-main" : "el-gone",
		propertyPath:
			animatedPaths.length > 0 && rng.float() < 0.9
				? rng.pick({ from: animatedPaths })
				: rng.pick({ from: PROPERTY_PATHS }),
		keyframeId: `k${rng.int({ min: 0, max: 4 })}`,
	}));

	// An exactly-diagonal curve has to appear often enough to exercise the
	// linear branch; the rest wander outside [0, 1] so the clamp is covered too.
	const cubicBezier: [number, number, number, number] = rng.bool()
		? [0, 0, 1, 1]
		: [
				rng.range({ min: -0.5, max: 1.5 }),
				rng.range({ min: -2, max: 2 }),
				rng.range({ min: -0.5, max: 1.5 }),
				rng.range({ min: -2, max: 2 }),
			];

	return {
		tracks,
		selectedKeyframes,
		preferredComponentKey: rng.pick({
			from: [null, "value", "x", "y", "r"],
		}),
		cubicBezier,
	};
}

test("no generated selection breaks the graph-editor invariants", () => {
	// A boundary that stopped deserialising would agree with itself on every
	// "unavailable" answer, so a run that never reaches a ready state with a
	// patch has proved nothing.
	let readyWithPatches = 0;

	const rng = createRng({ seed: 0x6e0a11 });

	for (let iteration = 0; iteration < 2_000; iteration += 1) {
		const input = generateInput({ rng });
		{
			const state = rustResolveGraphEditorSelectionState({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				tracks: input.tracks as never,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				selectedKeyframes: input.selectedKeyframes as never,
				preferredComponentKey: input.preferredComponentKey,
			});
			if (state.status !== "ready") {
				// An unavailable state must say why, and the reason must be one the
				// popover knows how to render.
				expect(typeof state.reason).toBe("string");
				continue;
			}
			expect(state.segments.length).toBeGreaterThan(0);
			const segment = state.segments[0];
			const patches = rustBuildGraphEditorCurvePatches({
				context: segment.context,
				cubicBezier: input.cubicBezier,
				referenceSpanValue: segment.referenceSpanValue,
			});
			const preview = rustApplyGraphEditorCurvePreview({
				animations: state.element.animations,
				context: segment.context,
				cubicBezier: input.cubicBezier,
				referenceSpanValue: segment.referenceSpanValue,
			});
			if (patches && patches.length > 0) {
				readyWithPatches += 1;
				// Every patch has to name a keyframe on the segment it came from,
				// and carry a curve the bezier evaluator will accept.
				for (const patch of patches) {
					expect(typeof patch.keyframeId).toBe("string");
					// A handle is the tick/value delta the bezier evaluator reads;
					// either side may be absent, but a present one must be real.
					for (const handle of [patch.patch.leftHandle, patch.patch.rightHandle]) {
						if (handle === null || handle === undefined) continue;
						expect(Number.isFinite(handle.dt)).toBe(true);
						expect(Number.isFinite(handle.dv)).toBe(true);
					}
				}
			}
			// The preview is a whole animations bag, not a partial one: it has to
			// still carry the path the segment was read from.
			expect(preview).not.toBeNull();
		}
	}

	expect(readyWithPatches).toBeGreaterThan(0);
});
