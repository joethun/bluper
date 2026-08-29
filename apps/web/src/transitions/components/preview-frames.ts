"use client";

import { useEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { tauriAvailable, tauriMediaThumbnail } from "@/lib/tauri-runtime";
import type { MediaAsset } from "@/media/types";

/**
 * Where in the clip the two stills are taken from, as a fraction of its length.
 * Far enough apart that a slow pan or a lighting change has moved between them
 * — two adjacent frames would make a wipe look like nothing happening — and
 * both inside the body of the shot, off the fade most clips open and close on.
 */
const OUTGOING_AT = 0.25;
const INCOMING_AT = 0.7;

/** Never seek to the very last frame; a container's own duration can overshoot. */
const END_MARGIN_SECONDS = 0.05;

/**
 * Bounds the longer edge. The tiles are ~84 CSS px and the drag ghost is 80, so
 * this covers a 3x display with room to spare and still crosses the IPC boundary
 * as a few kilobytes of PNG.
 */
const MAX_EDGE = 256;

/** The two stills a transition tile blends between. */
export interface TransitionPreviewFrames {
	outgoing: HTMLImageElement;
	incoming: HTMLImageElement;
}

/**
 * Decoded frames, keyed by the asset they came from. Two dozen tiles ask for the
 * same pair at once and the panel is re-mounted every time its tab is switched
 * back to, so the promise is cached rather than the result: the second asker
 * joins the first one's decode instead of starting another.
 */
const framesByAssetId = new Map<
	string,
	Promise<TransitionPreviewFrames | null>
>();

function loadImage({ src }: { src: string }): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => resolve(null);
		image.src = src;
	});
}

/**
 * Two real frames out of one clip, decoded in the shell.
 *
 * Returns null wherever the pair cannot be had — in the browser build, which has
 * no decoder for arbitrary containers, for an asset whose file has gone missing,
 * or for a clip too short to have two distinct points in it. The tiles fall back
 * to their drawn stand-ins in that case.
 */
async function grabFrames({
	asset,
}: {
	asset: MediaAsset;
}): Promise<TransitionPreviewFrames | null> {
	const path = asset.path;
	const duration = asset.duration ?? 0;
	if (!path || duration <= 0) {
		return null;
	}

	const latest = Math.max(0, duration - END_MARGIN_SECONDS);
	const decodeAt = ({ fraction }: { fraction: number }) =>
		tauriMediaThumbnail({
			path,
			atSeconds: Math.min(duration * fraction, latest),
			maxEdge: MAX_EDGE,
		}).catch(() => null);

	const [outgoingSource, incomingSource] = await Promise.all([
		decodeAt({ fraction: OUTGOING_AT }),
		decodeAt({ fraction: INCOMING_AT }),
	]);
	if (!outgoingSource || !incomingSource) {
		return null;
	}

	const [outgoing, incoming] = await Promise.all([
		loadImage({ src: outgoingSource }),
		loadImage({ src: incomingSource }),
	]);
	return outgoing && incoming ? { outgoing, incoming } : null;
}

function framesForAsset({
	asset,
}: {
	asset: MediaAsset;
}): Promise<TransitionPreviewFrames | null> {
	const cached = framesByAssetId.get(asset.id);
	if (cached) {
		return cached;
	}

	const pending = grabFrames({ asset }).catch(() => null);
	framesByAssetId.set(asset.id, pending);
	return pending;
}

/**
 * The clip the tiles preview against: whichever video is selected, so the panel
 * shows the footage being worked on, and otherwise the first video in the
 * project. An asset whose file is missing is skipped — its frames are gone even
 * though its metadata is not.
 */
function usePreviewSourceAsset(): MediaAsset | null {
	return useEditor((editor) => {
		const usable = editor.media
			.getAssets()
			.filter(
				(asset) =>
					asset.type === "video" &&
					!asset.ephemeral &&
					!asset.missing &&
					Boolean(asset.path),
			);
		if (usable.length === 0) {
			return null;
		}

		const selectedMediaIds = new Set(
			editor.selection
				.getSelectedElements()
				.map((element) => ("mediaId" in element ? element.mediaId : null))
				.filter((mediaId): mediaId is string => Boolean(mediaId)),
		);

		return (
			usable.find((asset) => selectedMediaIds.has(asset.id)) ?? usable[0] ?? null
		);
	});
}

export function useTransitionPreviewFrames(): TransitionPreviewFrames | null {
	const asset = usePreviewSourceAsset();
	const [frames, setFrames] = useState<TransitionPreviewFrames | null>(null);

	useEffect(() => {
		let isCurrent = true;
		// Clearing goes through the same resolution rather than being set here, so
		// the tiles keep the stills they have until the replacements are decoded
		// instead of blinking back to the stand-ins in between.
		const pending =
			asset && tauriAvailable()
				? framesForAsset({ asset })
				: Promise.resolve(null);

		void pending.then((result) => {
			if (isCurrent) {
				setFrames(result);
			}
		});
		return () => {
			isCurrent = false;
		};
	}, [asset]);

	return frames;
}
