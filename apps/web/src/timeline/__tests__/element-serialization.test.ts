import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

// `@/wasm` initialises the bundler-target build on import, which cannot run
// under `bun test`. Swapping the raw package for the nodejs-target build of the
// same crate lets the real façade — brands, invariant checks and all — load and
// run against real Rust, rather than stubbing it out.
mock.module("bluper-wasm", () => wasmNative);

const { buildElementFromMedia } = await import("@/timeline/element-utils");
// The real branded constructor — a bare number is not a `MediaTime`.
const { mediaTime } = await import("@/wasm");

/**
 * The document has to be plain data. `AudioElement` used to carry a live
 * `AudioBuffer`, which JSON cannot represent — and because `SerializedScene`
 * embeds `SceneTracks` verbatim, the persisted type declared a field the writer
 * had to strip back out on the way to IndexedDB.
 *
 * These guard the invariant that replaced that arrangement: an element is
 * JSON-round-trippable as built, with nothing to strip.
 */

/** A value is plain if it is a primitive, a plain object, or an array of them. */
function findNonPlainValue({
	value,
	path,
}: {
	value: unknown;
	path: string;
}): string | null {
	if (value === null || typeof value !== "object") return null;

	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = findNonPlainValue({
				value: item,
				path: `${path}[${index}]`,
			});
			if (found) return found;
		}
		return null;
	}

	if (Object.getPrototypeOf(value) !== Object.prototype) {
		return `${path} is a ${value.constructor?.name ?? "class"} instance`;
	}

	for (const [key, nested] of Object.entries(value)) {
		const found = findNonPlainValue({ value: nested, path: `${path}.${key}` });
		if (found) return found;
	}
	return null;
}

test("the plainness check actually catches a live handle", () => {
	// Without this, the assertions below could pass by never looking at anything.
	// `Date` stands in for `AudioBuffer`/`File`/`VideoFrame`: a class instance,
	// which is exactly what must not appear in the document.
	expect(
		findNonPlainValue({ value: { audio: { buffer: new Date() } }, path: "el" }),
	).toBe("el.audio.buffer is a Date instance");
	expect(findNonPlainValue({ value: { a: [1, { b: "c" }] }, path: "el" })).toBe(
		null,
	);
});

test("a built audio element survives a JSON round trip unchanged", () => {
	const element = buildElementFromMedia({
		mediaId: "media-1",
		mediaType: "audio",
		name: "take-1.wav",
		duration: mediaTime({ ticks: 120_000 }),
		startTime: mediaTime({ ticks: 0 }),
	});

	expect(JSON.parse(JSON.stringify(element))).toEqual(element);
});

test("no element the factory builds carries a live handle", () => {
	for (const mediaType of ["audio", "video", "image"] as const) {
		const element = buildElementFromMedia({
			mediaId: `media-${mediaType}`,
			mediaType,
			name: `asset.${mediaType}`,
			duration: mediaTime({ ticks: 120_000 }),
			startTime: mediaTime({ ticks: 0 }),
		});

		expect(findNonPlainValue({ value: element, path: mediaType })).toBe(null);
		expect(JSON.parse(JSON.stringify(element))).toEqual(element);
	}
});
