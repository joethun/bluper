import type { TransitionCategory } from "@/transitions/types";

export const TRANSITION_CATEGORY_LABELS: Record<TransitionCategory, string> = {
	basic: "Basic",
	wipe: "Wipes",
	motion: "Motion",
	camera: "Camera",
};

/** The order the categories are offered in, coarsest effect last. */
export const TRANSITION_CATEGORY_ORDER: TransitionCategory[] = [
	"basic",
	"wipe",
	"motion",
	"camera",
];
