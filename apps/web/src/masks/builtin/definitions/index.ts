import {
	masksRegistry,
	type MaskDefinitionForRegistration,
} from "../../registry";
import { cinematicBarsMaskDefinition } from "./cinematic-bars";
import { diamondMaskDefinition } from "./diamond";
import { ellipseMaskDefinition } from "./ellipse";
import { heartMaskDefinition } from "./heart";
import { rectangleMaskDefinition } from "./rectangle";
import { splitMaskDefinition } from "./split";
import { starMaskDefinition } from "./star";
import { textMaskDefinition } from "./text";
import { freeformMaskDefinition } from "../../freeform/definition";
import {
	CircleIcon,
	DiamondIcon,
	HeartIcon,
	type LucideIcon,
	MinusIcon,
	PanelRightIcon,
	PenToolIcon,
	SparklesIcon,
	SquareIcon,
	TypeIcon,
} from "lucide-react";

function registerDefaultMask({
	definition,
	icon,
}: {
	definition: MaskDefinitionForRegistration;
	icon: LucideIcon;
}) {
	if (masksRegistry.has(definition.type)) {
		return;
	}

	masksRegistry.registerMask({ definition, icon });
}

export function registerDefaultMasks(): void {
	registerDefaultMask({
		definition: splitMaskDefinition,
		icon: PanelRightIcon,
	});
	registerDefaultMask({
		definition: cinematicBarsMaskDefinition,
		icon: MinusIcon,
	});
	registerDefaultMask({
		definition: rectangleMaskDefinition,
		icon: SquareIcon,
	});
	registerDefaultMask({
		definition: ellipseMaskDefinition,
		icon: CircleIcon,
	});
	registerDefaultMask({
		definition: heartMaskDefinition,
		icon: HeartIcon,
	});
	registerDefaultMask({
		definition: diamondMaskDefinition,
		icon: DiamondIcon,
	});
	registerDefaultMask({
		definition: starMaskDefinition,
		icon: SparklesIcon,
	});
	registerDefaultMask({
		definition: textMaskDefinition,
		icon: TypeIcon,
	});
	registerDefaultMask({
		definition: freeformMaskDefinition,
		icon: PenToolIcon,
	});
}
