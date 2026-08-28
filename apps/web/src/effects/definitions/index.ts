import { effectsRegistry } from "../registry";
import type { EffectDefinition, EffectGroup } from "@/effects/types";
import { pulseEffect, slowZoomEffect } from "./motion";
import { chromaticAberrationEffect, vhsEffect } from "./tape";
import { blurEffect, blurFillEffect, glowEffect } from "./optics";
import { blackWhiteRemovalEffect, greenScreenEffect } from "./keying";

/**
 * The library, as the panel lists it: what moves the frame, what changes how it
 * looks, what bends the light, and what cuts something out of it.
 *
 * Grouping and ordering are the same list rather than two, so an effect cannot
 * end up filed under one heading and sorted as though it were under another.
 */
const groups: ReadonlyArray<{
	title: string;
	definitions: readonly EffectDefinition[];
}> = [
	{
		title: "Motion",
		definitions: [pulseEffect, slowZoomEffect],
	},
	{
		title: "Looks",
		definitions: [vhsEffect],
	},
	{
		title: "Optics",
		definitions: [
			blurEffect,
			blurFillEffect,
			glowEffect,
			chromaticAberrationEffect,
		],
	},
	{
		title: "Keying",
		definitions: [greenScreenEffect, blackWhiteRemovalEffect],
	},
];

/** The headings and their contents, for the panel to lay out. */
export const EFFECT_GROUPS: readonly EffectGroup[] = groups.map((group) => ({
	title: group.title,
	types: group.definitions.map((definition) => definition.type),
}));

export function registerDefaultEffects(): void {
	for (const group of groups) {
		for (const definition of group.definitions) {
			if (effectsRegistry.has(definition.type)) {
				continue;
			}
			effectsRegistry.register({
				key: definition.type,
				definition,
			});
		}
	}
}
