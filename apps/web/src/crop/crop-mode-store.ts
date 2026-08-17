import { create } from "zustand";
import type { ElementRef } from "@/timeline/types";

/**
 * Which clip, if any, the preview is currently cropping.
 *
 * Crop editing is a mode rather than a panel state: while it is on, the clip is
 * drawn *uncropped* so the trimmed edges are still visible to drag back, and the
 * overlay dims them instead of the renderer removing them. Nothing else in the
 * editor may be in a mode at the same time, so this holds one element at most.
 */
interface CropModeState {
	croppingElement: ElementRef | null;
	enterCropMode: ({ element }: { element: ElementRef }) => void;
	exitCropMode: () => void;
	toggleCropMode: ({ element }: { element: ElementRef }) => void;
}

function isSameElement({
	left,
	right,
}: {
	left: ElementRef | null;
	right: ElementRef;
}): boolean {
	return (
		left !== null &&
		left.trackId === right.trackId &&
		left.elementId === right.elementId
	);
}

export const useCropModeStore = create<CropModeState>()((set) => ({
	croppingElement: null,
	enterCropMode: ({ element }) => {
		set({ croppingElement: element });
	},
	exitCropMode: () => {
		set({ croppingElement: null });
	},
	toggleCropMode: ({ element }) => {
		set((state) => ({
			croppingElement: isSameElement({ left: state.croppingElement, right: element })
				? null
				: element,
		}));
	},
}));
