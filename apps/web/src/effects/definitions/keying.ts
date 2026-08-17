import { mapPixels } from "../canvas";
import { parseColorToLinearRgba } from "@/params";
import type { EffectDefinition } from "../types";
import { numberValue, selectParam, stringValue } from "./shared";

/**
 * Keying compares colour, not brightness, so the comparison runs in YUV: a green
 * screen lit unevenly still sits at one place in the UV plane even where its
 * luminance swings by half a stop.
 */
function chromaCoordinates({
	red,
	green,
	blue,
}: {
	red: number;
	green: number;
	blue: number;
}): { u: number; v: number } {
	const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
	return { u: blue - luma, v: red - luma };
}

export const greenScreenEffect: EffectDefinition = {
	type: "green-screen",
	name: "Green screen",
	keywords: ["green screen", "chroma key", "key", "cutout", "background"],
	params: [
		{
			key: "keyColor",
			label: "Key color",
			type: "color",
			default: "#00d21e",
			keyframable: false,
			// Sampled off the preview: the green that matters is the one the shot was
			// actually lit against, not one chosen by eye off a gradient.
			control: "eyedropper",
		},
		{
			key: "tolerance",
			label: "Tolerance",
			type: "number",
			default: 0.32,
			min: 0,
			max: 1,
			step: 0.01,
			unit: "percent",
			control: "slider",
		},
		{
			key: "softness",
			label: "Softness",
			type: "number",
			default: 0.16,
			min: 0,
			max: 1,
			step: 0.01,
			unit: "percent",
			control: "slider",
		},
	],
	paint: ({ ctx, source, width, height, params }) => {
		const keyColor = stringValue({
			params,
			key: "keyColor",
			fallback: "#00d21e",
		});
		const tolerance = numberValue({ params, key: "tolerance", fallback: 0.32 });
		const softness = numberValue({ params, key: "softness", fallback: 0.16 });

		const parsed = parseColorToLinearRgba({ color: keyColor });
		// `parseColorToLinearRgba` returns linear light; the frame's bytes are sRGB,
		// so the key is taken back to the same space the pixels are measured in.
		const toByte = (value: number) =>
			255 *
			(value <= 0.0031308
				? value * 12.92
				: 1.055 * Math.pow(value, 1 / 2.4) - 0.055);
		const key = parsed
			? { red: toByte(parsed.r), green: toByte(parsed.g), blue: toByte(parsed.b) }
			: { red: 0, green: 210, blue: 30 };
		const keyChroma = chromaCoordinates(key);
		// 180 is roughly the widest chroma distance an 8-bit frame can reach, so the
		// slider spans "only this exact colour" to "most of the colour wheel".
		const near = tolerance * 180;
		const far = near + Math.max(1, softness * 180);

		// The inner loop runs two million times on a 1080p frame, thirty times a
		// second, so everything that can leave it has: the key's coordinates are
		// lifted out, the chroma maths is written inline rather than through
		// helpers that would allocate a point per pixel, and the band edges are
		// pre-squared. Most pixels are either plainly the key colour or plainly not,
		// and those two answers need no square root at all — only the soft edge in
		// between does. Together that is the difference between playback that keeps
		// up and playback that does not.
		const keyU = keyChroma.u;
		const keyV = keyChroma.v;
		const nearSquared = near * near;
		const farSquared = far * far;
		const band = far - near;

		mapPixels({
			ctx,
			source,
			width,
			height,
			map: (pixels) => {
				for (let index = 0; index < pixels.length; index += 4) {
					const alpha = pixels[index + 3];
					if (alpha === 0) continue;

					const red = pixels[index];
					const green = pixels[index + 1];
					const blue = pixels[index + 2];
					const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
					const deltaU = blue - luma - keyU;
					const deltaV = red - luma - keyV;
					const distanceSquared = deltaU * deltaU + deltaV * deltaV;

					if (distanceSquared <= nearSquared) {
						pixels[index + 3] = 0;
						continue;
					}
					if (distanceSquared >= farSquared) continue;

					const t = (Math.sqrt(distanceSquared) - near) / band;
					pixels[index + 3] = alpha * (t * t * (3 - 2 * t));
				}
			},
		});
	},
};

export const blackWhiteRemovalEffect: EffectDefinition = {
	type: "black-white-removal",
	name: "Black/white removal",
	keywords: [
		"black",
		"white",
		"removal",
		"luma key",
		"cutout",
		"transparent",
	],
	params: [
		selectParam({
			key: "mode",
			label: "Remove",
			value: "black",
			options: [
				{ value: "black", label: "Black" },
				{ value: "white", label: "White" },
			],
		}),
		{
			key: "threshold",
			label: "Threshold",
			type: "number",
			default: 0.25,
			min: 0,
			max: 1,
			step: 0.01,
			unit: "percent",
			control: "slider",
		},
		{
			key: "softness",
			label: "Softness",
			type: "number",
			default: 0.2,
			min: 0,
			max: 1,
			step: 0.01,
			unit: "percent",
			control: "slider",
		},
	],
	paint: ({ ctx, source, width, height, params }) => {
		const removeWhite = params.mode === "white";
		const threshold = numberValue({ params, key: "threshold", fallback: 0.25 });
		const softness = numberValue({ params, key: "softness", fallback: 0.2 });
		const feather = Math.max(0.001, softness * 0.5);

		// Same shape as the chroma key above, and the same reason for it: the band
		// edges are lifted out of the loop, and a pixel clear of the ramp on either
		// side is answered without interpolating.
		const edge0 = removeWhite ? 1 - threshold - feather : threshold;
		const edge1 = removeWhite ? 1 - threshold : threshold + feather;
		const band = edge1 - edge0;
		const belowKeep = removeWhite ? 1 : 0;
		const aboveKeep = removeWhite ? 0 : 1;

		mapPixels({
			ctx,
			source,
			width,
			height,
			map: (pixels) => {
				for (let index = 0; index < pixels.length; index += 4) {
					const alpha = pixels[index + 3];
					if (alpha === 0) continue;

					const lum =
						(0.299 * pixels[index] +
							0.587 * pixels[index + 1] +
							0.114 * pixels[index + 2]) /
						255;

					if (lum <= edge0) {
						if (belowKeep === 0) pixels[index + 3] = 0;
						continue;
					}
					if (lum >= edge1) {
						if (aboveKeep === 0) pixels[index + 3] = 0;
						continue;
					}

					const t = (lum - edge0) / band;
					const ramp = t * t * (3 - 2 * t);
					pixels[index + 3] = alpha * (removeWhite ? 1 - ramp : ramp);
				}
			},
		});
	},
};
