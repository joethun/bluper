import type { ReactNode } from "react";
import type {
	EffectElement,
	GraphicElement,
	ImageElement,
	MaskableElement,
	RetimableElement,
	FadeableElement,
	StickerElement,
	TextElement,
	EffectableElement,
	VisualElement,
	VideoElement,
	AudioElement,
	AdjustableElement,
	TimelineElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { AdjustTab, BlendingTab } from "@/adjustments/components/adjust-tab";
import { CropTab } from "@/crop/components/crop-tab";
import {
	CircleFadingArrowUpIcon,
	CropIcon,
	DropletIcon,
	ExpandIcon,
	GaugeIcon,
	MusicIcon,
	ShapesIcon,
	SlidersHorizontalIcon,
	TypeIcon,
	WandSparklesIcon,
} from "lucide-react";
import { ElementParamsTab } from "./components/element-params-tab";
import { AudioTab } from "./components/audio-tab";
import {
	ClipEffectsTab,
	StandaloneEffectTab,
} from "@/effects/components/effects-tab";
import { MasksTab } from "@/masks/components/masks-tab";
import { SpeedTab } from "@/speed/components/speed-tab";
import { GraphicTab } from "@/graphics/components/graphic-tab";
import { FadeTab } from "@/fades/components/fade-tab";
import { isFrozenElement } from "@/freeze";

const TRANSFORM_PARAM_KEYS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
] as const;

const TEXT_PARAM_KEYS = [
	"content",
	"fontFamily",
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
] as const;

type TabContentProps = {
	trackId: string;
};

type PropertiesTabDef = {
	id: string;
	label: string;
	icon: ReactNode;
	content: (props: TabContentProps) => ReactNode;
};

export type ElementPropertiesConfig = {
	defaultTab: string;
	tabs: PropertiesTabDef[];
};

function buildTransformTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "transform",
		label: "Transform",
		icon: <ExpandIcon />,
		content: ({ trackId }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={TRANSFORM_PARAM_KEYS}
				sectionKey="transform"
				title="Transform"
			/>
		),
	};
}

function buildCropTab({
	element,
}: {
	element: AdjustableElement;
}): PropertiesTabDef {
	return {
		id: "crop",
		label: "Crop",
		icon: <CropIcon />,
		content: ({ trackId }) => <CropTab element={element} trackId={trackId} />,
	};
}

function buildAdjustTab({
	element,
}: {
	element: AdjustableElement;
}): PropertiesTabDef {
	return {
		id: "adjust",
		label: "Adjust",
		icon: <SlidersHorizontalIcon />,
		content: ({ trackId }) => <AdjustTab element={element} trackId={trackId} />,
	};
}

function buildBlendingTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "blending",
		label: "Blending",
		icon: <DropletIcon />,
		content: ({ trackId }) => (
			<BlendingTab element={element} trackId={trackId} />
		),
	};
}

/**
 * The order the tab rail shows them in, for every element type. Kept in one list
 * rather than per-type arrays so no type can drift into its own ordering.
 */
const TAB_ORDER = [
	"text",
	"graphic",
	"transform",
	"crop",
	"blending",
	"audio",
	"speed",
	"fade",
	"adjust",
	"effects",
	"masks",
];

function orderTabs({ tabs }: { tabs: PropertiesTabDef[] }): PropertiesTabDef[] {
	const rank = ({ id }: PropertiesTabDef) => {
		const index = TAB_ORDER.indexOf(id);
		// An unlisted tab sorts to the end rather than jumping to the front.
		return index === -1 ? TAB_ORDER.length : index;
	};
	return [...tabs].sort((a, b) => rank(a) - rank(b));
}

function buildAudioTab({
	element,
}: {
	element: AudioElement | VideoElement;
}): PropertiesTabDef {
	return {
		id: "audio",
		label: "Audio",
		icon: <MusicIcon />,
		content: ({ trackId }) => <AudioTab element={element} trackId={trackId} />,
	};
}

function buildSpeedTab({
	element,
}: {
	element: RetimableElement;
}): PropertiesTabDef {
	return {
		id: "speed",
		label: "Speed",
		icon: <GaugeIcon />,
		content: ({ trackId }) => <SpeedTab element={element} trackId={trackId} />,
	};
}

function buildMasksTab({
	element,
}: {
	element: MaskableElement;
}): PropertiesTabDef {
	return {
		id: "masks",
		label: "Masks",
		icon: <ShapesIcon />,
		content: ({ trackId }) => <MasksTab element={element} trackId={trackId} />,
	};
}

