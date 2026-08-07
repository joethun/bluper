import { describe, expect, test } from "bun:test";
import { isShallowEqual, trackManagerAccess } from "../snapshot-cache";
import { MANAGER_KEYS } from "../manager-tracking";

describe("isShallowEqual", () => {
	test("Object.is primitives short-circuit", () => {
		expect(isShallowEqual({ a: 1, b: 1 })).toBe(true);
		expect(isShallowEqual({ a: "x", b: "x" })).toBe(true);
		expect(isShallowEqual({ a: true, b: true })).toBe(true);
		expect(isShallowEqual({ a: null, b: null })).toBe(true);
		expect(isShallowEqual({ a: undefined, b: undefined })).toBe(true);
	});

	test("returns false for different primitives", () => {
		expect(isShallowEqual({ a: 1, b: 2 })).toBe(false);
		expect(isShallowEqual({ a: "x", b: "y" })).toBe(false);
	});

	test("returns false when only one side is null/undefined", () => {
		expect(isShallowEqual({ a: null, b: {} })).toBe(false);
		expect(isShallowEqual({ a: {}, b: null })).toBe(false);
	});

	test("arrays: shallow element equality", () => {
		const obj = { id: "x" };
		expect(isShallowEqual({ a: [obj, 1], b: [obj, 1] })).toBe(true);
		expect(isShallowEqual({ a: [obj, 1], b: [obj, 2] })).toBe(false);
		expect(isShallowEqual({ a: [1, 2], b: [1, 2, 3] })).toBe(false);
	});

	test("arrays: differing length is unequal", () => {
		expect(isShallowEqual({ a: [1, 2], b: [1] })).toBe(false);
		expect(isShallowEqual({ a: [], b: [1] })).toBe(false);
	});

	test("arrays: returns false when only one side is array", () => {
		expect(isShallowEqual({ a: [1, 2], b: { 0: 1, 1: 2, length: 2 } })).toBe(
			false,
		);
	});

	test("objects: shallow key equality", () => {
		const nested = {};
		expect(isShallowEqual({ a: { x: 1, ref: nested }, b: { x: 1, ref: nested } })).toBe(
			true,
		);
		// Different nested reference → caught by shallow check, but the surfaces
		// here intentionally only rely on the top-level keys.
		expect(isShallowEqual({ a: { x: 1 }, b: { x: 1, y: 2 } })).toBe(false);
		expect(isShallowEqual({ a: { x: 1 }, b: { x: 2 } })).toBe(false);
	});

	test("objects: different key counts are unequal", () => {
		expect(isShallowEqual({ a: { x: 1 }, b: { x: 1, y: 2 } })).toBe(false);
	});

	test("mixed array and object are unequal", () => {
		expect(isShallowEqual({ a: [], b: {} })).toBe(false);
	});
});

describe("trackManagerAccess", () => {
	test("records every manager a selector reads", () => {
		const editor = {
			playback: { id: "playback" },
			timeline: { id: "timeline" },
			scenes: { id: "scenes" },
			project: { id: "project" },
			media: { id: "media" },
			renderer: { id: "renderer" },
			selection: { id: "selection" },
			clipboard: { id: "clipboard" },
			diagnostics: { id: "diagnostics" },
		};
		const accessed = new Set<keyof typeof editor>();

		const result = trackManagerAccess({
			editor,
			selector: (e) => {
				// Touches timeline then scenes.
				return (e as typeof editor).timeline.id + (e as typeof editor).scenes.id;
			},
			accessed,
		});

		expect(result).toBe("timelinescenes");
		expect(accessed.has("timeline")).toBe(true);
		expect(accessed.has("scenes")).toBe(true);
		expect(accessed.has("playback")).toBe(false);
		expect(accessed.has("media")).toBe(false);
	});

	test("a selector that reads nothing records no managers", () => {
		const editor = {};
		const accessed = new Set<string>();
		trackManagerAccess({
			editor,
			selector: () => 42,
			accessed,
		});
		expect(accessed.size).toBe(0);
	});

	test("covers every manager key in the registry", () => {
		// If a new manager is added to MANAGER_KEYS it should be wired through
		// the proxy: an access to it has to show up in the tracked set.
		const editor = Object.fromEntries(
			MANAGER_KEYS.map((key) => [key, { id: key }]),
		);
		const accessed = new Set<string>();

		for (const key of MANAGER_KEYS) {
			trackManagerAccess({
				editor,
				selector: (e) => {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-member-access
					return (e as Record<string, { id: string }>)[key].id;
				},
				accessed,
			});
		}

		for (const key of MANAGER_KEYS) {
			expect(accessed.has(key)).toBe(true);
		}
	});

	test("does not record non-manager property accesses", () => {
		const editor = {
			playback: {},
			other: "ignore me",
		};
		const accessed = new Set<string>();

		trackManagerAccess({
			editor,
			selector: (e) => {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-member-access
				return (e as Record<string, unknown>).other;
			},
			accessed,
		});

		expect(accessed.has("playback")).toBe(false);
		expect(accessed.has("other")).toBe(false);
	});
});
