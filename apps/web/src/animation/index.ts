// Keyframe editing lives in `editor-core::animation::keyframes`; only
// `upsertPathKeyframe` is still TypeScript, because it takes the param layout's
// `decompose` and a `coerceValue` callback, and closures do not serialise.
export {
	cloneAnimations,
	removeElementKeyframe,
	retimeElementKeyframe,
	setChannel,
	splitAnimationsAtTime,
	updateScalarKeyframeCurve,
} from "@/wasm/keyframes";
export { upsertPathKeyframe } from "@/wasm/keyframes-upsert";

export {
	getElementLocalTime,
	resolveAnimationPathValueAtTime,
} from "./resolve";

export {
	getElementKeyframes,
	getKeyframeById,
	getKeyframeAtTime,
	hasKeyframesForPath,
} from "./keyframe-query";

export {
	buildGraphicParamPath,
	resolveGraphicParamsAtTime,
} from "./graphic-param-channel";

export { buildEffectParamPath } from "./effect-param-channel";