function buildFadeTab({
	element,
}: {
	element: FadeableElement;
}): PropertiesTabDef {
	return {
		id: "fade",
		label: "Fade",
		icon: <CircleFadingArrowUpIcon />,
		content: ({ trackId }) => <FadeTab element={element} trackId={trackId} />,
	};
}

function buildClipEffectsTab({
	element,
}: {
	element: EffectableElement;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <WandSparklesIcon />,
		content: ({ trackId }) => (
			<ClipEffectsTab element={element} trackId={trackId} />
		),
	};
}

function buildTextTab({ element }: { element: TextElement }): PropertiesTabDef {
	return {
		id: "text",
		label: "Text",
		icon: <TypeIcon />,
		content: ({ trackId }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={TEXT_PARAM_KEYS}
				sectionKey="text"
				title="Text"
			/>
		),
	};
}

function buildGraphicTab({
	element,
}: {
	element: GraphicElement;
}): PropertiesTabDef {
	return {
		id: "graphic",
		label: "Graphic",
		icon: <ShapesIcon />,
		content: ({ trackId }) => (
			<GraphicTab element={element} trackId={trackId} />
		),
	};
}

function buildStandaloneEffectTab({
	element,
}: {
	element: EffectElement;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <WandSparklesIcon />,
		content: ({ trackId }) => (
			<StandaloneEffectTab element={element} trackId={trackId} />
		),
	};
}

function getTextConfig({
	element,
}: {
	element: TextElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "text",
		tabs: [
			buildTextTab({ element }),
			buildTransformTab({ element }),
			buildBlendingTab({ element }),
			buildFadeTab({ element }),
		],
	};
}

function getVideoConfig({
	element,
	mediaAsset,
}: {
	element: VideoElement;
	mediaAsset: MediaAsset | undefined;
}): ElementPropertiesConfig {
	// A held still has one frame and no sound: there is nothing for the speed
	// control to stretch and nothing for the volume control to fade.
	const isFrozen = isFrozenElement({ element });
	const showAudioTab = mediaAsset?.hasAudio !== false && !isFrozen;
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ element }),
			buildCropTab({ element }),
			...(showAudioTab ? [buildAudioTab({ element })] : []),
			...(isFrozen ? [] : [buildSpeedTab({ element })]),
			buildAdjustTab({ element }),
			buildMasksTab({ element }),
			buildClipEffectsTab({ element }),
			buildFadeTab({ element }),
		],
	};
}

function getImageConfig({
	element,
}: {
	element: ImageElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ element }),
			buildCropTab({ element }),
			buildAdjustTab({ element }),
			buildMasksTab({ element }),
			buildClipEffectsTab({ element }),
			buildFadeTab({ element }),
		],
	};
}

function getStickerConfig({
	element,
}: {
	element: StickerElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ element }),
			buildBlendingTab({ element }),
			buildClipEffectsTab({ element }),
		],
	};
}

function getGraphicConfig({
	element,
}: {
	element: GraphicElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "graphic",
		tabs: [
			buildGraphicTab({ element }),
			buildTransformTab({ element }),
			buildBlendingTab({ element }),
			buildMasksTab({ element }),
			buildClipEffectsTab({ element }),
		],
	};
}

function getAudioConfig({
	element,
}: {
	element: AudioElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "audio",
		tabs: [buildAudioTab({ element }), buildSpeedTab({ element })],
	};
}

function getEffectConfig({
	element,
}: {
	element: EffectElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "effects",
		tabs: [buildStandaloneEffectTab({ element })],
	};
}

export function getPropertiesConfig({
	element,
	mediaAssets,
}: {
	element: TimelineElement;
	mediaAssets: MediaAsset[];
}): ElementPropertiesConfig {
	const config = getConfigForElement({ element, mediaAssets });
	return { ...config, tabs: orderTabs({ tabs: config.tabs }) };
}

function getConfigForElement({
	element,
	mediaAssets,
}: {
	element: TimelineElement;
	mediaAssets: MediaAsset[];
}): ElementPropertiesConfig {
	switch (element.type) {
		case "text":
			return getTextConfig({ element });
		case "video": {
			const mediaAsset = mediaAssets.find((a) => a.id === element.mediaId);
			return getVideoConfig({ element, mediaAsset });
		}
		case "image":
			return getImageConfig({ element });
		case "sticker":
			return getStickerConfig({ element });
		case "graphic":
			return getGraphicConfig({ element });
		case "audio":
			return getAudioConfig({ element });
		case "effect":
			return getEffectConfig({ element });
		case "adjustment":
			// Adjustment elements have no editable properties yet, so there is no tab
			// to show. The panel renders nothing when the tab list is empty.
			return { defaultTab: "adjustments", tabs: [] };
	}
}
