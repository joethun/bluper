import {
	effectParamPathValue as _effectParamPathValue,
	graphicParamPathValue as _graphicParamPathValue,
	isAnimationPathValue as _isAnimationPathValue,
	isAnimationPropertyPathValue as _isAnimationPropertyPathValue,
	isAnimationStorageKeyValue as _isAnimationStorageKeyValue,
	isEffectParamPathValue as _isEffectParamPathValue,
	isGraphicParamPathValue as _isGraphicParamPathValue,
	parseEffectParamPathValue as _parseEffectParamPathValue,
	parseGraphicParamPathValue as _parseGraphicParamPathValue,
} from "bluper-wasm";

/**
 * Animation property paths, owned by `editor-core::animation::path`.
 *
 * Three shapes are recognised:
 * - fixed editor properties (`opacity`, `transform.scaleX`, the `adjust.*` set)
 * - a graphic's own params (`params.<key>`)
 * - an effect instance's params (`effects.<id>.params.<key>`)
 *
 * Everything else is a key that happens to live under `animations`, but is not
 * a property path — the legacy `bindings` and `channels` keys are the ones that
 * matter, and the storage-key check is what keeps them from being read as one.
 *
 * While the TypeScript was still around, parity held to exact agreement over
 * generated inputs. It has since been deleted; the parity test in
 * `apps/web/src/animation/__tests__/path-parity.test.ts` keeps the next
 * refactor honest.
 */

export function isAnimationPropertyPath({
	propertyPath,
}: {
	propertyPath: string;
}): boolean {
	return _isAnimationPropertyPathValue({ propertyPath });
}

export function isGraphicParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): boolean {
	return _isGraphicParamPathValue({ propertyPath });
}

export function isEffectParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): boolean {
	return _isEffectParamPathValue({ propertyPath });
}

export function isAnimationPath({
	propertyPath,
}: {
	propertyPath: string;
}): boolean {
	return _isAnimationPathValue({ propertyPath });
}

/**
 * A storage key under `animations` is a property path unless it is one of the
 * legacy keys (`bindings`, `channels`) an older version stored channels under.
 */
export function isAnimationStorageKey({ key }: { key: string }): boolean {
	return _isAnimationStorageKeyValue({ key });
}

export function graphicParamPath({ paramKey }: { paramKey: string }): string {
	return _graphicParamPathValue({ paramKey });
}

export function parseGraphicParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): { paramKey: string } | null {
	const paramKey = _parseGraphicParamPathValue({ propertyPath });
	return paramKey ? { paramKey } : null;
}

export function effectParamPath({
	effectId,
	paramKey,
}: {
	effectId: string;
	paramKey: string;
}): string {
	return _effectParamPathValue({ effectId, paramKey });
}

export function parseEffectParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): { effectId: string; paramKey: string } | null {
	return _parseEffectParamPathValue({ propertyPath }) ?? null;
}