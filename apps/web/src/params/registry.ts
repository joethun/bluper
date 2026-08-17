import type { ParamDefinition, ParamValue, ParamValues } from "@/params";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { BlendMode } from "@/rendering";
import type { ElementType, TimelineElement } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import { CORNER_RADIUS_MAX, CORNER_RADIUS_MIN } from "@/text/background";

export type ElementParamDefinition<TKey extends string = string> =
	ParamDefinition<TKey> & {
		read?: ({ element }: { element: TimelineElement }) => ParamValue | null;
		write?: ({
			element,
			value,
		}: {
			element: TimelineElement;
			value: ParamValue;
		}) => TimelineElement;
	};

export function buildDefaultParamValues(
	params: readonly ParamDefinition[],
): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		values[param.key] = param.default;
	}
	return values;
}

export class DefinitionRegistry<TKey extends string, TDefinition> {
	private definitions = new Map<TKey, TDefinition>();
	private entityName: string;

	constructor(entityName: string) {
		this.entityName = entityName;
	}

	register({ key, definition }: { key: TKey; definition: TDefinition }): void {
		this.definitions.set(key, definition);
	}

	has(key: TKey): boolean {
		return this.definitions.has(key);
	}

	get(key: TKey): TDefinition {
		const def = this.definitions.get(key);
		if (!def) {
			throw new Error(`Unknown ${this.entityName}: ${key}`);
		}
		return def;
	}

	getAll(): TDefinition[] {
		return Array.from(this.definitions.values());
	}
}

const BLEND_MODE_OPTIONS: Array<{ value: BlendMode; label: string }> = [
	{ value: "normal", label: "Normal" },
	{ value: "darken", label: "Darken" },
	{ value: "multiply", label: "Multiply" },
	{ value: "color-burn", label: "Color Burn" },
	{ value: "lighten", label: "Lighten" },
	{ value: "screen", label: "Screen" },
	{ value: "plus-lighter", label: "Plus Lighter" },
	{ value: "color-dodge", label: "Color Dodge" },
	{ value: "overlay", label: "Overlay" },
	{ value: "soft-light", label: "Soft Light" },
	{ value: "hard-light", label: "Hard Light" },
	{ value: "difference", label: "Difference" },
	{ value: "exclusion", label: "Exclusion" },
	{ value: "hue", label: "Hue" },
	{ value: "saturation", label: "Saturation" },
	{ value: "color", label: "Color" },
	{ value: "luminosity", label: "Luminosity" },
];

/**
 * The Adjust panel, laid out the way a colourist works: what the colour is, then
 * how the light falls, then what is done to the grain of the picture. Each group
 * resets as a unit, so a whole pass can be thrown away without touching the rest.
 *
 * Every slider here has to reach for something none of its neighbours can. Two
 * did not, and are gone: Shine was Brightness with a softer roll-off, and Fade
 * was a black lift plus a saturation drop, which is Shadow and Saturation put
 * together. The group is called Texture rather than Effects because the tab rail
 * already has an Effects tab, and two lists under one word is one too many.
 */
export const ADJUSTMENT_PARAM_GROUPS: ReadonlyArray<{
	title: string;
	keys: readonly string[];
}> = [
	{
		title: "Color",
		keys: ["adjust.saturation", "adjust.temperature", "adjust.hue"],
	},
	{
		title: "Lightness",
		keys: [
			"adjust.brightness",
			"adjust.contrast",
			"adjust.highlight",
			"adjust.shadow",
		],
	},
	{
		title: "Texture",
		keys: ["adjust.sharpness", "adjust.vignette", "adjust.grain"],
	},
];

/** The keys the Adjust tab lists, in the order it lists them. */
export const ADJUSTMENT_PARAM_KEYS: readonly string[] =
	ADJUSTMENT_PARAM_GROUPS.flatMap((group) => [...group.keys]);

/**
 * Adjust sliders are integers on the same -100..100 scale (0 = leave it alone)
 * that the adjustment definitions in `@/adjustments` read, so the panel stores
 * exactly what the maths consumes. `signed: false` is for the ones that only add
 * — grain cannot be removed from a clean frame — which start at the left instead
 * of the middle.
 *
 * A `trackGradient` is given only where the ramp means something: dark to bright,
 * cool to warm, grey to saturated. Sliders whose ends have no colour to show, such
 * as sharpness, keep a plain track rather than a decorative one.
 */
function adjustParam({
	key,
	label,
	signed = true,
	trackGradient,
}: {
	key: string;
	label: string;
	signed?: boolean;
	trackGradient?: string;
}): ElementParamDefinition {
	return {
		key: `adjust.${key}`,
		label,
		type: "number",
		default: 0,
		min: signed ? -100 : 0,
		max: 100,
		step: 1,
		control: "slider",
		trackGradient,
	};
}

const LUMINANCE_GRADIENT = "linear-gradient(to right, #26262e, #ffffff)";

