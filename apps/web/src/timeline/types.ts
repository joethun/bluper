import type { ElementAnimations } from "@/animation/types";
import type { Adjustment } from "@/adjustments/types";
import type { Effect } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import type { ElementTransition } from "@/transitions/types";
import type { MediaTime } from "@/wasm";

export type ElementRef = {
	trackId: string;
	elementId: string;
};

export interface Bookmark {
	time: MediaTime;
	note?: string;
	color?: string;
	duration?: MediaTime;
}

export interface TScene {
	id: string;
	name: string;
	isMain: boolean;
	tracks: SceneTracks;
	bookmarks: Bookmark[];
	createdAt: Date;
	updatedAt: Date;
}

export type TrackType =
	| "video"
	| "text"
	| "audio"
	| "graphic"
	| "effect"
	| "adjustment";

interface BaseTrack {
	id: string;
	name: string;
}

export interface VideoTrack extends BaseTrack {
	type: "video";
	elements: (VideoElement | ImageElement)[];
	muted: boolean;
	hidden: boolean;
}

export interface TextTrack extends BaseTrack {
	type: "text";
	elements: TextElement[];
	hidden: boolean;
}

export interface AudioTrack extends BaseTrack {
	type: "audio";
	elements: AudioElement[];
	muted: boolean;
}

export interface GraphicTrack extends BaseTrack {
	type: "graphic";
	elements: (StickerElement | GraphicElement)[];
	hidden: boolean;
}

export interface EffectTrack extends BaseTrack {
	type: "effect";
	elements: EffectElement[];
	hidden: boolean;
}

export interface AdjustmentTrack extends BaseTrack {
	type: "adjustment";
	elements: AdjustmentElement[];
	hidden: boolean;
}

export type TimelineTrack =
	| VideoTrack
	| TextTrack
	| AudioTrack
	| GraphicTrack
	| EffectTrack
	| AdjustmentTrack;

type OverlayTrack =
	| VideoTrack
	| TextTrack
	| GraphicTrack
	| EffectTrack
	| AdjustmentTrack;

export interface SceneTracks {
	overlay: OverlayTrack[];
	main: VideoTrack;
	audio: AudioTrack[];
}

export type RetimeCurvePresetId =
	| "custom"
	| "montage"
	| "hero"
	| "bullet"
	| "jumpCut"
	| "flashIn"
	| "flashOut";

/**
 * One handle on a speed curve. `position` is a fraction of the clip's visible
 * source span rather than a time, so the shape survives trimming and resizing:
 * the same curve stretches across whatever material the clip still shows.
 */
export interface RetimeCurvePoint {
	position: number;
	rate: number;
}

export interface RetimeCurve {
	preset: RetimeCurvePresetId;
	points: RetimeCurvePoint[];
}

/**
 * How fast a clip walks its source. `rate` is the single uniform speed; when
 * `curve` is set the speed varies across the clip and `rate` is only kept as the
 * average, for code paths that need one number to describe the whole clip.
 */
export interface RetimeConfig {
	rate: number;
	maintainPitch?: boolean;
	curve?: RetimeCurve;
}

/**
 * Marks a clip as a held still. `sourceTime` is an absolute source-media time
 * (already past `trimStart`), so the renderer samples the exact same frame for
 * every timeline time the clip covers, and trimming/resizing the clip never
 * moves the held frame.
 */
export interface FreezeConfig {
	sourceTime: MediaTime;
}

/**
 * Ramps a clip up from and down to the background over its own head and tail.
 * Unlike a transition it involves one clip and no neighbour, so it always has
 * somewhere to play and never borrows footage; it is a plain opacity envelope.
 */
export interface FadeConfig {
	in?: MediaTime;
	out?: MediaTime;
}

interface BaseAudioElement extends BaseTimelineElement {
	type: "audio";
	retime?: RetimeConfig;
}

export interface UploadAudioElement extends BaseAudioElement {
	sourceType: "upload";
	mediaId: string;
}

export interface LibraryAudioElement extends BaseAudioElement {
	sourceType: "library";
	sourceUrl: string;
}

export type AudioElement = UploadAudioElement | LibraryAudioElement;

interface BaseTimelineElement {
	id: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	animations?: ElementAnimations;
	params: ParamValues;
	groupId?: string;
}

export interface VideoElement extends BaseTimelineElement {
	type: "video";
	mediaId: string;
	isSourceAudioEnabled?: boolean;
	hidden?: boolean;
	retime?: RetimeConfig;
	freeze?: FreezeConfig;
	effects?: Effect[];
	masks?: Mask[];
	transitionIn?: ElementTransition;
	fade?: FadeConfig;
}

export interface ImageElement extends BaseTimelineElement {
	type: "image";
	mediaId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
	transitionIn?: ElementTransition;
	fade?: FadeConfig;
}

export interface TextElement extends BaseTimelineElement {
	type: "text";
	hidden?: boolean;
	fade?: FadeConfig;
}

export interface StickerElement extends BaseTimelineElement {
	type: "sticker";
	stickerId: string;
	/** Natural dimensions of the sticker asset, stored at insert time. Used by renderer and preview bounds to avoid split-brain geometry. */
	intrinsicWidth?: number;
	intrinsicHeight?: number;
	hidden?: boolean;
	effects?: Effect[];
}

export interface GraphicElement extends BaseTimelineElement {
	type: "graphic";
	definitionId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
}

export interface EffectElement extends BaseTimelineElement {
	type: "effect";
	effectType: string;
}

