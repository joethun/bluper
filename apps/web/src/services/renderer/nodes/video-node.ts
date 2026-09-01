import type { VideoSample } from "@/media/video-sample";
import type { MediaSourceRef } from "@/media/source";
import type { FreezeConfig } from "@/timeline";
import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	/** Where the clip's bytes are read from; see {@link MediaSourceRef}. */
	source: MediaSourceRef;
	mediaId: string;
	/**
	 * Which decoder this clip samples from. Set only when it needs a decode
	 * position of its own: during a transition between two clips of the same file,
	 * each side needs a different frame at the same moment. Left unset, clips
	 * share one decoder per asset.
	 */
	sinkKey?: string;
	/** Set when the clip is a held still; pins the frame this node samples. */
	freeze?: FreezeConfig;
}

export interface ResolvedVideoNodeState extends ResolvedVisualSourceNodeState {
	/**
	 * The decoded sample {@link ResolvedVisualSourceNodeState.source} was cloned
	 * from, so the next resolve can tell whether the picture actually changed.
	 *
	 * A decoder hands the same sample back for as many rendered frames as it is
	 * current for — every project frame of a 24fps clip on a 30fps timeline, a
	 * whole second of a freeze, every frame of a clip slowed below 1x — and
	 * cloning it again each time produces a `VideoFrame` the texture caches have
	 * never seen, because both of them compare by object identity. That turned a
	 * picture nothing had changed into a fresh `getImageData` readback and a
	 * fresh GPU upload, per layer, per frame. Holding the sample lets the clone
	 * be reused for as long as it is still the frame on screen.
	 *
	 * Owned by the video cache, not by the node: it may be closed as soon as the
	 * decoder moves on, so nothing here may read pixels out of it. It is an
	 * identity, and is only ever compared.
	 */
	sample: VideoSample;
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVideoNodeState
> {}
