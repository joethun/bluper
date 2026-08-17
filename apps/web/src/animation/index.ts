export {
	clampAnimationsToDuration,
	cloneAnimations,
	removeElementKeyframe,
	retimeElementKeyframe,
	setChannel,
	splitAnimationsAtTime,
	updateScalarKeyframeCurve,
	upsertPathKeyframe,
} from "./keyframes";

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
	getEditableScalarChannels,
	getScalarKeyframeContext,
} from "./graph-channels";

export {
	getCurveHandlesForNormalizedCubicBezier,
	getNormalizedCubicBezierForScalarSegment,
} from "./curve-bridge";

export {
	buildGraphicParamPath,
	resolveGraphicParamsAtTime,
} from "./graphic-param-channel";

export { buildEffectParamPath } from "./effect-param-channel";

