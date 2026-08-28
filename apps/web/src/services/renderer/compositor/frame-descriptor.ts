import { hashResolvedAdjustments, paintAdjustedLayer } from "@/adjustments";
import { hashResolvedEffects, paintEffectedLayer } from "@/effects";
import { supportsCanvasFilter } from "@/effects/canvas-filter-support";
import { buildAdjustmentFilterPasses } from "@/adjustments/filter-passes";
import { borrowSurface, SURFACE_KEYS } from "@/effects/canvas";
import {
	getCropPlacement,
	hashCrop,
	resolveCropRect,
	type CropRect,
} from "@/crop";
import { drawCssBackground } from "@/gradients";
import { getMaskDefinition } from "@/masks";
import { incrementCounter } from "@/diagnostics/render-perf";
import { drawTransitionShape } from "@/transitions";
import type { TransitionShape } from "@/transitions/types";
import { gpuRenderer } from "../gpu-renderer";
import type { AnyBaseNode } from "../nodes/base-node";
import type { CanvasRenderer } from "../canvas-renderer";
import { createCanvasSurface } from "../canvas-utils";
import { BlurBackgroundNode } from "../nodes/blur-background-node";
import { ColorNode } from "../nodes/color-node";
import { EffectLayerNode } from "../nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "../nodes/graphic-node";
import { ImageNode } from "../nodes/image-node";
import { RootNode } from "../nodes/root-node";
import { StickerNode } from "../nodes/sticker-node";
import { renderTextToContext, TextNode } from "../nodes/text-node";
import { VideoNode } from "../nodes/video-node";
import type { ResolvedVisualSourceNodeState } from "../nodes/visual-node";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	LayerMaskDescriptor,
	QuadTransformDescriptor,
	TextureCanvasDrawFn,
	TextureUploadDescriptor,
} from "./types";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics";

/**
 * Turns the resolved tree into the one flat description the compositor takes.
 *
 * Synchronous on purpose: everything asynchronous about a frame — decoding,
 * image loads — has already happened in `resolveRenderTree`, and this walk only
 * reads the state that left behind. It used to be `async` throughout, which cost
 * a promise and a microtask hop per node in the tree on every frame and let
 * unrelated work interleave halfway through building a frame.
 */
export function buildFrameDescriptor({
	node,
	renderer,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
}): {
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
} {
	const items: FrameItemDescriptor[] = [];
	const textures = new Map<string, TextureUploadDescriptor>();

	collectNode({
		node,
		renderer,
		// Scoped to this renderer — see `CanvasRenderer.id`.
		path: renderer.id,
		items,
		textures,
	});

	incrementCounter({ name: "frameItems", by: items.length });
	incrementCounter({ name: "frameTextures", by: textures.size });

	return {
		frame: {
			width: renderer.width,
			height: renderer.height,
			renderScale: renderer.scale,
			clear: {
				color: [0, 0, 0, 1],
			},
			items,
		},
		textures: [...textures.values()],
	};
}

/**
 * Records a texture that covers the whole canvas and is drawn in canvas units —
 * a colour fill, a blur backdrop, a transition wash, a page of type.
 *
 * The upload is sized by the renderer's scale rather than by the project's
 * resolution, and `draw` is handed a context already transformed by it, so the
 * drawing code stays in canvas units while the rasterisation and the readback
 * that follows it shrink with the frame. `contentHash` carries the upload size,
 * so a scale change re-rasterises rather than reusing a texture of the wrong
 * size.
 */
function setCanvasTexture({
	textures,
	renderer,
	id,
	contentHash,
	draw,
}: {
	textures: Map<string, TextureUploadDescriptor>;
	renderer: CanvasRenderer;
	id: string;
	contentHash: string;
	draw: TextureCanvasDrawFn;
}): void {
	const width = renderer.deviceWidth;
	const height = renderer.deviceHeight;
	textures.set(id, {
		kind: "rendered",
		id,
		contentHash: `${contentHash}@${width}x${height}`,
		width,
		height,
		drawScale: renderer.scale,
		draw,
	});
}

