import { describe, expect, test } from "bun:test";
import { rememberInCache } from "@/media/audio-cache";

function buildCache({ keys }: { keys: string[] }): Map<string, number> {
	return new Map(keys.map((key, index) => [key, index]));
}

describe("rememberInCache", () => {
	test("keeps entries while there is room", () => {
		const cache = buildCache({ keys: ["a", "b"] });

		rememberInCache({ cache, key: "c", value: 2, limit: 4 });

		expect([...cache.keys()]).toEqual(["a", "b", "c"]);
	});

	test("drops the oldest entry once full", () => {
		const cache = buildCache({ keys: ["a", "b", "c"] });

		rememberInCache({ cache, key: "d", value: 3, limit: 3 });

		expect([...cache.keys()]).toEqual(["b", "c", "d"]);
	});

	test("drops as many as it takes to get back under the limit", () => {
		const cache = buildCache({ keys: ["a", "b", "c", "d", "e"] });

		rememberInCache({ cache, key: "f", value: 5, limit: 2 });

		expect([...cache.keys()]).toEqual(["e", "f"]);
	});

	/**
	 * The new entry is the one about to be read, so evicting it would defeat the
	 * cache: the caller would go straight back to decoding what it just stored.
	 */
	test("never evicts the entry that was just added", () => {
		const cache = new Map<string, number>();

		rememberInCache({ cache, key: "only", value: 1, limit: 0 });

		expect([...cache.keys()]).toEqual(["only"]);
	});

	test("re-adding an existing key refreshes it rather than growing", () => {
		const cache = buildCache({ keys: ["a", "b", "c"] });

		rememberInCache({ cache, key: "b", value: 99, limit: 3 });

		expect(cache.get("b")).toBe(99);
		expect(cache.size).toBe(3);
	});
});
