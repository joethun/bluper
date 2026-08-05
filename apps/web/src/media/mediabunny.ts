import {
	Input,
	ALL_FORMATS,
	BlobSource,
	VideoSampleSink,
	type VideoCodec,
} from "mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";

export type VideoFileData = {
	duration: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
	codec: VideoCodec | null;
	canDecode: boolean;
	thumbnailUrl: string | null;
};

export async function readVideoFile({
	file,
}: {
	file: File;
}): Promise<VideoFileData> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const duration = await input.computeDuration();
		const videoTrack = await input.getPrimaryVideoTrack();

		if (!videoTrack) {
			throw new Error("No video track found in the file");
		}

		const canDecode = await videoTrack.canDecode();
		const packetStats = await videoTrack.computePacketStats(100);
		const audioTrack = await input.getPrimaryAudioTrack();

		let thumbnailUrl: string | null = null;
		if (canDecode) {
			const sink = new VideoSampleSink(videoTrack);
			const frame = await sink.getSample(1);
			if (frame) {
				try {
					thumbnailUrl = renderThumbnailDataUrl({
						width: videoTrack.displayWidth,
						height: videoTrack.displayHeight,
						draw: ({ context, width, height }) => {
							frame.draw(context, 0, 0, width, height);
						},
					});
				} finally {
					frame.close();
				}
			}
		}

		return {
			duration,
			width: videoTrack.displayWidth,
			height: videoTrack.displayHeight,
			fps: packetStats.averagePacketRate,
			hasAudio: audioTrack !== null,
			codec: videoTrack.codec,
			canDecode,
			thumbnailUrl,
		};
	} finally {
		input.dispose();
	}
}
