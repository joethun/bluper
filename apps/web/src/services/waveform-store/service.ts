"use client";

import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import type { SourceWaveformSummary } from "@/media/waveform-summary";

/**
 * Waveform summaries kept between sessions.
 *
 * Reading a source is the expensive part and its answer never changes: media is
 * stored under an id that is minted per import, so a given id is always the
 * same bytes. Measured on a real project — two clips, 142 minutes of audio —
 * summarising from scratch takes about six seconds, and reopening the project
 * did all six again. Kept on disk it costs a read.
 *
 * Its own database rather than a store inside the media one: adding a store to
 * an existing database needs a version bump and an upgrade path, and nothing
 * here is worth migrating — a summary that cannot be read is simply rebuilt.
 */
const WAVEFORM_DB = "video-editor-waveforms";
const WAVEFORM_STORE = "waveforms";

/**
 * How much of a source's peaks may sit on disk before the oldest are dropped.
 *
 * A summary is one byte per bucket, so an hour of audio at the default bucket
 * size is about 1.4MB. This holds a few dozen hours of material, and the cost
 * of being wrong is a rebuild rather than a loss.
 */
const MAX_STORED_BYTES = 64 * 1024 * 1024;

/**
 * Peaks are stored as bytes, not floats.
 *
 * A waveform is drawn as bars a few dozen pixels tall, so a float per bucket is
 * three bytes of precision nobody can see — and the summary is the thing being
 * written, so its size is the whole cost. Companded through a square root
 * rather than stored linearly, which spends the 256 levels where the eye is:
 * quiet passages get fine steps and loud ones coarse, instead of the other way
 * round.
 *
 * `scale` carries the loudest peak so a source that clips above 1.0 comes back
 * above 1.0 — the timeline paints those bars in a different colour, and
 * clamping here would quietly lose that.
 */
function quantise({ amplitudes }: { amplitudes: Float32Array }): {
	bytes: Uint8Array;
	scale: number;
} {
	let scale = 0;
	for (let i = 0; i < amplitudes.length; i++) {
		if (amplitudes[i] > scale) scale = amplitudes[i];
	}
	const bytes = new Uint8Array(amplitudes.length);
	if (scale <= 0) return { bytes, scale: 1 };

	for (let i = 0; i < amplitudes.length; i++) {
		bytes[i] = Math.round(Math.sqrt(amplitudes[i] / scale) * 255);
	}
	return { bytes, scale };
}

function expand({
	bytes,
	scale,
}: {
	bytes: Uint8Array;
	scale: number;
}): Float32Array {
	const amplitudes = new Float32Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		const unit = bytes[i] / 255;
		amplitudes[i] = unit * unit * scale;
	}
	return amplitudes;
}

interface StoredMeta {
	kind: "meta";
	savedAt: number;
	bytes: number;
	sampleRate: number;
	totalSamples: number;
	bucketSize: number;
	scale: number;
}

interface StoredData {
	kind: "data";
	amplitudes: ArrayBuffer;
}

type WaveformRecord = StoredMeta | StoredData;

/**
 * Split in two so pruning can read what it needs without loading what it is
 * deciding about: the meta record is a few numbers, the data record is the
 * whole summary.
 */
function metaKey({ sourceKey, bucketSize }: WaveformKey): string {
	return `meta:${bucketSize}:${sourceKey}`;
}

function dataKey({ sourceKey, bucketSize }: WaveformKey): string {
	return `data:${bucketSize}:${sourceKey}`;
}

interface WaveformKey {
	sourceKey: string;
	bucketSize: number;
}

let adapter: IndexedDBAdapter<WaveformRecord> | null = null;

function getAdapter(): IndexedDBAdapter<WaveformRecord> {
	adapter ??= new IndexedDBAdapter<WaveformRecord>({
		dbName: WAVEFORM_DB,
		storeName: WAVEFORM_STORE,
	});
	return adapter;
}

/**
 * The summary for a source, or null when it has not been stored, cannot be
 * read, or was stored at a different bucket size.
 *
 * Never throws: every caller's fallback is to build the summary, which is what
 * it would do anyway.
 */
export async function loadStoredWaveform({
	sourceKey,
	bucketSize,
}: WaveformKey): Promise<SourceWaveformSummary | null> {
	try {
		const store = getAdapter();
		const meta = await store.get(metaKey({ sourceKey, bucketSize }));
		if (!meta || meta.kind !== "meta") return null;

		const data = await store.get(dataKey({ sourceKey, bucketSize }));
		if (!data || data.kind !== "data") return null;

		return {
			sourceKey,
			sampleRate: meta.sampleRate,
			totalSamples: meta.totalSamples,
			bucketSize: meta.bucketSize,
			amplitudes: expand({
				bytes: new Uint8Array(data.amplitudes),
				scale: meta.scale,
			}),
			// Whole from the first paint, so there is no partial version of it for
			// a consumer to tell apart.
			revision: 1,
		};
	} catch {
		return null;
	}
}

/**
 * Writes a finished summary. Never throws: failing to cache is not a reason to
 * fail the thing being cached.
 */
export async function storeWaveform({
	summary,
}: {
	summary: SourceWaveformSummary;
}): Promise<void> {
	try {
		const store = getAdapter();
		const { bytes, scale } = quantise({ amplitudes: summary.amplitudes });
		const key = {
			sourceKey: summary.sourceKey,
			bucketSize: summary.bucketSize,
		};

		await store.set({
			key: dataKey(key),
			value: {
				kind: "data",
				// A view's buffer can be longer than the view; copy so what is
				// written is exactly what was measured.
				amplitudes: bytes.slice().buffer,
			},
		});
		await store.set({
			key: metaKey(key),
			value: {
				kind: "meta",
				savedAt: Date.now(),
				bytes: bytes.length,
				sampleRate: summary.sampleRate,
				totalSamples: summary.totalSamples,
				bucketSize: summary.bucketSize,
				scale,
			},
		});

		await pruneToBudget();
	} catch {
		// A summary that could not be stored is rebuilt next time.
	}
}

/** Drops one source's stored peaks, at every bucket size it was stored at. */
export async function forgetStoredWaveform({
	sourceKey,
}: {
	sourceKey: string;
}): Promise<void> {
	try {
		const store = getAdapter();
		const keys = await store.list();
		const suffix = `:${sourceKey}`;
		await Promise.all(
			keys
				.filter((key) => key.endsWith(suffix))
				.map((key) => store.remove(key)),
		);
	} catch {
		// Leaving a stale summary behind is harmless: its source is gone, so
		// nothing will ask for it.
	}
}

/**
 * Drops the least recently written summaries until the store is inside its
 * budget. Reads only the meta records, so deciding what to drop does not load
 * what it is deciding about.
 */
async function pruneToBudget(): Promise<void> {
	const store = getAdapter();
	const keys = await store.list();
	const metas = await Promise.all(
		keys
			.filter((key) => key.startsWith("meta:"))
			.map(async (key) => {
				const record = await store.get(key);
				return record && record.kind === "meta"
					? { key, meta: record }
					: null;
			}),
	);

	const present = metas
		.filter((entry): entry is { key: string; meta: StoredMeta } => entry !== null)
		.sort((a, b) => b.meta.savedAt - a.meta.savedAt);

	let kept = 0;
	for (const { key, meta } of present) {
		kept += meta.bytes;
		if (kept <= MAX_STORED_BYTES) continue;
		await store.remove(key);
		await store.remove(`data:${key.slice("meta:".length)}`);
	}
}
