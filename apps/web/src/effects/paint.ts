import { borrowSurface, SURFACE_KEYS } from "./canvas";
import { effectsRegistry } from "./registry";
import type {
	EffectContext2D,
	EffectDefinition,
	ResolvedEffect,
} from "./types";

type EffectPainter = NonNullable<EffectDefinition["paint"]>;

export type DrawBaseFn = ({
	ctx,
	source,
	width,
	height,
}: {
	ctx: EffectContext2D;
	source: CanvasImageSource;
	width: number;
	height: number;
}) => void;

function drawPlain({
	ctx,
	source,
	width,
	height,
}: {
	ctx: EffectContext2D;
	source: CanvasImageSource;
	width: number;
	height: number;
}): void {
	ctx.drawImage(source, 0, 0, width, height);
}

/**
 * Draws a layer with its effect stack applied, in stack order.
 *
 * Every stage is handed a cleared buffer of its own and the previous stage's
 * output as a canvas. That costs one extra full-frame draw over painting
 * straight into the target, and buys two things worth more than it: an effect
 * may read its input's pixels back, and its composite tricks (a `lighter` wash, a
 * `destination-in` alpha restore) cannot reach past its own stage.
 *
 * With an empty stack this is just `drawBase`, which is the path every unaffected
 * layer in the scene takes.
 */
export function paintEffectedLayer({
	ctx,
	source,
	width,
	height,
	effects,
	drawBase = drawPlain,
}: {
	ctx: EffectContext2D;
	source: CanvasImageSource;
	width: number;
	height: number;
	effects: readonly ResolvedEffect[];
	drawBase?: DrawBaseFn;
}): void {
	const painters: Array<{ effect: ResolvedEffect; paint: EffectPainter }> = [];
	for (const effect of effects) {
		const paint = effectsRegistry.has(effect.type)
			? effectsRegistry.get(effect.type).paint
			: undefined;
		if (paint) {
			painters.push({ effect, paint });
		}
	}

	if (painters.length === 0) {
		drawBase({ ctx, source, width, height });
		return;
	}

	// The two buffers alternate. Borrowing clears, so the surface holding the
	// stage that just ran is never borrowed again until it has been consumed.
	let inputKey: string = SURFACE_KEYS.chainA;
	let spareKey: string = SURFACE_KEYS.chainB;
	let input = borrowSurface({ key: inputKey, width, height });
	drawBase({ ctx: input.ctx, source, width, height });

	painters.forEach((entry, index) => {
		const isLast = index === painters.length - 1;
		const targetSurface = isLast
			? null
			: borrowSurface({ key: spareKey, width, height });

		entry.paint({
			ctx: targetSurface ? targetSurface.ctx : ctx,
			source: input.canvas,
			width,
			height,
			params: entry.effect.params,
			time: entry.effect.time,
			progress: entry.effect.progress,
		});

		if (targetSurface) {
			input = targetSurface;
			const consumedKey = inputKey;
			inputKey = spareKey;
			spareKey = consumedKey;
		}
	});
}

/**
 * Identifies a layer's effect stack for the frame it was resolved at. The
 * compositor skips a texture upload entirely when this matches the previous
 * frame's, so an animated effect has to contribute its time or it would be drawn
 * once and then held.
 */
export function hashResolvedEffects({
	effects,
}: {
	effects: readonly ResolvedEffect[];
}): string {
	if (effects.length === 0) {
		return "";
	}
	return effects
		.map((effect) => {
			const timing = effect.animated
				? `@${effect.time.toFixed(4)}/${effect.progress.toFixed(4)}`
				: "";
			return `${effect.type}:${JSON.stringify(effect.params)}${timing}`;
		})
		.join("|");
}
