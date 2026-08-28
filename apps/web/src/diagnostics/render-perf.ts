/**
 * Lightweight rolling perf instrumentation for the render pipeline.
 *
 * Toggle at runtime from the devtools console:
 *   window.__renderPerf = true
 *
 * Every FLUSH_EVERY frames the aggregator dumps to the console:
 *   - per-span timing summary (count / mean / p50 / p95 / max, in ms)
 *   - per-counter totals (uploads, canvas allocations by kind, etc.)
 *
 * Or ask for what has been collected so far, without waiting for the cadence
 * and without having to read it out of a `console.table`:
 *   window.__renderPerfSnapshot()          // read and clear
 *   window.__renderPerfSnapshot(false)     // read and keep collecting
 *
 * That is the only way to get the numbers off a machine where the console is
 * not to hand — a self-check run, or the shell driven from a terminal — and the
 * only way to profile a phase shorter than FLUSH_EVERY frames, which a scrub or
 * a single seek usually is.
 *
 * Zero overhead when disabled: `isRenderPerfEnabled()` short-circuits before
 * any recording happens, so call sites only pay for a global read.
 */

type SpanSample = number;

type SpanStats = {
	samples: SpanSample[];
};

type CounterStats = {
	total: number;
	frames: number;
};

const FLUSH_EVERY = 60;

const spans = new Map<string, SpanStats>();
const counters = new Map<string, CounterStats>();
const pendingCountersThisFrame = new Map<string, number>();

let framesSinceFlush = 0;

/**
 * One span's or counter's aggregate, as [`renderPerfSnapshot`] reports it.
 *
 * Deliberately not exported: nothing imports it, and a diagnostics shape that
 * only this module and the console produce should not become an API by accident.
 */
type RenderPerfSummary = {
	frames: number;
	spans: Array<{
		span: string;
		count: number;
		meanMs: number;
		p50Ms: number;
		p95Ms: number;
		maxMs: number;
	}>;
	counters: Array<{
		counter: string;
		perFrame: number;
		total: number;
		frames: number;
	}>;
};

declare global {
	interface Window {
		__renderPerf?: boolean;
		__renderPerfSnapshot?: (clear?: boolean) => RenderPerfSummary;
	}
}

export function isRenderPerfEnabled(): boolean {
	return typeof window !== "undefined" && window.__renderPerf === true;
}

function recordSpan({
	name,
	durationMs,
}: {
	name: string;
	durationMs: number;
}): void {
	if (!isRenderPerfEnabled()) return;
	let stats = spans.get(name);
	if (!stats) {
		stats = { samples: [] };
		spans.set(name, stats);
	}
	stats.samples.push(durationMs);
}

export async function measureSpanAsync<T>({
	name,
	fn,
}: {
	name: string;
	fn: () => Promise<T>;
}): Promise<T> {
	if (!isRenderPerfEnabled()) return fn();
	const start = performance.now();
	try {
		return await fn();
	} finally {
		recordSpan({ name, durationMs: performance.now() - start });
	}
}

export function measureSpanSync<T>({
	name,
	fn,
}: {
	name: string;
	fn: () => T;
}): T {
	if (!isRenderPerfEnabled()) return fn();
	const start = performance.now();
	try {
		return fn();
	} finally {
		recordSpan({ name, durationMs: performance.now() - start });
	}
}

export function incrementCounter({
	name,
	by = 1,
}: {
	name: string;
	by?: number;
}): void {
	if (!isRenderPerfEnabled()) return;
	pendingCountersThisFrame.set(
		name,
		(pendingCountersThisFrame.get(name) ?? 0) + by,
	);
}

/**
 * Pulls sub-span timings recorded inside the wasm `renderFrame` call and
 * feeds them into the aggregator as ordinary spans.
 */
export function recordWasmFrameProfile(
	entries: Array<{ name: string; durationMs: number }>,
): void {
	if (!isRenderPerfEnabled()) return;
	for (const entry of entries) {
		recordSpan({ name: entry.name, durationMs: entry.durationMs });
	}
}

/**
 * Called once per frame by the top of the render pipeline. Rolls the
 * pending-frame counters into the aggregate and triggers a flush on cadence.
 */
export function onRenderPerfFrameComplete(): void {
	if (!isRenderPerfEnabled()) return;
	for (const [name, count] of pendingCountersThisFrame) {
		let stats = counters.get(name);
		if (!stats) {
			stats = { total: 0, frames: 0 };
			counters.set(name, stats);
		}
		stats.total += count;
		stats.frames += 1;
	}
	pendingCountersThisFrame.clear();

	framesSinceFlush += 1;
	if (framesSinceFlush >= FLUSH_EVERY) {
		flush();
	}
}

/**
 * What has been collected since the last reset, ordered slowest span first.
 *
 * Clears by default, so repeated calls report disjoint windows rather than an
 * ever-growing average — pass `false` to peek without disturbing the run.
 *
 * Reached as `window.__renderPerfSnapshot()` rather than by import: the callers
 * are a console and a script driving the shell, neither of which can import.
 */
function renderPerfSnapshot(clear = true): RenderPerfSummary {
	const spanRows: RenderPerfSummary["spans"] = [];
	for (const [name, stats] of spans) {
		if (stats.samples.length === 0) continue;
		const sorted = [...stats.samples].sort((a, b) => a - b);
		const at = (quantile: number) =>
			sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
		const sum = sorted.reduce((acc, value) => acc + value, 0);
		spanRows.push({
			span: name,
			count: sorted.length,
			meanMs: +(sum / sorted.length).toFixed(2),
			p50Ms: +at(0.5).toFixed(2),
			p95Ms: +at(0.95).toFixed(2),
			maxMs: +sorted[sorted.length - 1]!.toFixed(2),
		});
	}
	spanRows.sort((a, b) => b.meanMs - a.meanMs);

	const counterRows: RenderPerfSummary["counters"] = [];
	for (const [name, stats] of counters) {
		counterRows.push({
			counter: name,
			perFrame: +(stats.total / Math.max(1, stats.frames)).toFixed(2),
			total: stats.total,
			frames: stats.frames,
		});
	}
	counterRows.sort((a, b) => b.perFrame - a.perFrame);

	const summary: RenderPerfSummary = {
		frames: framesSinceFlush,
		spans: spanRows,
		counters: counterRows,
	};

	if (clear) {
		spans.clear();
		counters.clear();
		framesSinceFlush = 0;
	}
	return summary;
}

function flush(): void {
	const { frames, spans: spanRows, counters: counterRows } = renderPerfSnapshot();

	console.groupCollapsed(`[render-perf] summary over ${frames} frames`);
	if (spanRows.length > 0) console.table(spanRows);
	if (counterRows.length > 0) console.table(counterRows);
	console.groupEnd();
}

// Reachable from the console and from a script driving the shell, which is the
// only way to read these numbers on a machine with no devtools to hand.
if (typeof window !== "undefined") {
	window.__renderPerfSnapshot = (clear?: boolean) =>
		renderPerfSnapshot(clear ?? true);
}