function collectNode({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}): void {
	if (node instanceof RootNode) {
		for (let index = 0; index < node.children.length; index++) {
			collectNode({
				node: node.children[index],
				renderer,
				path: `${path}:${index}`,
				items,
				textures,
			});
		}
		return;
	}

	if (node instanceof ColorNode) {
		const textureId = `${path}:color`;
		const { width, height } = renderer;
		setCanvasTexture({
			textures,
			renderer,
			id: textureId,
			contentHash: `color:${node.params.color}:${width}x${height}`,
			draw: (ctx) => {
				if (/gradient\(/i.test(node.params.color)) {
					drawCssBackground({ ctx, width, height, css: node.params.color });
				} else {
					ctx.fillStyle = node.params.color;
					ctx.fillRect(0, 0, width, height);
				}
			},
		});
		items.push({
			type: "layer",
			textureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		});
		return;
	}

	if (node instanceof EffectLayerNode) {
		if (!node.resolved || node.resolved.passes.length === 0) {
			return;
		}
		items.push({
			type: "sceneEffect",
			effectPassGroups: [node.resolved.passes],
		});
		return;
	}

	if (node instanceof BlurBackgroundNode) {
		if (!node.resolved) {
			return;
		}
		const textureId = `${path}:blur-background`;
		const { width, height } = renderer;
		const { backdropSource, passes } = node.resolved;
		// Backdrop pixels come from a decoded video/image frame whose identity
		// already changes when it changes. Hashing the source reference is
		// enough to let us skip redraws on frozen frames.
		// Only the kept region feeds the wash, so the backdrop behind a cropped
		// shot is made of what is still on screen.
		const backdropRect = resolveCropRect({
			crop: node.params.crop,
			width: backdropSource.width,
			height: backdropSource.height,
		}) ?? {
			x: 0,
			y: 0,
			width: backdropSource.width,
			height: backdropSource.height,
		};
		const contentHash = `blur:${identityKey(backdropSource.source)}:${backdropSource.width}x${backdropSource.height}:${hashCrop({ crop: node.params.crop })}:${width}x${height}`;
		setCanvasTexture({
			textures,
			renderer,
			id: textureId,
			contentHash,
			draw: (ctx) => {
				const coverScale = Math.max(
					width / backdropRect.width,
					height / backdropRect.height,
				);
				const scaledWidth = backdropRect.width * coverScale;
				const scaledHeight = backdropRect.height * coverScale;
				const offsetX = (width - scaledWidth) / 2;
				const offsetY = (height - scaledHeight) / 2;
				ctx.drawImage(
					backdropSource.source,
					backdropRect.x,
					backdropRect.y,
					backdropRect.width,
					backdropRect.height,
					offsetX,
					offsetY,
					scaledWidth,
					scaledHeight,
				);
			},
		});
		items.push({
			type: "layer",
			textureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [passes],
			mask: null,
		});
		return;
	}

	if (
		node instanceof VideoNode ||
		node instanceof ImageNode ||
		node instanceof StickerNode ||
		node instanceof GraphicNode
	) {
		collectVisualSourceNode({
			node,
			renderer,
			path,
			items,
			textures,
		});
		return;
	}

	if (node instanceof TextNode) {
		collectTextNode({
			node,
			renderer,
			path,
			items,
			textures,
		});
	}
}

function collectVisualSourceNode({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	if (!node.resolved) {
		return;
	}

	const source =
		node instanceof GraphicNode
			? node.getSource({ resolvedParams: node.resolved.resolvedParams })
			: node.resolved.source;
	if (!source) {
		return;
	}

	const fullSourceWidth =
		node instanceof GraphicNode
			? DEFAULT_GRAPHIC_SOURCE_SIZE
			: (node.resolved as ResolvedVisualSourceNodeState).sourceWidth;
	const fullSourceHeight =
		node instanceof GraphicNode
			? DEFAULT_GRAPHIC_SOURCE_SIZE
			: (node.resolved as ResolvedVisualSourceNodeState).sourceHeight;

	// The texture carries only the kept region, so the layer's pixels are the
	// cropped ones; where that region *lands* is worked out by
	// `computeVisualTransform` from the full frame, so trimming an edge never
	// moves or resizes the part of the picture that survives.
	const crop = node.params.crop;
	const cropRect = resolveCropRect({
		crop,
		width: fullSourceWidth,
		height: fullSourceHeight,
	});
	const sourceWidth = cropRect ? cropRect.width : fullSourceWidth;
	const sourceHeight = cropRect ? cropRect.height : fullSourceHeight;

	// Worked out before the texture rather than after it: the quad is how many
	// render-target pixels this layer actually covers, which is what decides
	// how much of a decoded frame is worth uploading.
	const transform = computeVisualTransform({
		renderer,
		resolved: node.resolved,
		sourceWidth: fullSourceWidth,
		sourceHeight: fullSourceHeight,
		cropRect,
	});

	const textureId = `${path}:source`;
	const adjustments = node.resolved.adjustments;
	const canvasEffects = node.resolved.canvasEffects;

	// Where the adjustment filter chain runs. `ctx.filter` is the fast path and
	// the one the web build takes, but WebKitGTK ignores it, so there the chain
	// is handed to the compositor as shader passes instead. The overlays are
	// blend-mode draws that don't depend on `ctx.filter`, so they stay on the
	// canvas either way — which means a layer whose adjustments are pure filter
	// keeps the decoded frame on its fast path rather than taking a blit.
	const filterRunsOnGpu = adjustments !== null && !supportsCanvasFilter();
	const adjustmentFilterPasses = filterRunsOnGpu
		? buildAdjustmentFilterPasses({ filter: adjustments.filter })
		: [];
	const canvasAdjustments =
		filterRunsOnGpu && adjustments.overlays.length > 0
			? { ...adjustments, filter: "" }
			: filterRunsOnGpu
				? null
				: adjustments;

	if (canvasAdjustments || canvasEffects.length > 0) {
		// A graded or affected layer can no longer be handed to the GPU as the decoded
		// frame itself: the filter chain, the blend-mode passes and the effect stack
		// have to be drawn first. Hashing the frame's identity alongside the stacks
		// keeps a paused playhead or a held still from repainting every frame.
		textures.set(textureId, {
			kind: "rendered",
			id: textureId,
			contentHash: `styled:${identityKey(source)}:${sourceWidth}x${sourceHeight}:${hashCrop(
				{ crop },
			)}:${
				canvasAdjustments
					? hashResolvedAdjustments({ adjustments: canvasAdjustments })
					: ""
			}:${hashResolvedEffects({ effects: canvasEffects })}`,
			width: sourceWidth,
			height: sourceHeight,
			draw: (ctx) => {
				paintEffectedLayer({
					ctx,
					// The crop runs first, so every pass downstream sees the kept
					// region as the whole layer — a vignette lands on the new edges
					// rather than on ones the crop threw away.
					source: cropRect
						? cropToSurface({
								source,
								sourceWidth: fullSourceWidth,
								sourceHeight: fullSourceHeight,
								cropRect,
							})
						: source,
					width: sourceWidth,
					height: sourceHeight,
					effects: canvasEffects,
					drawBase: canvasAdjustments
						? ({ ctx: target, source: base, width, height }) =>
								paintAdjustedLayer({
									ctx: target,
									source: base,
									width,
									height,
									adjustments: canvasAdjustments,
								})
						: undefined,
				});
			},
		});
	} else if (cropRect) {
		// Nothing else needs a canvas, but a cropped clip cannot go to the GPU as
		// the decoded frame: the compositor draws whole textures, so the kept
		// region has to become a texture of its own. Hashing the frame's identity
		// with the crop keeps a paused playhead from re-blitting every frame.
		textures.set(textureId, {
			kind: "rendered",
			id: textureId,
			contentHash: `cropped:${identityKey(source)}:${hashCrop({ crop })}:${sourceWidth}x${sourceHeight}`,
			width: sourceWidth,
			height: sourceHeight,
			draw: (ctx) => {
				ctx.drawImage(
					cropToSurface({
						source,
						sourceWidth: fullSourceWidth,
						sourceHeight: fullSourceHeight,
						cropRect,
					}),
					0,
					0,
				);
			},
		});
	} else if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
		// The fast path: the layer is the decoded WebCodecs frame straight from
		// the GPU. No canvas blit, no `readPixels`. Identity-based caching keeps
		// a held still from re-uploading.
		//
		// A frame still costs a `getImageData` on the way to the GPU on every
		// platform (see `import_video_frame_texture`), and that cost is per
		// pixel, so it is only worth uploading as many pixels as the quad can
		// show. Skipped when the layer carries shader passes: those sample this
		// texture with uniforms sized against the renderer, so shrinking it
		// underneath them would change how strong an effect looks.
		const carriesEffectPasses =
			adjustmentFilterPasses.length > 0 ||
			node.resolved.effectPasses.length > 0;
		const upload = carriesEffectPasses
			? { width: sourceWidth, height: sourceHeight }
			: fitUploadToQuad({
					sourceWidth,
					sourceHeight,
					// The quad is in canvas units; what decides how many texels are
					// worth reading is how many *pixels* it lands on, which the
					// render scale is what says.
					quadWidth: transform.width * renderer.scale,
					quadHeight: transform.height * renderer.scale,
				});

		const previous = textures.get(textureId);
		if (
			previous?.kind !== "video" ||
			previous.source !== source ||
			previous.width !== upload.width ||
			previous.height !== upload.height
		) {
			textures.set(textureId, {
				kind: "video",
				id: textureId,
				source,
				width: upload.width,
				height: upload.height,
			});
		}
	} else {
		textures.set(textureId, {
			kind: "external",
			id: textureId,
			source,
			width: sourceWidth,
			height: sourceHeight,
		});
	}

	const { mask, strokeLayer } = buildMaskArtifacts({
		node,
		renderer,
		path,
		transform,
		textures,
	});

	items.push({
		type: "layer",
		textureId,
		transform,
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		// The adjustment chain grades the frame before any effect stacked on top
		// of it, matching the order the canvas path draws in.
		effectPassGroups:
			adjustmentFilterPasses.length > 0
				? [adjustmentFilterPasses, ...node.resolved.effectPasses]
				: node.resolved.effectPasses,
		mask,
	});
	if (strokeLayer) {
		items.push(strokeLayer);
	}

	// Emitted by the incoming clip only, which sorts after the outgoing one on the
	// track — so the wash lands above both halves of the cut.
	const overlay = node.resolved.transitionOverlay;
	if (overlay && overlay.opacity > 0) {
		const overlayTextureId = `${path}:transition-overlay`;
		const { width, height } = renderer;
		setCanvasTexture({
			textures,
			renderer,
			id: overlayTextureId,
			contentHash: `transition-overlay:${overlay.color}:${width}x${height}`,
			draw: (ctx) => {
				ctx.fillStyle = overlay.color;
				ctx.fillRect(0, 0, width, height);
			},
		});
		items.push({
			type: "layer",
			textureId: overlayTextureId,
			transform: fullCanvasTransform(renderer),
			opacity: overlay.opacity,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		});
	}
}

function collectTextNode({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: TextNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	if (!node.resolved) {
		return;
	}

	const textureId = `${path}:text`;
	const { width, height } = renderer;
	// Text output is fully determined by node.params + node.resolved. Both are
	// plain data we can stringify cheaply; the resolved measured layout is the
	// expensive part of text setup, so stringifying it here is orders of
	// magnitude cheaper than re-rasterizing when nothing changed.
	const contentHash = `text:${width}x${height}:${JSON.stringify({
		params: node.params,
		resolved: node.resolved,
	})}`;
	setCanvasTexture({
		textures,
		renderer,
		id: textureId,
		contentHash,
		draw: (ctx) => {
			const adjustments = node.resolved?.adjustments;
			if (!adjustments) {
				renderTextToContext({ node, ctx });
				return;
			}
			// The adjustment passes read the finished layer back, over itself with
			// blend modes, so the type has to be rasterised somewhere they can reach
			// it.
			const raster = borrowSurface({
				key: "text-raster",
				width,
				height,
			});
			renderTextToContext({ node, ctx: raster.ctx });
			paintAdjustedLayer({
				ctx,
				source: raster.canvas,
				width,
				height,
				adjustments,
			});
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: fullCanvasTransform(renderer),
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: [],
		mask: null,
	});
}

/**
 * Where the layer's quad lands on the canvas.
 *
 * `sourceWidth`/`sourceHeight` are the *whole* frame, cropped or not, so the
 * contain-fit that decides how big a clip is drawn never moves when the crop
 * changes. A crop then takes the matching sub-rectangle of that box: the kept
 * picture stays exactly where and how large it was, and only the trimmed edges
 * stop being drawn. Fitting the cropped region to the canvas instead would zoom
 * the shot every time an edge moved, which reads as the picture stretching.
 */
function computeVisualTransform({
	renderer,
	resolved,
	sourceWidth,
	sourceHeight,
	cropRect,
}: {
	renderer: CanvasRenderer;
	resolved: ResolvedVisualSourceNodeState | ResolvedGraphicNodeState;
	sourceWidth: number;
	sourceHeight: number;
	cropRect?: CropRect | null;
}): QuadTransformDescriptor {
	const containScale = Math.min(
		renderer.width / sourceWidth,
		renderer.height / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * resolved.transform.scaleX;
	const scaledHeight = sourceHeight * containScale * resolved.transform.scaleY;
	const absWidth = Math.abs(scaledWidth);
	const absHeight = Math.abs(scaledHeight);
	const flipX = scaledWidth < 0;
	const flipY = scaledHeight < 0;

	const { keptFractionX, keptFractionY, centerFractionX, centerFractionY } =
		getCropPlacement({
			cropRect: cropRect ?? null,
			width: sourceWidth,
			height: sourceHeight,
		});

	// The offset is measured inside the layer's own box, so a mirrored layer
	// carries its kept region to the mirrored side, and a rotated one carries it
	// round with the rotation.
	const localOffsetX = absWidth * centerFractionX * (flipX ? -1 : 1);
	const localOffsetY = absHeight * centerFractionY * (flipY ? -1 : 1);
	const rotationRadians = (resolved.transform.rotate * Math.PI) / 180;
	const cos = Math.cos(rotationRadians);
	const sin = Math.sin(rotationRadians);

	return {
		centerX:
			renderer.width / 2 +
			resolved.transform.position.x +
			localOffsetX * cos -
			localOffsetY * sin,
		centerY:
			renderer.height / 2 +
			resolved.transform.position.y +
			localOffsetX * sin +
			localOffsetY * cos,
		width: absWidth * keptFractionX,
		height: absHeight * keptFractionY,
		rotationDegrees: resolved.transform.rotate,
		flipX,
		flipY,
	};
}

/**
 * Upload sizes are rounded up to a multiple of this.
 *
 * Without it, dragging a scale handle moves the quad a pixel at a time and every
 * pixel is a different upload size, so the texture cache misses on a frame it
 * already holds and re-reads it — turning a drag on a paused playhead into a
 * readback per pointer move. Bucketing overshoots by at most this much per axis
 * and keeps a whole drag on one cached upload.
 */
const UPLOAD_SIZE_BUCKET_PX = 64;

/**
 * How much of a decoded frame is worth putting on the GPU.
 *
 * The compositor stretches a layer's texture to fill its quad and samples it
 * with normalised UVs, so the texture's own size never reaches the geometry —
 * which makes the ideal upload the quad's pixel size, one texel per pixel drawn.
 * Anything beyond that is read back off the CPU and then thrown away by the
 * sampler. A 4K clip in a 1080p project is the everyday case: the quad is
 * 1080p, so three quarters of every frame's readback was waste.
 *
 * Zooming the layer in grows the quad and so grows the upload, which keeps
 * detail available exactly when it can be seen. Never upscales past the frame's
 * own size, and never returns zero — a layer scaled down to nothing still needs
 * a texture the compositor can bind.
 */
function fitUploadToQuad({
	sourceWidth,
	sourceHeight,
	quadWidth,
	quadHeight,
}: {
	sourceWidth: number;
	sourceHeight: number;
	quadWidth: number;
	quadHeight: number;
}): { width: number; height: number } {
	const bucket = ({
		needed,
		available,
	}: {
		needed: number;
		available: number;
	}): number =>
		Math.max(
			1,
			Math.min(
				available,
				Math.ceil(needed / UPLOAD_SIZE_BUCKET_PX) * UPLOAD_SIZE_BUCKET_PX,
			),
		);

	return {
		width: bucket({ needed: quadWidth, available: sourceWidth }),
		height: bucket({ needed: quadHeight, available: sourceHeight }),
	};
}


/**
 * The kept region of a frame, on a pooled canvas, ready to stand in for the
 * source everywhere downstream. Borrowed rather than allocated because a cropped
 * clip redraws this on every frame it plays.
 *
 * A decoded `VideoFrame` is copied whole into a canvas first. WebKitGTK draws a
 * frame straight through — the same quirk `keepSourceAlpha` copies around for
 * composite operations — and it ignores `drawImage`'s source rectangle along
 * with everything else, so cropping a frame directly handed back the whole
 * picture squeezed into the cropped box instead of the part that was kept.
 * Measured by the "Cropping a decoded frame keeps only the kept pixels" desktop
 * check, which also records whether the engine still needs the copy.
 */
function cropToSurface({
	source,
	sourceWidth,
	sourceHeight,
	cropRect,
}: {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	cropRect: CropRect;
}): OffscreenCanvas {
	const croppable =
		typeof VideoFrame !== "undefined" && source instanceof VideoFrame
			? copyFrameToSurface({ source, width: sourceWidth, height: sourceHeight })
			: source;

	const surface = borrowSurface({
		key: SURFACE_KEYS.crop,
		width: cropRect.width,
		height: cropRect.height,
	});
	surface.ctx.drawImage(
		croppable,
		cropRect.x,
		cropRect.y,
		cropRect.width,
		cropRect.height,
		0,
		0,
		cropRect.width,
		cropRect.height,
	);
	return surface.canvas;
}

/** A decoded frame copied whole onto a canvas, which every engine sub-rects correctly. */
function copyFrameToSurface({
	source,
	width,
	height,
}: {
	source: CanvasImageSource;
	width: number;
	height: number;
}): OffscreenCanvas {
	const surface = borrowSurface({
		key: SURFACE_KEYS.cropSource,
		width,
		height,
	});
	surface.ctx.drawImage(source, 0, 0, width, height);
	return surface.canvas;
}

function fullCanvasTransform(
	renderer: CanvasRenderer,
): QuadTransformDescriptor {
	return {
		centerX: renderer.width / 2,
		centerY: renderer.height / 2,
		width: renderer.width,
		height: renderer.height,
		rotationDegrees: 0,
		flipX: false,
		flipY: false,
	};
}

function buildMaskArtifacts({
	node,
	renderer,
	path,
	transform,
	textures,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: CanvasRenderer;
	path: string;
	transform: QuadTransformDescriptor;
	textures: Map<string, TextureUploadDescriptor>;
}): {
	mask: LayerMaskDescriptor | null;
	strokeLayer: FrameItemDescriptor | null;
} {
	const transitionShape = node.resolved?.transitionShape ?? null;
	const mask = node.params.masks?.[0];
	const definition = mask ? getMaskDefinition(mask.type) : null;
	const isMaskActive =
		mask && definition ? definition.isActive?.(mask.params) !== false : false;

	if (!mask || !definition || !isMaskActive) {
		return {
			mask: transitionShape
				? buildTransitionMask({
						renderer,
						path,
						transform,
						textures,
						shape: transitionShape,
					})
				: null,
			strokeLayer: null,
		};
	}

	const { body } = definition.renderer;
	const usesOpaqueFastPath =
		body.kind === "drawWithFeather" &&
		mask.params.feather === 0 &&
		Boolean(body.opaqueFastPath);
	// drawWithFeather renderers encode feathering analytically in their canvas output
	// (e.g. split mask uses a linear gradient instead of JFA). The descriptor feather is
	// zeroed so the GPU compositor copies the mask texture as-is and does not run a second
	// JFA feather pass on top of an already-soft texture.
	const feather = body.kind === "drawWithFeather" ? 0 : mask.params.feather;

	const maskTextureId = `${path}:mask`;
	const { width: canvasWidth, height: canvasHeight } = renderer;
	const maskContentHash = `mask:${mask.type}:${JSON.stringify(mask.params)}:${transformHash(transform)}:${canvasWidth}x${canvasHeight}:body=${body.kind}:fastPath=${usesOpaqueFastPath}`;
	const drawMask: TextureCanvasDrawFn = (ctx) => {
		const { canvas: elementMaskCanvas, context: elementMaskCtx } =
			createCanvasSurface({
				width: Math.round(transform.width),
				height: Math.round(transform.height),
			});

		switch (body.kind) {
			case "fillPath": {
				const path2d = body.buildPath({
					resolvedParams: mask.params,
					width: transform.width,
					height: transform.height,
				});
				elementMaskCtx.fillStyle = "white";
				elementMaskCtx.fill(path2d);
				break;
			}
			case "drawOpaque":
				body.drawOpaque({
					resolvedParams: mask.params,
					ctx: elementMaskCtx,
					width: Math.round(transform.width),
					height: Math.round(transform.height),
				});
				break;
			case "drawWithFeather":
				if (usesOpaqueFastPath && body.opaqueFastPath) {
					const path2d = body.opaqueFastPath.buildPath({
						resolvedParams: mask.params,
						width: transform.width,
						height: transform.height,
					});
					elementMaskCtx.fillStyle = "white";
					elementMaskCtx.fill(path2d);
				} else {
					body.drawWithFeather({
						resolvedParams: mask.params,
						ctx: elementMaskCtx,
						width: Math.round(transform.width),
						height: Math.round(transform.height),
						feather: mask.params.feather,
					});
				}
				break;
		}

		if (!transitionShape) {
			drawTransformedCanvas({ ctx, source: elementMaskCanvas, transform });
			return;
		}

		// A clip can only carry one mask texture, so a mask and an in-flight
		// transition have to share it. The compositor's feather and inversion
		// passes would otherwise apply to the combined result and re-soften or
		// flip the transition reveal along with the mask, so both are resolved
		// here and the descriptor asks for neither.
		const { canvas: maskSurface, context: maskCtx } = createCanvasSurface({
			width: canvasWidth,
			height: canvasHeight,
		});
		drawTransformedCanvas({
			ctx: maskCtx,
			source: elementMaskCanvas,
			transform,
		});
		const featheredSurface =
			feather > 0
				? gpuRenderer.applyMaskFeather({
						maskCanvas: maskSurface,
						width: canvasWidth,
						height: canvasHeight,
						feather,
					})
				: maskSurface;

		if (mask.params.inverted) {
			// Alpha has no "invert" composite op: paint solid white and punch the
			// mask out of it, which leaves 1 - alpha behind.
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, canvasWidth, canvasHeight);
			ctx.globalCompositeOperation = "destination-out";
			ctx.drawImage(featheredSurface, 0, 0);
			ctx.globalCompositeOperation = "source-over";
		} else {
			ctx.drawImage(featheredSurface, 0, 0);
		}

		ctx.globalCompositeOperation = "destination-in";
		drawTransformedCanvas({
			ctx,
			source: createTransitionShapeSurface({ shape: transitionShape, transform }),
			transform,
		});
		ctx.globalCompositeOperation = "source-over";
	};
	textures.set(maskTextureId, {
		kind: "rendered",
		id: maskTextureId,
		contentHash: transitionShape
			? `${maskContentHash}:transition=${JSON.stringify(transitionShape)}`
			: maskContentHash,
		width: canvasWidth,
		height: canvasHeight,
		draw: drawMask,
	});

	const stroke = definition.renderer.stroke;
	const hasStroke = mask.params.strokeWidth > 0 && Boolean(stroke);
	let strokeLayer: FrameItemDescriptor | null = null;
	if (hasStroke && stroke) {
		const strokeTextureId = `${path}:mask-stroke`;
		const strokeContentHash = `stroke:${mask.type}:${JSON.stringify(mask.params)}:${transformHash(transform)}:${canvasWidth}x${canvasHeight}:stroke=${stroke.kind}`;
		const drawStroke: TextureCanvasDrawFn = (ctx) => {
			const { canvas: strokeCanvas, context: strokeCtx } = createCanvasSurface({
				width: Math.round(transform.width),
				height: Math.round(transform.height),
			});

			switch (stroke.kind) {
				case "renderStroke":
					stroke.renderStroke({
						resolvedParams: mask.params,
						ctx: strokeCtx,
						width: transform.width,
						height: transform.height,
					});
					break;
				case "strokeFromPath": {
					const strokePath = stroke.buildStrokePath({
						resolvedParams: mask.params,
						width: transform.width,
						height: transform.height,
					});
					strokeCtx.strokeStyle = mask.params.strokeColor;
					strokeCtx.lineWidth = mask.params.strokeWidth;
					strokeCtx.stroke(strokePath);
					break;
				}
			}

			drawTransformedCanvas({ ctx, source: strokeCanvas, transform });
		};
		textures.set(strokeTextureId, {
			kind: "rendered",
			id: strokeTextureId,
			contentHash: strokeContentHash,
			width: canvasWidth,
			height: canvasHeight,
			draw: drawStroke,
		});
		strokeLayer = {
			type: "layer",
			textureId: strokeTextureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		};
	}

	return {
		mask: transitionShape
			? { textureId: maskTextureId, feather: 0, inverted: false }
			: {
					textureId: maskTextureId,
					feather,
					inverted: mask.params.inverted,
				},
		strokeLayer,
	};
}

/**
 * The reveal mask for a clip that has no mask of its own. Softness is already
 * baked into the gradient by `drawTransitionShape`, so the descriptor asks for
 * no feather — the compositor's feather pass runs a jump-flood over a binary
 * mask and would re-harden then re-soften the edge.
 */
function buildTransitionMask({
	renderer,
	path,
	transform,
	textures,
	shape,
}: {
	renderer: CanvasRenderer;
	path: string;
	transform: QuadTransformDescriptor;
	textures: Map<string, TextureUploadDescriptor>;
	shape: TransitionShape;
}): LayerMaskDescriptor {
	const textureId = `${path}:transition-mask`;
	const { width: canvasWidth, height: canvasHeight } = renderer;

	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash: `transition-mask:${JSON.stringify(shape)}:${transformHash(transform)}:${canvasWidth}x${canvasHeight}`,
		width: canvasWidth,
		height: canvasHeight,
		draw: (ctx) => {
			drawTransformedCanvas({
				ctx,
				source: createTransitionShapeSurface({ shape, transform }),
				transform,
			});
		},
	});

	return { textureId, feather: 0, inverted: false };
}

/**
 * Rasterises a transition's reveal geometry in the layer's own pixel box, ready
 * to be transformed onto the frame the same way a mask shape is.
 */
function createTransitionShapeSurface({
	shape,
	transform,
}: {
	shape: TransitionShape;
	transform: QuadTransformDescriptor;
}): OffscreenCanvas {
	const width = Math.max(1, Math.round(transform.width));
	const height = Math.max(1, Math.round(transform.height));
	const { canvas, context } = createCanvasSurface({ width, height });
	drawTransitionShape({ ctx: context, shape, width, height });
	return canvas;
}

function drawTransformedCanvas({
	ctx,
	source,
	transform,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	source: CanvasImageSource;
	transform: QuadTransformDescriptor;
}) {
	const x = transform.centerX - transform.width / 2;
	const y = transform.centerY - transform.height / 2;
	const flipX = transform.flipX ? -1 : 1;
	const flipY = transform.flipY ? -1 : 1;
	const requiresTransform =
		transform.rotationDegrees !== 0 || flipX !== 1 || flipY !== 1;

	ctx.save();
	if (requiresTransform) {
		ctx.translate(transform.centerX, transform.centerY);
		ctx.rotate((transform.rotationDegrees * Math.PI) / 180);
		ctx.scale(flipX, flipY);
		ctx.translate(-transform.centerX, -transform.centerY);
	}
	ctx.drawImage(source, x, y, transform.width, transform.height);
	ctx.restore();
}

function transformHash(transform: QuadTransformDescriptor): string {
	return `${transform.centerX}:${transform.centerY}:${transform.width}:${transform.height}:${transform.rotationDegrees}:${transform.flipX ? 1 : 0}:${transform.flipY ? 1 : 0}`;
}

// Stable identity key for CanvasImageSource. Using a WeakMap → counter keeps
// hash string length bounded and avoids holding sources alive.
const identityKeys = new WeakMap<object, number>();
let nextIdentity = 1;
function identityKey(source: CanvasImageSource): string {
	if (typeof source === "object" && source !== null) {
		let key = identityKeys.get(source);
		if (key === undefined) {
			key = nextIdentity++;
			identityKeys.set(source, key);
		}
		return `@${key}`;
	}
	return "@?";
}
