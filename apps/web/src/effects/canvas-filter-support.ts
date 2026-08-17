/**
 * Whether this engine's `CanvasRenderingContext2D.filter` actually filters.
 *
 * WebKitGTK — the webview behind the desktop shell — implements the property
 * as a setter that parses and reads back but never affects a draw. That makes
 * feature detection by `"filter" in ctx` useless: it's there, it round-trips,
 * and it does nothing. The only reliable probe is to draw with it and look at
 * the pixels, which is what this does, once, on a 1x1 canvas.
 */

let supported: boolean | null = null;

function probe(): boolean {
	try {
		const canvas =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(1, 1)
				: typeof document !== "undefined"
					? Object.assign(document.createElement("canvas"), {
							width: 1,
							height: 1,
						})
					: null;
		if (!canvas) return false;

		const ctx = (
			canvas as OffscreenCanvas | HTMLCanvasElement
		).getContext("2d", {
			willReadFrequently: true,
		}) as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!ctx) return false;

		ctx.fillStyle = "rgb(64, 64, 64)";
		ctx.fillRect(0, 0, 1, 1);
		const before = ctx.getImageData(0, 0, 1, 1).data[0];

		ctx.filter = "brightness(2)";
		ctx.fillRect(0, 0, 1, 1);
		const after = ctx.getImageData(0, 0, 1, 1).data[0];

		// A working implementation lands near 128; an inert one stays at 64.
		return after > before + 32;
	} catch {
		return false;
	}
}

export function supportsCanvasFilter(): boolean {
	if (supported === null) supported = probe();
	return supported;
}
