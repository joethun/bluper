"use client";

import {
	buildSourceWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import { decodeAudioBufferFromRef } from "@/media/decode-audio";

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

/**
 * Decode a source to summarise it. Shared with playback and export so a file
 * that one of them can read is never silently missing its waveform — see
 * {@link decodeAudioBufferFromRef} for why reading it can take two attempts.
 */
async function decodeAudioBuffer({
	sourceFile,
	audioUrl,
}: {
	sourceFile?: File;
	audioUrl?: string;
}): Promise<AudioBuffer> {
	const buffer = await decodeAudioBufferFromRef({
		ref: sourceFile
			? { kind: "blob", blob: sourceFile }
			: { kind: "url", url: audioUrl ?? "" },
	});

	if (!buffer) {
		throw new Error("Could not decode audio source");
	}

	return buffer;
}

class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.buildSummary({
			sourceKey,
			audioBuffer,
			sourceFile,
			audioUrl,
		}).catch((error) => {
			this.summaries.delete(sourceKey);
			throw error;
		});

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		if (!sourceFile && !audioUrl) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		const buffer = await decodeAudioBuffer({ sourceFile, audioUrl });
		return buildSourceWaveformSummary({ sourceKey, buffer });
	}
}

export const waveformCache = new WaveformCache();
