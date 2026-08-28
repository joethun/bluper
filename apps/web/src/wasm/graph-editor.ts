import {
	applyGraphEditorCurvePreview as _applyGraphEditorCurvePreview,
	buildGraphEditorCurvePatches as _buildGraphEditorCurvePatches,
	resolveGraphEditorSelectionState as _resolveGraphEditorSelectionState,
} from "bluper-wasm";
import type {
	ElementAnimations,
	NormalizedCubicBezier,
	ScalarCurveKeyframePatch,
	ScalarGraphKeyframeContext,
	SelectedKeyframeRef,
} from "@/animation/types";
import type { SceneTracks, TimelineElement } from "@/timeline";

/**
 * The curve editor's session state, now owned by
 * `editor-core::animation::graph_editor`.
 *
 * This replaces the TypeScript in
 * `apps/web/src/timeline/components/graph-editor/session.ts`, which reached the
 * same Rust one call at a time: resolving a single selection crossed the
 * boundary once per property, per component, per candidate component key —
 * `getEditableScalarChannels`, `getScalarKeyframeContext` and
 * `getNormalizedCubicBezierForScalarSegment` were all wasm calls. Rust now makes
 * those calls in-process and the whole answer crosses once.
 */

/** One entry in the component picker above the curve. */
export interface GraphEditorComponentOption {
	key: string;
	label: string;
}

/**
 * Why the selection has no editable curve. A union rather than a message, so
 * the panel's switch stops compiling when Rust grows a reason without a
 * sentence to go with it.
 */
type GraphEditorUnavailableReason =
	| "no-keyframe-selected"
	| "multiple-keyframes-selected"
	| "selected-keyframes-span-multiple-elements"
	| "selected-keyframes-are-not-adjacent"
	| "selected-properties-have-no-shared-component"
	| "selected-element-missing"
	| "selected-element-has-no-animations"
	| "selected-keyframe-has-no-scalar-channel"
	| "selected-keyframe-missing-on-channel"
	| "selected-keyframe-has-no-next-segment"
	| "selected-segment-is-hold"
	| "selected-segment-is-flat";

interface GraphEditorResolvedSegment {
	propertyPath: SelectedKeyframeRef["propertyPath"];
	keyframeId: string;
	context: ScalarGraphKeyframeContext;
	/**
	 * Every context a write under this component key has to touch — one for a
	 * plain scalar, all four for a colour on shared easing.
	 */
	allContexts: ScalarGraphKeyframeContext[];
	cubicBezier: NormalizedCubicBezier;
	referenceSpanValue: number;
}

interface GraphEditorBaseSelectionState {
	componentOptions: GraphEditorComponentOption[];
	activeComponentKey: string | null;
	message: string;
}

interface GraphEditorUnavailableState extends GraphEditorBaseSelectionState {
	status: "unavailable";
	reason: GraphEditorUnavailableReason;
}

interface GraphEditorReadyState extends GraphEditorBaseSelectionState {
	status: "ready";
	trackId: string;
	elementId: string;
	element: TimelineElement;
	segments: GraphEditorResolvedSegment[];
	cubicBezier: NormalizedCubicBezier;
}

export type GraphEditorSelectionState =
	| GraphEditorUnavailableState
	| GraphEditorReadyState;

export interface GraphEditorCurvePatch {
	keyframeId: string;
	patch: ScalarCurveKeyframePatch;
}

/**
 * Cast helper for the values that only differ by branding across the boundary:
 * `MediaTime` flattens to `number`, and `TimelineElement`'s `#[serde(flatten)]`
 * has no TypeScript rendering, so the generated signatures cannot name what the
 * callers already hold.
 */
function toWasm<T>({ value }: { value: T }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as unknown as never;
}

/**
 * Rust names the control points as a four-element sequence; the curve editor
 * works in the `[x1, y1, x2, y2]` tuple. The length is guaranteed by the
 * producer, which is why this is an assertion rather than a check.
 */
