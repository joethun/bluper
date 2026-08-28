import { type ComponentProps, forwardRef, useEffect, useRef, useState } from "react";
import { cn } from "@/utils/ui";
import { Input } from "./input";
import {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverTrigger,
} from "./popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./select";
import { Button } from "./button";
import { ColorSampleStrip } from "./color-sample-strip";
import { PipetteIcon, XIcon } from "lucide-react";
import {
	type ColorFormat,
	appendAlpha,
	extractColorFromText,
	formatColorValue,
	hexToHsv,
	hsvToHex,
	parseColorInput,
	parseHexAlpha,
} from "@/wasm/color";

const CHECKERBOARD_STYLE = {
	backgroundImage: `
    linear-gradient(45deg, rgba(0,0,0,0.1) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(0,0,0,0.1) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.1) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.1) 75%)
  `,
	backgroundSize: "8px 8px",
	backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px",
	backgroundColor: "#fff",
} as const;

interface ColorPickerContentProps {
	value?: string;
	onChange?: (value: string) => void;
	onChangeEnd?: (value: string) => void;
	side?: ComponentProps<typeof PopoverContent>["side"];
	align?: ComponentProps<typeof PopoverContent>["align"];
	sampleLabel?: string;
	onRequestSampleImage?: () => Promise<string | null>;
}

