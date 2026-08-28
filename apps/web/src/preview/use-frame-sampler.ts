import { useCallback } from "react";
import { useEditor } from "@/editor/use-editor";

/**
 * Hands a colour control a picture of the frame on the playhead to sample out
 * of, so the eyedropper the chroma key's colour has is available to every colour
 * in the editor.
 *
 * The composited frame is the right source for a general colour pick — it is
 * what the user is looking at when they decide "that one" — and it is available
 * for text, shapes, mask strokes and bookmarks alike, none of which have a
 * source still of their own. A chroma key stays on its clip's untouched
 * thumbnail instead: the green it needs is the green as shot, not the green the
 * key has already started removing.
 */
export function useFrameSampler(): () => Promise<string | null> {
	const editor = useEditor();
	return useCallback(() => editor.renderer.captureFrameImageUrl(), [editor]);
}
