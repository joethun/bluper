import type { EditorCore } from "@/core";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import type { SceneTracks } from "@/timeline/types";
import {
	findTransitions,
	getActiveTransitionBinding,
	getTransitionBindingsForElement,
} from "@/transitions";
import type { MediaTime } from "@/wasm";

/**
 * Whether the frame at `freezeTime` is a transition rather than a single clip. A
 * still is normally a live re-sample of one clip's source frame, which cannot
 * stand in for a moment when the picture is two clips blended together.
 *
 * Restricted to the main track on purpose: the bake includes the project
 * background so the still matches the screen, and an opaque still like that would
 * hide everything beneath it on an overlay track.
 */
function needsBakedStill({
	editor,
	trackId,
	elementId,
	freezeTime,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	freezeTime: MediaTime;
}): boolean {
	const tracks = editor.scenes.getActiveScene().tracks;
	if (tracks.main.id !== trackId) {
		return false;
	}

	const bindings = getTransitionBindingsForElement({
		placements: findTransitions({ track: tracks.main }),
		elementId,
	});
	return getActiveTransitionBinding({ bindings, time: freezeTime }) !== null;
}

/**
 * Renders the blended frame at `freezeTime` and stores it as an image, returning
 * the new asset's id. The asset is marked ephemeral: it backs one clip rather
 * than being something the user imported, so it stays out of the media panel.
 *
 * Returns `null` when the frame could not be produced, which leaves the caller
 * to fall back to an ordinary source-frame hold.
 */
export async function bakeTransitionStill({
	editor,
	trackId,
	elementId,
	freezeTime,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	freezeTime: MediaTime;
}): Promise<string | null> {
	if (!needsBakedStill({ editor, trackId, elementId, freezeTime })) {
		return null;
	}

	const project = editor.project.getActiveOrNull();
	if (!project) {
		return null;
	}

	const tracks = editor.scenes.getActiveScene().tracks;
	const { canvasSize, background, fps } = project.settings;

	// Only the track being frozen: anything above it keeps rendering live, so
	// baking it here would double it up.
	const isolated: SceneTracks = {
		overlay: [],
		main: tracks.main,
		audio: [],
	};

	try {
		const scene = buildScene({
			tracks: isolated,
			mediaAssets: editor.media.getAssets(),
			duration: editor.timeline.getTotalDuration() || 1,
			canvasSize,
			background,
		});

		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps,
		});
		const canvas = document.createElement("canvas");
		canvas.width = canvasSize.width;
		canvas.height = canvasSize.height;

		await renderer.renderToCanvas({
			node: scene,
			time: freezeTime,
			targetCanvas: canvas,
		});

		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((result) => resolve(result), "image/png");
		});
		if (!blob) {
			return null;
		}

		const file = new File([blob], "frozen-frame.png", { type: "image/png" });
		const asset = await editor.media.addMediaAsset({
			projectId: project.metadata.id,
			asset: {
				name: "Frozen frame",
				type: "image",
				file,
				url: URL.createObjectURL(file),
				width: canvasSize.width,
				height: canvasSize.height,
				ephemeral: true,
			},
		});

		return asset?.id ?? null;
	} catch (error) {
		console.error("Failed to bake a still for the transition frame:", error);
		return null;
	}
}
