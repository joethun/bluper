import { mapPixels, smoothstep } from "../canvas";
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

function luminance({
	red,
	green,
	blue,
}: {
	red: number;
	green: number;
	blue: number;
}): number {
	return (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
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

		mapPixels({
			ctx,
			source,
			width,
			height,
			map: (pixels) => {
				for (let index = 0; index < pixels.length; index += 4) {
					const red = pixels[index];
					const green = pixels[index + 1];
					const blue = pixels[index + 2];
					const chroma = chromaCoordinates({ red, green, blue });
					const distance = Math.hypot(
						chroma.u - keyChroma.u,
						chroma.v - keyChroma.v,
					);
					const keep = smoothstep({ edge0: near, edge1: far, value: distance });
					pixels[index + 3] = pixels[index + 3] * keep;
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

		mapPixels({
			ctx,
			source,
			width,
			height,
			map: (pixels) => {
				for (let index = 0; index < pixels.length; index += 4) {
					const lum = luminance({
						red: pixels[index],
						green: pixels[index + 1],
						blue: pixels[index + 2],
					});
					const keep = removeWhite
						? 1 -
							smoothstep({
								edge0: 1 - threshold - feather,
								edge1: 1 - threshold,
								value: lum,
							})
						: smoothstep({
								edge0: threshold,
								edge1: threshold + feather,
								value: lum,
							});
					pixels[index + 3] = pixels[index + 3] * keep;
				}
			},
		});
	},
};