const adjustmentElementParams: ElementParamDefinition[] = [
	adjustParam({
		key: "saturation",
		label: "Saturation",
		trackGradient: "linear-gradient(to right, #55555f, #22e06a)",
	}),
	adjustParam({
		key: "temperature",
		label: "Temperature",
		// The ends mirror the cool/warm washes the temperature adjustment paints.
		trackGradient: "linear-gradient(to right, #2f9dff, #8b8b96 50%, #ff7a2f)",
	}),
	adjustParam({
		key: "hue",
		label: "Hue",
		trackGradient:
			"linear-gradient(to right, #ff2f6a, #ffd12f, #22e06a, #2f9dff, #a12fff, #ff2f6a)",
	}),
	adjustParam({
		key: "brightness",
		label: "Brightness",
		trackGradient: LUMINANCE_GRADIENT,
	}),
	adjustParam({
		key: "contrast",
		label: "Contrast",
		trackGradient: LUMINANCE_GRADIENT,
	}),
	adjustParam({ key: "highlight", label: "Highlight" }),
	adjustParam({ key: "shadow", label: "Shadow" }),
	adjustParam({ key: "sharpness", label: "Sharpness", signed: false }),
	adjustParam({ key: "vignette", label: "Vignette", signed: false }),
	adjustParam({ key: "grain", label: "Grain", signed: false }),
];

const visualElementParams: ElementParamDefinition[] = [
	{
		key: "transform.positionX",
		label: "Position X",
		type: "number",
		default: DEFAULTS.element.transform.position.x,
		min: -100_000,
		step: 1,
		suffix: "px",
	},
	{
		key: "transform.positionY",
		label: "Position Y",
		type: "number",
		default: DEFAULTS.element.transform.position.y,
		min: -100_000,
		step: 1,
		suffix: "px",
	},
	{
		key: "transform.scaleX",
		label: "Scale X",
		type: "number",
		default: DEFAULTS.element.transform.scaleX,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
		suffix: "x",
	},
	{
		key: "transform.scaleY",
		label: "Scale Y",
		type: "number",
		default: DEFAULTS.element.transform.scaleY,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
		suffix: "x",
	},
	{
		key: "transform.rotate",
		label: "Rotate",
		type: "number",
		default: DEFAULTS.element.transform.rotate,
		min: -360,
		max: 360,
		step: 1,
		suffix: "°",
	},
	{
		key: "opacity",
		label: "Opacity",
		type: "number",
		default: DEFAULTS.element.opacity,
		min: 0,
		max: 1,
		step: 0.01,
		unit: "percent",
		// Reads as one more of the Adjust panel's sliders, which is the only place it
		// is shown. The slider works in stored 0..1 space while the number field
		// beside it still shows a percentage.
		control: "slider",
	},
	{
		key: "blendMode",
		label: "Blend Mode",
		type: "select",
		default: DEFAULTS.element.blendMode,
		keyframable: false,
		options: BLEND_MODE_OPTIONS,
	},
];

/**
 * How much of each edge the clip throws away, as a fraction of that side of the
 * source. Stored 0..1 and shown as a percentage, so a crop copied between clips
 * of different sizes trims the same proportion of each.
 *
 * Not keyframable: the cropped size is what everything downstream fits to the
 * canvas, so animating it would move the layer's whole geometry frame by frame —
 * an effect that belongs to Transform's position and scale, which are animated.
 */
function cropParam({
	key,
	label,
}: {
	key: string;
	label: string;
}): ElementParamDefinition {
	return {
		key: `crop.${key}`,
		label,
		type: "number",
		default: 0,
		min: 0,
		max: 1,
		step: 0.01,
		unit: "percent",
		control: "slider",
		keyframable: false,
	};
}

const cropElementParams: ElementParamDefinition[] = [
	cropParam({ key: "left", label: "Left" }),
	cropParam({ key: "right", label: "Right" }),
	cropParam({ key: "top", label: "Top" }),
	cropParam({ key: "bottom", label: "Bottom" }),
];

/**
 * Only footage and stills carry the colour/tone sliders. Grading text, a sticker
 * or a vector shape means grading something whose colour was chosen outright in
 * the panel above — the sliders would be fighting the author rather than
 * correcting a camera.
 *
 * Cropping is scoped the same way, for the same reason in reverse: a shape or a
 * line of text is drawn at exactly the size it was authored, so there are no
 * edges of a source frame to trim off it.
 */
const mediaElementParams: ElementParamDefinition[] = [
	...visualElementParams,
	...cropElementParams,
	...adjustmentElementParams,
];

const audioElementParams: ElementParamDefinition[] = [
	{
		key: "volume",
		label: "Volume",
		type: "number",
		default: DEFAULTS.element.volume,
		min: VOLUME_DB_MIN,
		max: VOLUME_DB_MAX,
		step: 0.01,
		suffix: "dB",
	},
	{
		key: "muted",
		label: "Muted",
		type: "boolean",
		default: false,
		keyframable: false,
	},
];

