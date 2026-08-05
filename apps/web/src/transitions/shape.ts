import type { TransitionShape } from "@/transitions/types";

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * The soft edge is baked into the mask with canvas gradients rather than handed
 * to the compositor's feather pass: the pass runs a jump-flood on a binary mask,
 * which cannot express a moving gradient of this shape, and would re-soften an
 * already-soft edge.
 */
const MIN_SOFT_EDGE_FRACTION = 0.001;

export function isShapeFullyOpaque({
	shape,
}: {
	shape: TransitionShape;
}): boolean {
	switch (shape.kind) {
		case "linear":
		case "angular":
		case "tiles":
			return shape.progress >= 1;
		case "radial":
			return shape.inverted ? shape.progress <= 0 : shape.progress >= 1;
	}
}

export function isShapeFullyTransparent({
	shape,
}: {
	shape: TransitionShape;
}): boolean {
	switch (shape.kind) {
		case "linear":
		case "angular":
		case "tiles":
			return shape.progress <= 0;
		case "radial":
			return shape.inverted ? shape.progress >= 1 : shape.progress <= 0;
	}
}

/**
 * Paints the reveal mask for one side of a transition: white where the layer
 * shows through, transparent where it is held back.
 */
export function drawTransitionShape({
	ctx,
	shape,
	width,
	height,
}: {
	ctx: Context2D;
	shape: TransitionShape;
	width: number;
	height: number;
}): void {
	switch (shape.kind) {
		case "linear":
			drawLinearWipe({ ctx, shape, width, height });
			return;
		case "radial":
			drawRadialWipe({ ctx, shape, width, height });
			return;
		case "angular":
			drawAngularWipe({ ctx, shape, width, height });
			return;
		case "tiles":
			drawTiles({ ctx, shape, width, height });
			return;
	}
}

function drawLinearWipe({
	ctx,
	shape,
	width,
	height,
}: {
	ctx: Context2D;
	shape: Extract<TransitionShape, { kind: "linear" }>;
	width: number;
	height: number;
}): void {
	const radians = (shape.angleDegrees * Math.PI) / 180;
	const directionX = Math.cos(radians);
	const directionY = Math.sin(radians);
	// Project the box onto the sweep axis so the gradient always spans the full
	// travel, whatever the angle.
	const span = Math.abs(directionX) * width + Math.abs(directionY) * height;
	const centerX = width / 2;
	const centerY = height / 2;
	const startX = centerX - (directionX * span) / 2;
	const startY = centerY - (directionY * span) / 2;
	const endX = centerX + (directionX * span) / 2;
	const endY = centerY + (directionY * span) / 2;

	const softness = Math.max(MIN_SOFT_EDGE_FRACTION, shape.softness);
	// The edge has to be able to leave the box completely at both ends, so the
	// travel runs from -softness to 1 + softness.
	const edge = shape.progress * (1 + softness) - softness / 2;
	const from = clamp01({ value: edge });
	const to = clamp01({ value: edge + softness });

	const gradient = ctx.createLinearGradient(startX, startY, endX, endY);
	gradient.addColorStop(0, "rgba(255,255,255,1)");
	if (from > 0) {
		gradient.addColorStop(from, "rgba(255,255,255,1)");
	}
	gradient.addColorStop(to, "rgba(255,255,255,0)");
	gradient.addColorStop(1, "rgba(255,255,255,0)");

	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
}

function drawRadialWipe({
	ctx,
	shape,
	width,
	height,
}: {
	ctx: Context2D;
	shape: Extract<TransitionShape, { kind: "radial" }>;
	width: number;
	height: number;
}): void {
	const centerX = width / 2;
	const centerY = height / 2;
	// Reach the far corners so progress 1 covers the whole box.
	const maxRadius = Math.hypot(width, height) / 2;
	const softness = Math.max(MIN_SOFT_EDGE_FRACTION, shape.softness);
	const outerFraction = clamp01({ value: shape.progress * (1 + softness) });
	const outerRadius = Math.max(1, outerFraction * maxRadius);
	const innerFraction = clamp01({
		value: (outerFraction - softness) / outerFraction || 0,
	});

	const discGradient = ctx.createRadialGradient(
		centerX,
		centerY,
		0,
		centerX,
		centerY,
		outerRadius,
	);
	discGradient.addColorStop(0, "rgba(255,255,255,1)");
	discGradient.addColorStop(innerFraction, "rgba(255,255,255,1)");
	discGradient.addColorStop(1, "rgba(255,255,255,0)");

	if (!shape.inverted) {
		ctx.fillStyle = discGradient;
		ctx.fillRect(0, 0, width, height);
		return;
	}

	// Inverted: keep everything except the disc. A radial gradient paints nothing
	// past its outer circle, so fill the box first and punch the disc back out.
	ctx.fillStyle = "rgba(255,255,255,1)";
	ctx.fillRect(0, 0, width, height);
	ctx.globalCompositeOperation = "destination-out";
	ctx.fillStyle = discGradient;
	ctx.fillRect(0, 0, width, height);
	ctx.globalCompositeOperation = "source-over";
}

