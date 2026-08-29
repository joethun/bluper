import { useEditor } from "@/editor/use-editor";
import type { SceneTracks } from "@/timeline/types";

/**
 * Whether the active scene contains any element that paints pixels of its own
 * — a video or an image. Text, audio, graphics, effects and adjustments don't
 * count: they all need something underneath to be visible, and the preview
 * surfaces that show this flag use it to decide whether to draw at all.
 */
export function useTimelineHasMedia(): boolean {
	return useEditor((editor) => {
		const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!tracks) {
			return false;
		}
		return sceneHasMedia({ tracks });
	});
}

export function sceneHasMedia({ tracks }: { tracks: SceneTracks }): boolean {
	if (tracks.main.elements.length > 0) {
		return true;
	}
	return tracks.overlay.some(
		(track) => track.type === "video" && track.elements.length > 0,
	);
}