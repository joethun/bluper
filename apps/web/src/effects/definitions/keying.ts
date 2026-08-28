import { mapPixels } from "../canvas";
import { parseColorToLinearRgba } from "@/params";
import type { EffectDefinition } from "../types";
import { numberValue, selectParam, stringValue } from "./shared";

/**
 * Difference key, the way After Effects and OBS cut a chroma key: each pixel is
 * projected onto the key colour's 3D line in RGB space, and the perpendicular
 * distance to that line drives the matte. Background pixels land on the line
 * regardless of how bright or dim the lighting was — a darker corner of the
 * screen and a brighter corner both sit on the same line, so a single slider
 * setting cuts them both, where a single-point distance metric leaves one
 * half-cut.
 *
 * Pixels that aren't similar enough to the key to be the screen are kept
 * whatever their perpendicular distance. A black subject pixel sits at the
 * origin and therefore on the key line; without that floor it would be keyed
 * out, taking a chunk of the subject with it.
 *
 * Surviving pixels are despilled — the green channel is pulled toward the
 * average of red and blue — to take the green cast the screen leaves on the
 * subject off the edges where the matte is mostly opaque.
 */

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
		{
			key: "spillReduction",
			label: "Spill reduction",
			type: "number",
			default: 0.5,
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
		const spillReduction = numberValue({
			params,
			key: "spillReduction",
			fallback: 0.5,
		});

		const parsed = parseColorToLinearRgba({ color: keyColor });
		// `parseColorToLinearRgba` returns linear light; the frame's bytes are
		// sRGB, so the key is taken back to the same space the pixels are
		// measured in. The comparison itself runs in 0..1 floats — the shader
		// the canvas path mirrors reads normalised space — so the bytes are
		// scaled down once here, not per pixel.
		const toByte = (value: number) =>
			255 *
			(value <= 0.0031308
				? value * 12.92
				: 1.055 * Math.pow(value, 1 / 2.4) - 0.055);
		const inv255 = 1 / 255;
		const key = parsed
			? {
					red: toByte(parsed.r) * inv255,
					green: toByte(parsed.g) * inv255,
					blue: toByte(parsed.b) * inv255,
				}
			: { red: 0, green: 210 * inv255, blue: 30 * inv255 };

		const keyLen = Math.hypot(key.red, key.green, key.blue);
		const keyNx = key.red / keyLen;
		const keyNy = key.green / keyLen;
		const keyNz = key.blue / keyLen;

		// 0.8 covers the perpendicular distance a real green-screen clip
		// reaches in normalised RGB; the slider spans from "only this exact
		// colour" to "most of the colour wheel". The minimum band width is a
		// small float rather than 1 to keep the slider's zero end at zero.
		const near = tolerance * 0.8;
		const band = Math.max(1e-3, softness * 0.8);
		const far = near + band;
		const nearSquared = near * near;
		const farSquared = far * far;
		const minProj = 0.25 * keyLen;
		const doSpill = spillReduction > 0;

		mapPixels({
			ctx,
			source,
			width,
			height,
			map: (pixels) => {
				for (let index = 0; index < pixels.length; index += 4) {
					const alpha = pixels[index + 3];
					if (alpha === 0) continue;

					const rByte = pixels[index];
					const gByte = pixels[index + 1];
					const bByte = pixels[index + 2];
					const r = rByte * inv255;
					const g = gByte * inv255;
					const b = bByte * inv255;

					const proj = r * keyNx + g * keyNy + b * keyNz;
					const background = proj >= minProj;

					if (background) {
						const perpR = r - proj * keyNx;
						const perpG = g - proj * keyNy;
						const perpB = b - proj * keyNz;
						const perpLenSquared =
							perpR * perpR + perpG * perpG + perpB * perpB;

						if (perpLenSquared <= nearSquared) {
							pixels[index + 3] = 0;
							continue;
						}
						if (perpLenSquared < farSquared) {
							const perpLen = Math.sqrt(perpLenSquared);
							const t = (perpLen - near) / band;
							pixels[index + 3] = alpha * (t * t * (3 - 2 * t));
						}
						// Beyond the band the alpha is left as it was — the
						// pixel is foreground, untouched.
					}

					// Despill — applied only to pixels the key kept, and only
					// where the green channel sits above the red/blue average
					// that would read as neutral. Cut pixels already continue
					// above, so they never reach here.
					if (doSpill) {
						const neutral = (r + b) * 0.5;
						if (g > neutral) {
							const excess = g - neutral;
							pixels[index + 1] = (g - excess * spillReduction) * 255;
						}
					}
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
