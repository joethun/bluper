/**
 * Parameter *types*. The behaviour — coercion, colour conversion, channel
 * layout — lives in `editor-core::params` and is re-exported at the bottom.
 *
 * The layout used to be an object carrying `decompose`/`compose` closures.
 * Functions cannot cross a wasm boundary, and the layout is a function of the
 * param's type in any case, so Rust derives it rather than being handed one.
 */
export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

type ParamGroup = "stroke";


interface BaseParamDefinition<TKey extends string = string> {
	key: TKey;
	label: string;
	group?: ParamGroup;
	keyframable?: boolean;
	dependencies?: Array<{ param: string; equals: ParamValue }>;
}

export interface NumberParamDefinition<
	TKey extends string = string,
> extends BaseParamDefinition<TKey> {
	type: "number";
	default: number;
	min: number;
	max?: number;
	step: number;
	/** When set, min/max/step are in display space. display = stored * displayMultiplier. */
	displayMultiplier?: number;
	/** Show as percentage of max. min/max/step/default stay in stored space. */
	unit?: "percent";
	/** Unit rendered after the value in the number field (e.g. "dB"). Display only. */
	suffix?: string;
	/** Short label shown as the scrub handle icon in the number field (e.g. "W", "R"). */
	shortLabel?: string;
	/**
	 * Render as a full-width track slider instead of the scrub field. For params
	 * judged by eye against the picture — exposure, saturation — where the useful
	 * gesture is a sweep rather than a typed number.
	 */
	control?: "slider";
	/**
	 * CSS background for a slider's track, e.g. a blue-to-orange temperature ramp,
	 * so the track itself says which way the slider pushes the picture. Display
	 * only, and only read when `control` is `"slider"`.
	 */
	trackGradient?: string;
}

export interface BooleanParamDefinition<
	TKey extends string = string,
> extends BaseParamDefinition<TKey> {
	type: "boolean";
	default: boolean;
}

interface ColorParamDefinition<
	TKey extends string = string,
> extends BaseParamDefinition<TKey> {
	type: "color";
	default: string;
	/**
	 * Render as an eyedropper instead of the hue/saturation picker, for a colour
	 * whose right value is one already in the picture rather than one to be mixed
	 * by eye. A chroma key's screen colour is the case this exists for.
	 */
	control?: "eyedropper";
}

export interface SelectParamDefinition<
	TKey extends string = string,
> extends BaseParamDefinition<TKey> {
	type: "select";
	default: string;
	options: Array<{ value: string; label: string }>;
}

interface TextParamDefinition<
	TKey extends string = string,
> extends BaseParamDefinition<TKey> {
	type: "text";
	default: string;
}

interface FontParamDefinition<
	TKey extends string = string,
> extends BaseParamDefinition<TKey> {
	type: "font";
	default: string;
}

export type ParamDefinition<TKey extends string = string> =
	| NumberParamDefinition<TKey>
	| BooleanParamDefinition<TKey>
	| ColorParamDefinition<TKey>
	| SelectParamDefinition<TKey>
	| TextParamDefinition<TKey>
	| FontParamDefinition<TKey>;
export {
	coerceParamValue,
	getParamDefaultInterpolation,
	getParamNumericRange,
	parseColorToLinearRgba,
} from "@/wasm/params";