const textElementParams: ElementParamDefinition[] = [
	{
		key: "content",
		label: "Content",
		type: "text",
		default: "Default text",
		keyframable: false,
	},
	{
		key: "fontFamily",
		label: "Font Family",
		type: "font",
		default: "Arial",
		keyframable: false,
	},
	{
		key: "fontSize",
		label: "Font Size",
		type: "number",
		default: 15,
		min: 1,
		step: 1,
		suffix: "px",
	},
	{
		key: "color",
		label: "Color",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "textAlign",
		label: "Text Align",
		type: "select",
		default: "center",
		keyframable: false,
		options: [
			{ value: "left", label: "Left" },
			{ value: "center", label: "Center" },
			{ value: "right", label: "Right" },
		],
	},
	{
		key: "fontWeight",
		label: "Font Weight",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "bold", label: "Bold" },
		],
	},
	{
		key: "fontStyle",
		label: "Font Style",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "italic", label: "Italic" },
		],
	},
	{
		key: "textDecoration",
		label: "Text Decoration",
		type: "select",
		default: "none",
		keyframable: false,
		options: [
			{ value: "none", label: "None" },
			{ value: "underline", label: "Underline" },
			{ value: "line-through", label: "Line Through" },
		],
	},
	{
		key: "letterSpacing",
		label: "Letter Spacing",
		type: "number",
		default: DEFAULTS.text.letterSpacing,
		min: -100,
		step: 0.1,
		suffix: "px",
	},
	{
		key: "lineHeight",
		label: "Line Height",
		type: "number",
		default: DEFAULTS.text.lineHeight,
		min: 0.1,
		step: 0.1,
	},
	{
		key: "background.enabled",
		label: "Background Enabled",
		type: "boolean",
		default: DEFAULTS.text.background.enabled,
		keyframable: false,
	},
	{
		key: "background.color",
		label: "Background Color",
		type: "color",
		default: DEFAULTS.text.background.color,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.cornerRadius",
		label: "Background Radius",
		type: "number",
		default: DEFAULTS.text.background.cornerRadius,
		min: CORNER_RADIUS_MIN,
		max: CORNER_RADIUS_MAX,
		step: 1,
		suffix: "px",
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingX",
		label: "Background Padding X",
		type: "number",
		default: DEFAULTS.text.background.paddingX,
		min: 0,
		step: 1,
		suffix: "px",
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingY",
		label: "Background Padding Y",
		type: "number",
		default: DEFAULTS.text.background.paddingY,
		min: 0,
		step: 1,
		suffix: "px",
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetX",
		label: "Background Offset X",
		type: "number",
		default: DEFAULTS.text.background.offsetX,
		min: -100_000,
		step: 1,
		suffix: "px",
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetY",
		label: "Background Offset Y",
		type: "number",
		default: DEFAULTS.text.background.offsetY,
		min: -100_000,
		step: 1,
		suffix: "px",
		dependencies: [{ param: "background.enabled", equals: true }],
	},
];

const elementParamRegistry = new DefinitionRegistry<
	ElementType,
	readonly ElementParamDefinition[]
>("element params");

elementParamRegistry.register({
	key: "video",
	definition: [...mediaElementParams, ...audioElementParams],
});
elementParamRegistry.register({
	key: "image",
	definition: mediaElementParams,
});
elementParamRegistry.register({
	key: "text",
	definition: [...textElementParams, ...visualElementParams],
});
elementParamRegistry.register({
	key: "sticker",
	definition: visualElementParams,
});
elementParamRegistry.register({
	key: "graphic",
	definition: visualElementParams,
});
elementParamRegistry.register({ key: "audio", definition: audioElementParams });
elementParamRegistry.register({ key: "effect", definition: [] });
// An adjustment layer has no element-level params of its own; each entry in its
// stack carries the params from its own definition.
elementParamRegistry.register({ key: "adjustment", definition: [] });

export function getElementParams({
	element,
}: {
	element: TimelineElement;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(element.type)
		? elementParamRegistry.get(element.type)
		: [];
}

export function getBuiltInElementParams({
	type,
}: {
	type: ElementType;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(type) ? elementParamRegistry.get(type) : [];
}

export function getElementParam({
	element,
	key,
}: {
	element: TimelineElement;
	key: string;
}): ElementParamDefinition | null {
	return (
		getElementParams({ element }).find((param) => param.key === key) ?? null
	);
}

export function readElementParamValue({
	element,
	param,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
}): ParamValue | null {
	if (param.read) {
		return param.read({ element });
	}
	if ("params" in element) {
		return element.params[param.key] ?? param.default;
	}
	return null;
}

export function writeElementParamValue({
	element,
	param,
	value,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
	value: ParamValue;
}): TimelineElement {
	if (param.write) {
		return param.write({ element, value });
	}
	if ("params" in element) {
		return {
			...element,
			params: {
				...element.params,
				[param.key]: value,
			},
		};
	}
	return element;
}