function toCubicBezier({ curve }: { curve: number[] }): NormalizedCubicBezier {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return curve as NormalizedCubicBezier;
}

/**
 * `previousKey`/`nextKey` are absent rather than `null` on the wire, because
 * the Rust side skips a `None` neighbour instead of writing it out. The TS
 * interface says `null`, so they are normalised on the way in.
 */
function fromWasmContext({
	context,
}: {
	context: ScalarGraphKeyframeContext;
}): ScalarGraphKeyframeContext {
	return {
		...context,
		previousKey: context.previousKey ?? null,
		nextKey: context.nextKey ?? null,
	};
}

function fromWasmSegment({
	segment,
}: {
	segment: GraphEditorResolvedSegment & { cubicBezier: number[] };
}): GraphEditorResolvedSegment {
	return {
		...segment,
		context: fromWasmContext({ context: segment.context }),
		allContexts: segment.allContexts.map((context) =>
			fromWasmContext({ context }),
		),
		cubicBezier: toCubicBezier({ curve: segment.cubicBezier }),
	};
}

/**
 * What the curve editor should show for the current keyframe selection: the
 * component picker, the segments being shaped, and either a curve or the reason
 * there is none.
 */
export function resolveGraphEditorSelectionState({
	tracks,
	selectedKeyframes,
	preferredComponentKey,
}: {
	tracks: SceneTracks;
	selectedKeyframes: SelectedKeyframeRef[];
	preferredComponentKey?: string | null;
}): GraphEditorSelectionState {
	const state = _resolveGraphEditorSelectionState({
		tracks: toWasm({ value: tracks }),
		selectedKeyframes,
		preferredComponentKey: preferredComponentKey ?? undefined,
	});
	if (state.status === "unavailable") {
		// Narrowed by the discriminant; no assertion needed.
		return state;
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const ready = state as unknown as GraphEditorReadyState & {
		segments: Array<GraphEditorResolvedSegment & { cubicBezier: number[] }>;
		cubicBezier: number[];
	};
	return {
		...ready,
		segments: ready.segments.map((segment) => fromWasmSegment({ segment })),
		cubicBezier: toCubicBezier({ curve: ready.cubicBezier }),
	};
}

/**
 * The pair of key writes a curve shape turns into — the left key's outgoing
 * handle and the right key's incoming one — or `null` when the segment cannot
 * carry a curve.
 */
export function buildGraphEditorCurvePatches({
	context,
	cubicBezier,
	referenceSpanValue,
}: {
	context: ScalarGraphKeyframeContext;
	cubicBezier: NormalizedCubicBezier;
	referenceSpanValue: number;
}): GraphEditorCurvePatch[] | null {
	const result = _buildGraphEditorCurvePatches({
		context: toWasm({ value: context }),
		cubicBezier: [...cubicBezier],
		referenceSpanValue,
	});
	if (!result) {
		return null;
	}
	// The patch shape differs from `ScalarCurveKeyframePatch` only in the
	// branding of a handle's `dt`, which is a whole number of ticks here.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return result.patches as unknown as GraphEditorCurvePatch[];
}

/**
 * Apply a curve shape to an element's animations without going through the undo
 * stack — what the panel calls while a control point is still under the cursor.
 * A segment that cannot carry a curve leaves the animations untouched.
 */
export function applyGraphEditorCurvePreview({
	animations,
	context,
	cubicBezier,
	referenceSpanValue,
}: {
	animations: ElementAnimations | undefined;
	context: ScalarGraphKeyframeContext;
	cubicBezier: NormalizedCubicBezier;
	referenceSpanValue: number;
}): ElementAnimations | undefined {
	return (
		_applyGraphEditorCurvePreview({
			animations: toWasm({ value: animations }),
			context: toWasm({ value: context }),
			cubicBezier: [...cubicBezier],
			referenceSpanValue,
		}).animations ?? undefined
	);
}
