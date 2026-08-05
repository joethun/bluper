import { describe, expect, test } from "bun:test";
import { getPropertiesConfig } from "@/components/editor/panels/properties/registry";
import type { TimelineElement } from "@/timeline";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

const REQUESTED_ORDER = [
	"transform",
	"audio",
	"speed",
	"fade",
	"adjust",
	"effects",
	"masks",
];

const base = {
	id: "e1",
	name: "clip",
	duration: mediaTime({ ticks: 1000 }),
	startTime: ZERO_MEDIA_TIME,
	trimStart: ZERO_MEDIA_TIME,
	trimEnd: ZERO_MEDIA_TIME,
	params: {},
};

const ELEMENTS = {
	video: { ...base, type: "video", mediaId: "m1" },
	image: { ...base, type: "image", mediaId: "m1" },
	text: { ...base, type: "text" },
	sticker: { ...base, type: "sticker", stickerId: "s1" },
	graphic: { ...base, type: "graphic", definitionId: "rectangle" },
} satisfies Record<string, TimelineElement>;

type Kind = keyof typeof ELEMENTS;

const ALL_KINDS: Kind[] = ["video", "image", "text", "sticker", "graphic"];
const MEDIA: Kind[] = ["video", "image"];
const NON_MEDIA: Kind[] = ["text", "sticker", "graphic"];

// No asset: getVideoConfig only hides the audio tab when hasAudio is explicitly
// false, so an absent asset still yields the full tab list.
function configFor({ kind }: { kind: Kind }) {
	return getPropertiesConfig({ element: ELEMENTS[kind], mediaAssets: [] });
}

function tabIds({ kind }: { kind: Kind }): string[] {
	return configFor({ kind }).tabs.map((tab) => tab.id);
}

describe("properties tab order", () => {
	test("video shows every tab in the requested order", () => {
		expect(tabIds({ kind: "video" })).toEqual(REQUESTED_ORDER);
	});

	test("other types keep the same relative order", () => {
		for (const kind of ALL_KINDS.filter((kind) => kind !== "video")) {
			const ranked = tabIds({ kind }).filter((id) =>
				REQUESTED_ORDER.includes(id),
			);
			expect(ranked, kind).toEqual(
				REQUESTED_ORDER.filter((id) => ranked.includes(id)),
			);
		}
	});

	test("a type's own content tab leads, before transform", () => {
		expect(tabIds({ kind: "text" })[0]).toBe("text");
		expect(tabIds({ kind: "graphic" })[0]).toBe("graphic");
	});

	test("only footage and stills offer Adjust; the rest offer Blending", () => {
		for (const kind of MEDIA) {
			expect(tabIds({ kind }), kind).toContain("adjust");
			expect(tabIds({ kind }), kind).not.toContain("blending");
		}
		for (const kind of NON_MEDIA) {
			expect(tabIds({ kind }), kind).not.toContain("adjust");
			expect(tabIds({ kind }), kind).toContain("blending");
		}
	});

	test("the default tab is one the element actually shows", () => {
		for (const kind of ALL_KINDS) {
			const config = configFor({ kind });
			expect(
				config.tabs.map((tab) => tab.id),
				kind,
			).toContain(config.defaultTab);
		}
	});
});