/**
 * An adjustment layer. Like CapCut's, it owns no pixels of its own: it carries a
 * stack of colour/tone adjustments that are applied to every visual layer drawn
 * beneath it, for exactly the span it covers.
 */
export interface AdjustmentElement extends BaseTimelineElement {
	type: "adjustment";
	adjustments: Adjustment[];
	hidden?: boolean;
}

export type TimelineElement =
	| AudioElement
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement
	| GraphicElement
	| EffectElement
	| AdjustmentElement;

export type ElementType = TimelineElement["type"];

function elementTypes<T extends ElementType[]>(...types: T): T {
	return types;
}

export const MASKABLE_ELEMENT_TYPES = elementTypes("video", "image", "graphic");

export type MaskableElement = Extract<
	TimelineElement,
	{ type: (typeof MASKABLE_ELEMENT_TYPES)[number] }
>;

export const RETIMABLE_ELEMENT_TYPES = elementTypes("video", "audio");

export type RetimableElement = Extract<
	TimelineElement,
	{ type: (typeof RETIMABLE_ELEMENT_TYPES)[number] }
>;

export const HIDEABLE_ELEMENT_TYPES = elementTypes(
	"video",
	"image",
	"text",
	"sticker",
	"graphic",
	"adjustment",
);

export type HideableElement = Extract<
	TimelineElement,
	{ type: (typeof HIDEABLE_ELEMENT_TYPES)[number] }
>;

/**
 * Transitions live on the *incoming* clip and straddle the cut it shares with
 * the clip before it, which is why only the media element types carry one —
 * text, stickers and graphics are composited over the cut rather than butted
 * against it.
 */
export const TRANSITIONABLE_ELEMENT_TYPES = elementTypes("video", "image");

export type TransitionableElement = Extract<
	TimelineElement,
	{ type: (typeof TRANSITIONABLE_ELEMENT_TYPES)[number] }
>;

/**
 * Fading needs no neighbour, so any clip with pixels of its own can do it — the
 * stickers and shapes are still outstanding, since they resolve their opacity on
 * separate paths.
 */
const _FADEABLE_ELEMENT_TYPES = elementTypes("video", "image", "text");

export type FadeableElement = Extract<
	TimelineElement,
	{ type: (typeof _FADEABLE_ELEMENT_TYPES)[number] }
>;

export const FREEZABLE_ELEMENT_TYPES = elementTypes("video");

export type FreezableElement = Extract<
	TimelineElement,
	{ type: (typeof FREEZABLE_ELEMENT_TYPES)[number] }
>;

/**
 * The types the Adjust panel grades. Only footage and stills: text, stickers and
 * shapes have their colour chosen outright in their own panel, so a grade laid
 * over the top would be fighting the author rather than correcting a camera.
 */
export type AdjustableElement = Extract<
	TimelineElement,
	{ type: "video" | "image" }
>;

export const VISUAL_ELEMENT_TYPES = elementTypes(
	"video",
	"image",
	"text",
	"sticker",
	"graphic",
);

export type VisualElement = Extract<
	TimelineElement,
	{ type: (typeof VISUAL_ELEMENT_TYPES)[number] }
>;

/**
 * The types the Effects panel stacks passes onto. Text is deliberately absent:
 * its look is authored outright in the Text panel, and a pass laid over the
 * glyphs fights that rather than adding to it.
 */
export const EFFECTABLE_ELEMENT_TYPES = elementTypes(
	"video",
	"image",
	"sticker",
	"graphic",
);

export type EffectableElement = Extract<
	TimelineElement,
	{ type: (typeof EFFECTABLE_ELEMENT_TYPES)[number] }
>;

export type CreateUploadAudioElement = Omit<UploadAudioElement, "id">;
type CreateLibraryAudioElement = Omit<LibraryAudioElement, "id">;
type CreateAudioElement =
	| CreateUploadAudioElement
	| CreateLibraryAudioElement;
export type CreateVideoElement = Omit<VideoElement, "id">;
export type CreateImageElement = Omit<ImageElement, "id">;
type CreateTextElement = Omit<TextElement, "id">;
export type CreateStickerElement = Omit<StickerElement, "id">;
export type CreateGraphicElement = Omit<GraphicElement, "id">;
export type CreateEffectElement = Omit<EffectElement, "id">;
export type CreateAdjustmentElement = Omit<AdjustmentElement, "id">;
export type CreateTimelineElement =
	| CreateAudioElement
	| CreateVideoElement
	| CreateImageElement
	| CreateTextElement
	| CreateStickerElement
	| CreateGraphicElement
	| CreateEffectElement
	| CreateAdjustmentElement;

export type ElementDragView =
	| { readonly kind: "idle" }
	| {
			readonly kind: "dragging";
			readonly anchorElementId: string;
			readonly trackId: string;
			readonly memberTimeOffsets: ReadonlyMap<string, MediaTime>;
			readonly startMouseX: number;
			readonly startMouseY: number;
			readonly startElementTime: MediaTime;
			readonly clickOffsetTime: MediaTime;
			readonly currentTime: MediaTime;
			readonly currentMouseX: number;
			readonly currentMouseY: number;
			readonly dropTarget: DropTarget | null;
	  };

export interface DropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: MediaTime;
	targetElement: { elementId: string; trackId: string } | null;
	/**
	 * The join a transition drag has snapped to. Set only for transition drags,
	 * which land on a boundary between two clips rather than inside one, so the
	 * timeline can mark the seam instead of a whole clip.
	 */
	seamTime?: MediaTime;
}
