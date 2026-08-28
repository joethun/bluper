import { buildDefaultParamValues } from "@/params/registry";
import { TRANSITIONABLE_ELEMENT_TYPES } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import { transitionsRegistry } from "./registry";
import type {
	ElementTransition,
	TransitionDefinition,
	TransitionFrame,
} from "./types";
import type { TransitionBinding } from "@/wasm/transitions";
import { neutralSide } from "./definitions/shared";
import type { MediaTime } from "@/wasm";

export { registerDefaultTransitions } from "./definitions";
export {
	MIN_TRANSITION_DURATION,
} from "./definitions/shared";
export {
	canElementHaveTransition,
	findTransitionCutAtTime,
	findTransitions,
	getActiveTransitionBinding,
	getTransitionBindingsForElement,
	getTransitionCutForElement,
	getTransitionRenderExtension,
	readElementTransition,
	stripTransitionIn,
	type TransitionBinding,
	type TransitionPlacement,
} from "@/wasm/transitions";
export {
	drawTransitionShape,
	isShapeFullyOpaque,
	isShapeFullyTransparent,
} from "./shape";
export type * from "./types";

export const TRANSITION_TARGET_ELEMENT_TYPES = TRANSITIONABLE_ELEMENT_TYPES;

function getTransitionDefinition({
	transitionType,
}: {
	transitionType: string;
}): TransitionDefinition {
	return transitionsRegistry.get(transitionType);
}

/**
 * The definition for a stored transition, or `null` when nothing answers to that
 * type. A project saved against a transition that has since been removed still
 * has the type on its clips, and the UI has to be able to show it rather than
 * throw on the way to rendering the panel.
 */
export function findTransitionDefinition({
	transitionType,
}: {
	transitionType: string;
}): TransitionDefinition | null {
	return transitionsRegistry.has(transitionType)
		? transitionsRegistry.get(transitionType)
		: null;
}

export function getTransitionDefinitionsForMenu(): TransitionDefinition[] {
	return transitionsRegistry.getAll();
}

export function buildTransitionInstance({
	transitionType,
	duration,
}: {
	transitionType: string;
	duration?: MediaTime;
}): ElementTransition {
	const definition = getTransitionDefinition({ transitionType });

	return {
		id: generateUUID(),
		type: transitionType,
		duration: duration ?? definition.defaultDuration,
		params: buildDefaultParamValues({ params: definition.params }),
	};
}

export function resolveTransitionFrame({
	binding,
	time,
	width,
	height,
}: {
	binding: TransitionBinding;
	time: number;
	width: number;
	height: number;
}): TransitionFrame {
	const span = binding.windowEnd - binding.windowStart;
	if (span <= 0) {
		return { outgoing: neutralSide(), incoming: neutralSide() };
	}

	const progress = Math.min(
		1,
		Math.max(0, (time - binding.windowStart) / span),
	);
	const definition = transitionsRegistry.has(binding.transition.type)
		? transitionsRegistry.get(binding.transition.type)
		: null;
	if (!definition) {
		return { outgoing: neutralSide(), incoming: neutralSide() };
	}

	return definition.resolve({
		progress,
		params: binding.transition.params,
		width,
		height,
	});
}
