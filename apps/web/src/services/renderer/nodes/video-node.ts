import type { FreezeConfig } from "@/timeline";
import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
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

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVisualSourceNodeState
> {}
