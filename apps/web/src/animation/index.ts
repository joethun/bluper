// Keyframe editing lives in `editor-core::animation::keyframes`; everything
// re-exported below is a typed wrapper over it, `upsertPathKeyframe` included.
// That one takes a `ParamDefinition` rather than the `decompose` and
// `coerceValue` closures it used to — closures do not serialise, and Rust
// derives the layout, the coercion and the decomposition from the param itself.
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