function ColorPickerContent({
	value = "FFFFFF",
	onChange,
	onChangeEnd,
	side = "left",
	align = "center",
	sampleLabel = "color",
	onRequestSampleImage,
}: ColorPickerContentProps) {
	// The still to sample from, fetched when the eyedropper is switched on rather
	// than up front: rendering a frame costs a full composite, and most opens of
	// this popover never touch the eyedropper.
	const [sampleImageUrl, setSampleImageUrl] = useState<string | null>(null);
	const [isSampling, setIsSampling] = useState(false);
	const [isDragging, setIsDragging] = useState<
		"saturation" | "hue" | "opacity" | null
	>(null);
	const [internalHue, setInternalHue] = useState(0);
	const [inputValue, setInputValue] = useState(value);
	const [colorFormat, setColorFormat] = useState<ColorFormat>("hex");

	const saturationRef = useRef<HTMLButtonElement>(null);
	const hueRef = useRef<HTMLButtonElement>(null);
	const opacityRef = useRef<HTMLButtonElement>(null);
	const latestDragColorRef = useRef<string | null>(null);

	const isEyeDropperSupported =
		typeof window !== "undefined" && "EyeDropper" in window;

	const { rgb: rgbValue, alpha } = parseHexAlpha({ hex: value });
	const [h, s, v] = hexToHsv({ hex: rgbValue });

	const hueDiff = Math.abs(h - internalHue);
	const isSameHueWrapped = hueDiff < 1 || Math.abs(hueDiff - 360) < 1;
	const displayHue = s === 0 || isSameHueWrapped ? internalHue : h;

	useEffect(() => {
		setInputValue(formatColorValue({ hex: value, format: colorFormat }));
	}, [value, colorFormat]);

	useEffect(() => {
		const handleMouseMove = (event: MouseEvent) => {
			if (!isDragging) return;

			if (isDragging === "saturation" && saturationRef.current) {
				const rect = saturationRef.current.getBoundingClientRect();
				const x = Math.max(
					0,
					Math.min(1, (event.clientX - rect.left) / rect.width),
				);
				const y = Math.max(
					0,
					Math.min(1, (event.clientY - rect.top) / rect.height),
				);
				const newHex = appendAlpha({
					rgbHex: hsvToHex({ h: displayHue, s: x, v: 1 - y }),
					alpha,
				});
				latestDragColorRef.current = newHex;
				onChange?.(newHex);
			}

			if (isDragging === "hue" && hueRef.current) {
				const rect = hueRef.current.getBoundingClientRect();
				const x = Math.max(
					0,
					Math.min(1, (event.clientX - rect.left) / rect.width),
				);
				const newH = x * 360;
				setInternalHue(newH);
				if (s > 0) {
					const newHex = appendAlpha({
						rgbHex: hsvToHex({ h: newH, s, v }),
						alpha,
					});
					latestDragColorRef.current = newHex;
					onChange?.(newHex);
				}
			}

			if (isDragging === "opacity" && opacityRef.current) {
				const rect = opacityRef.current.getBoundingClientRect();
				const x = Math.max(
					0,
					Math.min(1, (event.clientX - rect.left) / rect.width),
				);
				const newHex = appendAlpha({ rgbHex: rgbValue, alpha: x });
				latestDragColorRef.current = newHex;
				onChange?.(newHex);
			}
		};

		const handleMouseUp = () => {
			if (latestDragColorRef.current !== null && onChangeEnd) {
				onChangeEnd(latestDragColorRef.current);
				latestDragColorRef.current = null;
			}
			setIsDragging(null);
		};

		if (isDragging) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
			return () => {
				document.removeEventListener("mousemove", handleMouseMove);
				document.removeEventListener("mouseup", handleMouseUp);
			};
		}
	}, [isDragging, displayHue, s, v, alpha, rgbValue, onChange, onChangeEnd]);

	const commitSampledHex = ({ hex }: { hex: string }) => {
		const finalHex = appendAlpha({
			rgbHex: hex.replace("#", "").toLowerCase(),
			alpha,
		});
		onChange?.(finalHex);
		onChangeEnd?.(finalHex);
	};

	const handleNativeEyeDropper = async () => {
		if (!isEyeDropperSupported || !EyeDropper) return;
		try {
			const dropper = new EyeDropper();
			const result = await dropper.open();
			commitSampledHex({ hex: result.sRGBHex });
		} catch {
			// user cancelled the picker
		}
	};

	const handleSampleFromFrame = async () => {
		if (isSampling) {
			setIsSampling(false);
			return;
		}
		const url = await onRequestSampleImage?.();
		if (!url) return;
		setSampleImageUrl(url);
		setIsSampling(true);
	};

	// Sampling the frame is preferred wherever a caller offers it: it reads the
	// picture's own pixels, it names what is being picked, and unlike the native
	// `EyeDropper` it exists on every engine the editor runs on — WebKitGTK, which
	// the desktop shell uses, has no `EyeDropper` at all.
	const canSampleFrame = Boolean(onRequestSampleImage);
	const canPickColor = canSampleFrame || isEyeDropperSupported;
	const handleEyeDropper = canSampleFrame
		? handleSampleFromFrame
		: handleNativeEyeDropper;

	const handleSaturationMouseDown = (event: React.MouseEvent) => {
		event.preventDefault();
		const saturationElement = saturationRef.current;
		if (!saturationElement) return;
		setIsDragging("saturation");
		const rect = saturationElement.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
		const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
		const newHex = appendAlpha({
			rgbHex: hsvToHex({ h: displayHue, s: x, v: 1 - y }),
			alpha,
		});
		latestDragColorRef.current = newHex;
		onChange?.(newHex);
	};

	const handleHueMouseDown = (event: React.MouseEvent) => {
		event.preventDefault();
		const hueElement = hueRef.current;
		if (!hueElement) return;
		setIsDragging("hue");
		const rect = hueElement.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
		const newH = x * 360;
		setInternalHue(newH);
		if (s > 0) {
			const newHex = appendAlpha({
				rgbHex: hsvToHex({ h: newH, s, v }),
				alpha,
			});
			latestDragColorRef.current = newHex;
			onChange?.(newHex);
		}
	};

	const handleOpacityMouseDown = (event: React.MouseEvent) => {
		event.preventDefault();
		const opacityElement = opacityRef.current;
		if (!opacityElement) return;
		setIsDragging("opacity");
		const rect = opacityElement.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
		const newHex = appendAlpha({ rgbHex: rgbValue, alpha: x });
		latestDragColorRef.current = newHex;
		onChange?.(newHex);
	};

	const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setInputValue(
			colorFormat === "hex"
				? event.target.value.replace("#", "")
				: event.target.value,
		);
	};

	const commitInputValue = () => {
		const parsed = parseColorInput({ input: inputValue, format: colorFormat });
		if (parsed) {
			const nextHex = appendAlpha({ rgbHex: parsed, alpha });
			onChange?.(nextHex);
			onChangeEnd?.(nextHex);
			return;
		}

		const extracted = extractColorFromText({ text: inputValue });
		if (extracted) {
			const hasExplicitAlpha = extracted.length > 6;
			const finalHex = hasExplicitAlpha
				? extracted
				: appendAlpha({ rgbHex: extracted, alpha });
			onChange?.(finalHex);
			onChangeEnd?.(finalHex);
		}
	};

	const handleInputBlur = () => commitInputValue();

	const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			commitInputValue();
			event.currentTarget.blur();
		}
	};

	const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
		const pastedText = event.clipboardData.getData("text");
		const extractedHex = extractColorFromText({ text: pastedText });
		if (!extractedHex) return;

		event.preventDefault();
		const hasExplicitAlpha = extractedHex.length > 6;
		const finalHex = hasExplicitAlpha
			? extractedHex
			: appendAlpha({ rgbHex: extractedHex, alpha });
		onChange?.(finalHex);
		onChangeEnd?.(finalHex);
	};

	const saturationStyle = {
		background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${displayHue}, 100%, 50%))`,
	};

	const hueStyle = {
		background:
			"linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
	};

	return (
		<PopoverContent
			className="w-64 px-0 select-none flex flex-col gap-3 py-2"
			side={side}
			align={align}
			sideOffset={8}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
			}}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
			}}
			onInteractOutside={(event) => {
				if (isDragging) event.preventDefault();
			}}
		>
			<header className="border-b flex justify-between items-center pb-2 px-2">
				<Select defaultValue="custom">
					<SelectTrigger variant="outline">
						<SelectValue placeholder="Select a mode" />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value="custom">Custom</SelectItem>
						<SelectItem value="saved">Saved</SelectItem>
					</SelectContent>
				</Select>
				<div>
					{canPickColor && (
						<Button
							variant={isSampling ? "secondary" : "ghost"}
							size="icon"
							type="button"
							aria-label={`Sample ${sampleLabel} from the frame`}
							aria-pressed={canSampleFrame ? isSampling : undefined}
							title={`Sample ${sampleLabel} from the frame`}
							onClick={() => void handleEyeDropper()}
						>
							<PipetteIcon />
						</Button>
					)}
					<PopoverClose asChild>
						<Button variant="ghost" size="icon" type="button">
							<XIcon />
						</Button>
					</PopoverClose>
				</div>
			</header>
			{isSampling && sampleImageUrl && (
				<div className="flex flex-col gap-1 px-2">
					<ColorSampleStrip
						imageUrl={sampleImageUrl}
						label={sampleLabel}
						onSample={(color) => {
							commitSampledHex({ hex: color });
							setIsSampling(false);
						}}
					/>
					<p className="text-muted-foreground text-xs">
						Click the colour you want.
					</p>
				</div>
			)}
			<div className="px-2 flex flex-col gap-3">
				<button
					ref={saturationRef}
					className="relative h-44 aspect-square w-full appearance-none border-0 bg-transparent p-0"
					style={saturationStyle}
					type="button"
					onMouseDown={handleSaturationMouseDown}
				>
					<ColorCircle
						size="sm"
						position={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
						color={`#${value}`}
					/>
				</button>

				<button
					ref={hueRef}
					className="relative h-4 w-full rounded-lg appearance-none border-0 bg-transparent p-0"
					style={hueStyle}
					type="button"
					onMouseDown={handleHueMouseDown}
				>
					<ColorCircle
						size="md"
						position={{
							left: `calc(0.5rem + (100% - 1rem) * ${displayHue / 360})`,
							top: "50%",
						}}
					/>
				</button>

				<button
					ref={opacityRef}
					className="relative h-4 w-full overflow-hidden rounded-lg appearance-none border-0 p-0"
					type="button"
					onMouseDown={handleOpacityMouseDown}
				>
					<div className="absolute inset-0 dark:invert" style={CHECKERBOARD_STYLE} />
					<div
						className="absolute inset-0 rounded-lg"
						style={{
							background: `linear-gradient(to right, transparent, #${rgbValue})`,
						}}
					/>
					<ColorCircle
						size="md"
						position={{
							left: `calc(0.5rem + (100% - 1rem) * ${alpha})`,
							top: "50%",
						}}
					/>
				</button>

				<div className="flex items-center gap-2">
					<Select
						value={colorFormat}
						onValueChange={(selectedFormat) =>
							setColorFormat(selectedFormat as ColorFormat)
						}
					>
						<SelectTrigger variant="outline" className="min-w-18 max-w-18">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="hex">HEX</SelectItem>
							<SelectItem value="rgb">RGB</SelectItem>
							<SelectItem value="hsl">HSL</SelectItem>
							<SelectItem value="hsv">HSV</SelectItem>
						</SelectContent>
					</Select>

					<Input
						className={cn(
							"h-7 rounded-sm p-2.5",
							colorFormat === "hex" && "uppercase",
						)}
						type="text"
						value={inputValue}
						onChange={handleInputChange}
						onBlur={handleInputBlur}
						onKeyDown={handleInputKeyDown}
						onPaste={handlePaste}
					/>
				</div>
			</div>
		</PopoverContent>
	);
}

