import type {
	AdjustmentElement,
	EffectableElement,
	MaskableElement,
	TransitionableElement,
} from "./types";
import type { ParamValues } from "@/params";

interface BaseDragData {
	id: string;
	name: string;
}

interface MediaDragData extends BaseDragData {
	type: "media";
	mediaType: "image" | "video" | "audio";
	targetElementTypes?: MaskableElement["type"][];
}

interface TextDragData extends BaseDragData {
	type: "text";
	content: string;
}

interface StickerDragData extends BaseDragData {
	type: "sticker";
	stickerId: string;
}

interface GraphicDragData extends BaseDragData {
	type: "graphic";
	definitionId: string;
	params: Partial<ParamValues>;
}

interface EffectDragData extends BaseDragData {
	type: "effect";
	effectType: string;
	targetElementTypes: EffectableElement["type"][];
}

/**
 * A transition drag never creates an element — it can only land on a clip that
 * already shares a cut with its neighbour, which is why it carries no duration
 * or placement information.
 */
interface TransitionDragData extends BaseDragData {
	type: "transition";
	transitionType: string;
	targetElementTypes: TransitionableElement["type"][];
}

interface AdjustmentDragData extends BaseDragData {
	type: "adjustment";
	adjustmentType: string;
	/** Dropping onto an existing adjustment layer appends to its stack. */
	targetElementTypes: AdjustmentElement["type"][];
}

export type TimelineDragData =
	| MediaDragData
	| TextDragData
	| StickerDragData
	| GraphicDragData
	| EffectDragData
	| TransitionDragData
	| AdjustmentDragData;