/**
 * Clock wipe. Canvas has no angular gradient, so the sweep is drawn as a filled
 * pie and the soft edge as a short stack of wedges fading out behind it.
 */
function drawAngularWipe({
	ctx,
	shape,
	width,
	height,
}: {
	ctx: Context2D;
	shape: Extract<TransitionShape, { kind: "angular" }>;
	width: number;
	height: number;
}): void {
	const centerX = width / 2;
	const centerY = height / 2;
	const radius = Math.hypot(width, height);
	const startAngle = ((shape.startDegrees - 90) * Math.PI) / 180;
	const softness = Math.max(MIN_SOFT_EDGE_FRACTION, shape.softness);
	const sweep = clamp01({ value: shape.progress }) * Math.PI * 2;

	ctx.fillStyle = "rgba(255,255,255,1)";
	ctx.beginPath();
	ctx.moveTo(centerX, centerY);
	ctx.arc(centerX, centerY, radius, startAngle, startAngle + sweep);
	ctx.closePath();
	ctx.fill();

	const softSweep = softness * Math.PI * 2;
	const steps = 8;
	for (let step = 0; step < steps; step++) {
		const alpha = 1 - (step + 1) / (steps + 1);
		const from = startAngle + sweep + (softSweep * step) / steps;
		const to = startAngle + sweep + (softSweep * (step + 1)) / steps;
		ctx.fillStyle = `rgba(255,255,255,${alpha})`;
		ctx.beginPath();
		ctx.moveTo(centerX, centerY);
		ctx.arc(centerX, centerY, radius, from, to);
		ctx.closePath();
		ctx.fill();
	}
}

/**
 * How much of the window a single tile's own arrival takes, at most stagger. Kept
 * off zero so the fully-staggered end of the range still has a ramp to divide by,
 * and so tiles grow rather than snap on.
 */
const MIN_TILE_RAMP = 0.08;

/** Where a tile starts from before it grows into its cell. */
const TILE_START_SCALE = 0.35;

/**
 * The grid for the box the mask is drawn into. `count` is the long axis and the
 * short one takes however many cells come closest to that tile size, so the same
 * transition reads the same on a portrait clip as a landscape one.
 *
 * Cells come out near-square rather than exactly square: tiling the box with a
 * whole number of rows and columns rarely divides evenly, and a part-tile at the
 * edge would be far more obvious than a slightly oblong one.
 */
function resolveTileGrid({
	count,
	width,
	height,
}: {
	count: number;
	width: number;
	height: number;
}): { columns: number; rows: number } {
	const longAxis = Math.max(1, Math.round(count));
	if (width <= 0 || height <= 0) {
		return { columns: longAxis, rows: longAxis };
	}

	const aspect = width / height;
	return aspect >= 1
		? { columns: longAxis, rows: Math.max(1, Math.round(longAxis / aspect)) }
		: { columns: Math.max(1, Math.round(longAxis * aspect)), rows: longAxis };
}

/**
 * Clipchamp's "Tiles": a grid of squares that grow into place across the frame
 * instead of one moving edge.
 *
 * Each tile has its own slice of the window, offset along the diagonal so the
 * arrival reads as a wave from the top-left rather than noise. Tiles are grown from
 * their cell centre towards *integer* cell bounds, so at the end they meet exactly
 * and leave no seam — interpolating between fractional edges would leave a faint
 * antialiased grid over the whole blend.
 */
function drawTiles({
	ctx,
	shape,
	width,
	height,
}: {
	ctx: Context2D;
	shape: Extract<TransitionShape, { kind: "tiles" }>;
	width: number;
	height: number;
}): void {
	const { columns, rows } = resolveTileGrid({
		count: shape.count,
		width,
		height,
	});
	const progress = clamp01({ value: shape.progress });
	const ramp = Math.max(MIN_TILE_RAMP, 1 - clamp01({ value: shape.stagger }));
	const spread = 1 - ramp;
	const lastDiagonal = Math.max(1, columns - 1 + (rows - 1));
	const cellWidth = width / columns;
	const cellHeight = height / rows;

	ctx.fillStyle = "rgba(255,255,255,1)";
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const start = ((column + row) / lastDiagonal) * spread;
			const local = clamp01({ value: (progress - start) / ramp });
			if (local <= 0) {
				continue;
			}

			// Ease so tiles settle rather than arriving at constant speed.
			const eased = local * local * (3 - 2 * local);
			const scale = TILE_START_SCALE + (1 - TILE_START_SCALE) * eased;
			const left = Math.floor(column * cellWidth);
			const right = Math.ceil((column + 1) * cellWidth);
			const top = Math.floor(row * cellHeight);
			const bottom = Math.ceil((row + 1) * cellHeight);
			const centerX = (left + right) / 2;
			const centerY = (top + bottom) / 2;
			const x = centerX + (left - centerX) * scale;
			const y = centerY + (top - centerY) * scale;

			ctx.globalAlpha = eased;
			ctx.fillRect(x, y, (right - left) * scale, (bottom - top) * scale);
		}
	}
	ctx.globalAlpha = 1;
}

function clamp01({ value }: { value: number }): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}