interface ColorPickerProps {
	value?: string;
	onChange?: (value: string) => void;
	onChangeEnd?: (value: string) => void;
	className?: string;
	contentSide?: ComponentProps<typeof PopoverContent>["side"];
	contentAlign?: ComponentProps<typeof PopoverContent>["align"];
	sampleLabel?: string;
	onRequestSampleImage?: () => Promise<string | null>;
}

const ColorPicker = forwardRef<HTMLDivElement, ColorPickerProps>(
	(
		{
			className,
			value = "FFFFFF",
			onChange,
			onChangeEnd,
			contentSide,
			contentAlign,
			sampleLabel,
			onRequestSampleImage,
			...props
		},
		ref,
	) => {
		const { alpha } = parseHexAlpha({ hex: value });

		const [inputValue, setInputValue] = useState(value);

		useEffect(() => {
			setInputValue(value);
		}, [value]);

		const commitInputValue = (raw: string) => {
			const input = raw.replace("#", "");
			const parsed = parseColorInput({ input, format: "hex" });
			if (parsed) {
				const nextHex = appendAlpha({ rgbHex: parsed, alpha });
				onChange?.(nextHex);
				onChangeEnd?.(nextHex);
				return;
			}
			const extracted = extractColorFromText({ text: input });
			if (extracted) {
				const hasExplicitAlpha = extracted.length > 6;
				const finalHex = hasExplicitAlpha
					? extracted
					: appendAlpha({ rgbHex: extracted, alpha });
				onChange?.(finalHex);
				onChangeEnd?.(finalHex);
			}
		};

		const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
			setInputValue(event.target.value.replace("#", ""));
		};

		const handleInputBlur = () => commitInputValue(inputValue);

		const handleInputKeyDown = (
			event: React.KeyboardEvent<HTMLInputElement>,
		) => {
			if (event.key === "Enter") {
				commitInputValue(inputValue);
				event.currentTarget.blur();
			}
		};

		const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
			const pastedText = event.clipboardData.getData("text");
			const extractedHex = extractColorFromText({ text: pastedText });
			if (!extractedHex) return;
			event.preventDefault();
			const hasExplicitAlpha = extractedHex.length > 6;
			const finalHex = hasExplicitAlpha
				? extractedHex
				: appendAlpha({ rgbHex: extractedHex, alpha });
			onChange?.(finalHex);
			onChangeEnd?.(finalHex);
		};

		return (
			<Popover>
				<div
					ref={ref}
					className={cn(
						"bg-accent flex h-7 border flex-1 items-center gap-2 rounded-md px-[0.45rem]",
						className,
					)}
					{...props}
				>
					<PopoverTrigger asChild>
						<button
							className="size-4.5 relative cursor-pointer overflow-hidden rounded-sm border hover:ring-1 hover:ring-foreground/20"
							type="button"
						>
							<span
								className="absolute inset-0 dark:invert"
								style={CHECKERBOARD_STYLE}
							/>
							<span
								className="absolute inset-0"
								style={{ backgroundColor: `#${value}` }}
							/>
						</button>
					</PopoverTrigger>
					<div className="flex flex-1 items-center">
						<Input
							className="border-0! bg-transparent p-0 ring-0! ring-offset-0! uppercase"
							size="sm"
							containerClassName="w-full"
							value={inputValue}
							onChange={handleInputChange}
							onBlur={handleInputBlur}
							onKeyDown={handleInputKeyDown}
							onPaste={handlePaste}
						/>
					</div>
				</div>
				<ColorPickerContent
					value={value}
					onChange={onChange}
					onChangeEnd={onChangeEnd}
					side={contentSide}
					align={contentAlign}
					sampleLabel={sampleLabel}
					onRequestSampleImage={onRequestSampleImage}
				/>
			</Popover>
		);
	},
);
ColorPicker.displayName = "ColorPicker";

const ColorCircle = ({
	size,
	position,
	color,
}: {
	size: "sm" | "md";
	position: { left: string; top: string };
	color?: string;
}) => (
	<div
		className={cn(
			"pointer-events-none absolute rounded-full border-3 border-white shadow-lg",
			size === "sm" ? "size-3" : "size-4",
		)}
		style={{
			left: position.left,
			top: position.top,
			transform: "translate(-50%, -50%)",
			backgroundColor: color,
		}}
	/>
);

export { ColorPicker };
