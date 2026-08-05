import { describe, expect, test } from "bun:test";
import { computeGroupResize } from "@/timeline/group-resize";
import type { GroupResizeMember } from "@/timeline/group-resize";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

const FPS = { numerator: 30, denominator: 1 };

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: value * TICKS_PER_SECOND });
}

/**
 * A three second segment sitting four seconds into a ten second source, alone
 * on its track. Frozen or not, the numbers are the same — only `isFrozen`
 * differs, which is the whole point of these cases.
 */
function buildMember(
	overrides: Partial<GroupResizeMember> = {},
): GroupResizeMember {
	return {
		trackId: "main",
		elementId: "clip",
		startTime: ZERO_MEDIA_TIME,
		duration: seconds({ value: 3 }),
		trimStart: seconds({ value: 4 }),
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: seconds({ value: 10 }),
		leftNeighborBound: null,
		rightNeighborBound: null,
		...overrides,
	};
}

describe("computeGroupResize with a held still", () => {
	test("stretches past the source that an ordinary clip would run out of", () => {
		const deltaTime = seconds({ value: 20 });

		const clip = computeGroupResize({
			members: [buildMember()],
			side: "right",
			deltaTime,
			fps: FPS,
		});
		const still = computeGroupResize({
			members: [buildMember({ isFrozen: true })],
			side: "right",
			deltaTime,
			fps: FPS,
		});

		// The clip stops at the six seconds of source left after its trim.
		expect(clip.updates[0].patch.duration).toBe(seconds({ value: 6 }));
		expect(still.updates[0].patch.duration).toBe(seconds({ value: 23 }));
	});

	test("holds the same frame however far its right edge is dragged", () => {
		const result = computeGroupResize({
			members: [buildMember({ isFrozen: true })],
			side: "right",
			deltaTime: seconds({ value: 20 }),
			fps: FPS,
		});

		expect(result.updates[0].patch.trimStart).toBe(seconds({ value: 4 }));
		expect(result.updates[0].patch.trimEnd).toBe(ZERO_MEDIA_TIME);
	});

	test("holds the same frame when the left edge moves, unlike a clip", () => {
		const member = { startTime: seconds({ value: 5 }) };
		const deltaTime = mediaTime({ ticks: -2 * TICKS_PER_SECOND });

		const clip = computeGroupResize({
			members: [buildMember(member)],
			side: "left",
			deltaTime,
			fps: FPS,
		});
		const still = computeGroupResize({
			members: [buildMember({ ...member, isFrozen: true })],
			side: "left",
			deltaTime,
			fps: FPS,
		});

		// Dragging a clip's left edge out scrubs back into the source...
		expect(clip.updates[0].patch.trimStart).toBe(seconds({ value: 2 }));
		// ...while a still just gets held for longer.
		expect(still.updates[0].patch.trimStart).toBe(seconds({ value: 4 }));
		expect(still.updates[0].patch.startTime).toBe(seconds({ value: 3 }));
		expect(still.updates[0].patch.duration).toBe(seconds({ value: 5 }));
	});

	test("still stops at the neighbour it would otherwise overrun", () => {
		const result = computeGroupResize({
			members: [
				buildMember({
					isFrozen: true,
					rightNeighborBound: seconds({ value: 10 }),
				}),
			],
			side: "right",
			deltaTime: seconds({ value: 20 }),
			fps: FPS,
		});

		expect(result.updates[0].patch.duration).toBe(seconds({ value: 10 }));
	});

	test("still cannot be dragged shorter than a single frame", () => {
		const result = computeGroupResize({
			members: [buildMember({ isFrozen: true })],
			side: "right",
			deltaTime: mediaTime({ ticks: -100 * TICKS_PER_SECOND }),
			fps: FPS,
		});

		expect(result.updates[0].patch.duration).toBe(
			mediaTime({ ticks: TICKS_PER_SECOND / 30 }),
		);
	});
});
