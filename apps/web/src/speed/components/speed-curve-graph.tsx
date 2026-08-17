"use client";

import { useRef, useState, type PointerEvent } from "react";
import { RotateCcwIcon, MinusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useShiftKey } from "@/hooks/use-shift-key";
import {
	MAX_CURVE_POINTS,
	MAX_CURVE_RATE,
	MIN_CURVE_RATE,
	clampCurveRate,
	getCurveRateAtPosition,
	sampleCurveRates,
	sanitizeRetimeCurve,
} from "@/retime";
import type { RetimeCurve, RetimeCurvePoint } from "@/timeline";
import { cn } from "@/utils/ui";

const PLOT_WIDTH = 176;
const PLOT_HEIGHT = 92;
const PAD_LEFT = 26;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 10;
const SVG_WIDTH = PAD_LEFT + PLOT_WIDTH + PAD_RIGHT;
const SVG_HEIGHT = PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM;

const HANDLE_RADIUS = 4;
const CURVE_SEGMENTS = 96;

/**
 * Keep handles from stacking, in the same units the curve stores. Deliberately
 * wider than the spacing at which the model merges two handles: a drag can then
 * never collapse one into its neighbour and shift the indices out from under the
 * pointer mid-drag.
 */
const MIN_HANDLE_GAP = 0.02;

/** How close to 1x a drag has to land to be treated as exactly 1x, in octaves. */
const RATE_SNAP_OCTAVES = 0.08;

const LOG_MIN = Math.log(MIN_CURVE_RATE);
const LOG_MAX = Math.log(MAX_CURVE_RATE);

const GRID_RATES = [MAX_CURVE_RATE, 3, 1, 1 / 3, MIN_CURVE_RATE];
const AXIS_LABELS = [
	{ rate: MAX_CURVE_RATE, label: `${MAX_CURVE_RATE}x` },
	{ rate: 1, label: "1x" },
	{ rate: MIN_CURVE_RATE, label: `${MIN_CURVE_RATE}x` },
];

function toX({ position }: { position: number }): number {
	return PAD_LEFT + position * PLOT_WIDTH;
}

function toY({ rate }: { rate: number }): number {
	const fraction = (Math.log(rate) - LOG_MIN) / (LOG_MAX - LOG_MIN);
	return PAD_TOP + (1 - Math.min(1, Math.max(0, fraction))) * PLOT_HEIGHT;
}

function fromX({ svgX }: { svgX: number }): number {
	return Math.min(1, Math.max(0, (svgX - PAD_LEFT) / PLOT_WIDTH));
}

function fromY({ svgY }: { svgY: number }): number {
	const fraction = Math.min(
		1,
		Math.max(0, 1 - (svgY - PAD_TOP) / PLOT_HEIGHT),
	);
	return clampCurveRate({
		rate: Math.exp(LOG_MIN + fraction * (LOG_MAX - LOG_MIN)),
	});
}

/**
 * Pulls a dragged speed onto exactly 1x when it lands near it. The axis is
 * logarithmic, so the window is measured in octaves and is the same size at the
 * top of the graph as at the bottom.
 */
function snapRate({
	rate,
	isEnabled,
}: {
	rate: number;
	isEnabled: boolean;
}): number {
	if (!isEnabled) return rate;
	return Math.abs(Math.log2(rate)) < RATE_SNAP_OCTAVES ? 1 : rate;
}

function buildCurvePath({ curve }: { curve: RetimeCurve }): string {
	const rates = sampleCurveRates({ curve, sampleCount: CURVE_SEGMENTS });
	const points = rates.map((rate, index) => {
		const x = toX({ position: index / CURVE_SEGMENTS });
		const y = toY({ rate });
		return `${x.toFixed(2)},${y.toFixed(2)}`;
	});
	return `M${points.join("L")}`;
}

export function SpeedCurveGraph({
	curve,
	onPreview,
	onCommit,
	onReset,
}: {
	curve: RetimeCurve;
	onPreview: (next: RetimeCurve) => void;
	onCommit: (next: RetimeCurve) => void;
	onReset: () => void;
}) {
	const svgRef = useRef<SVGSVGElement>(null);
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
	const isShiftPressedRef = useShiftKey();
	/**
	 * The shape being dragged, drawn in place of the committed one until the drag
	 * ends.
	 *
	 * Held here rather than read back from the timeline: the properties panel is
	 * built from the last committed tracks, so a preview never reaches this
	 * component and a handle would sit still under the pointer and then jump to
	 * where it had been dragged the moment it was released. Owning the in-progress
	 * shape is also what `usePropertyDraft` does for a number being typed into.
	 */
	const [draggedCurve, setDraggedCurve] = useState<RetimeCurve | null>(null);
	// Pointer moves are not discrete events, so the handler that sees the release
	// may have been built a render before the last move landed. The ref is what the
	// release commits, so the final movement cannot be dropped.
	const draggedCurveRef = useRef<RetimeCurve | null>(null);

	const activeCurve = draggedCurve ?? curve;
	const points = activeCurve.points;
	// Undo, a preset, or a split can change the handles under the component, so a
	// held index is only trusted while it still names an interior handle.
	const canRemoveSelected =
		selectedIndex !== null &&
		selectedIndex > 0 &&
		selectedIndex < points.length - 1;

	function getPointerPosition({ event }: { event: PointerEvent }) {
		const svg = svgRef.current;
		if (!svg) return { x: 0, y: 0 };
		const rect = svg.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) * SVG_WIDTH) / rect.width,
			y: ((event.clientY - rect.top) * SVG_HEIGHT) / rect.height,
		};
	}

	/**
	 * A handle keeps its place in the list while it is dragged, so its neighbours
	 * are what bound it. Endpoints stay pinned to the ends of the clip: the curve
	 * has to say something about every frame the clip shows.
	 */
	function movePoint({
		index,
		position,
		rate,
	}: {
		index: number;
		position: number;
		rate: number;
	}): RetimeCurve {
		const previous = points[index - 1];
		const next = points[index + 1];
		const isFirst = index === 0;
		const isLast = index === points.length - 1;
		const lowerBound = previous ? previous.position + MIN_HANDLE_GAP : 0;
		const upperBound = next ? next.position - MIN_HANDLE_GAP : 1;

		const nextPoint: RetimeCurvePoint = {
			position: isFirst
				? 0
				: isLast
					? 1
					: Math.min(upperBound, Math.max(lowerBound, position)),
			rate,
		};

		return {
			preset: activeCurve.preset,
			points: points.map((point, pointIndex) =>
				pointIndex === index ? nextPoint : point,
			),
		};
	}

	function onHandlePointerDown({
		index,
		event,
	}: {
		index: number;
		event: PointerEvent<SVGCircleElement>;
	}) {
		event.preventDefault();
		event.stopPropagation();
		setSelectedIndex(index);
		setDraggingIndex(index);
		draggedCurveRef.current = null;
		setDraggedCurve(null);
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	function onPointerMove({ event }: { event: PointerEvent<SVGSVGElement> }) {
		if (draggingIndex === null) return;
		const pointer = getPointerPosition({ event });
		const next = movePoint({
			index: draggingIndex,
			position: fromX({ svgX: pointer.x }),
			rate: snapRate({
				rate: fromY({ svgY: pointer.y }),
				isEnabled: !isShiftPressedRef.current,
			}),
		});
		draggedCurveRef.current = next;
		setDraggedCurve(next);
		onPreview(next);
	}

	function onPointerUp() {
		if (draggingIndex === null) return;
		setDraggingIndex(null);

		const dragged = draggedCurveRef.current;
		draggedCurveRef.current = null;
		// A press that never moved previewed nothing, so there is nothing to commit
		// and no reason to put an identical curve into the undo history.
		if (dragged) onCommit(dragged);
		// Committed first, so the shape is already on the prop before this stops
		// drawing its own copy: the handle stays where it was let go rather than
		// flicking back to where the drag started.
		setDraggedCurve(null);
	}

	/**
	 * Clicking bare graph drops a handle there. It lands on the curve's own height
	 * at that spot unless the click was clearly above or below it, so tapping the
	 * line to get a handle to drag does not also change the speed.
	 */
	function onPlotPointerDown({
		event,
	}: {
		event: PointerEvent<SVGRectElement>;
	}) {
		if (points.length >= MAX_CURVE_POINTS) return;

		const pointer = getPointerPosition({ event });
		const position = fromX({ svgX: pointer.x });
		if (position <= MIN_HANDLE_GAP || position >= 1 - MIN_HANDLE_GAP) return;

		const curveRate = getCurveRateAtPosition({ curve: activeCurve, position });
		const pointerRate = fromY({ svgY: pointer.y });
		const isOnCurve =
			Math.abs(toY({ rate: pointerRate }) - toY({ rate: curveRate })) <=
			HANDLE_RADIUS * 2;

		const next = sanitizeRetimeCurve({
			curve: {
				preset: activeCurve.preset,
				points: [
					...points,
					{ position, rate: isOnCurve ? curveRate : pointerRate },
				],
			},
		});

		setSelectedIndex(
			next.points.findIndex((point) => point.position === position),
		);
		onCommit(next);
	}

	function onRemoveSelected() {
		if (selectedIndex === null || !canRemoveSelected) return;
		const next: RetimeCurve = {
			preset: activeCurve.preset,
			points: points.filter((_, index) => index !== selectedIndex),
		};
		setSelectedIndex(null);
		onCommit(next);
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex">
				<svg
					ref={svgRef}
					viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
					className="w-full select-none"
					onPointerMove={(event) => onPointerMove({ event })}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
				>
					<title>Speed curve editor</title>

					{GRID_RATES.map((rate) => (
						<line
							key={rate}
							x1={toX({ position: 0 })}
							y1={toY({ rate })}
							x2={toX({ position: 1 })}
							y2={toY({ rate })}
							className={cn(
								"stroke-foreground/10",
								rate === 1 && "stroke-foreground/20",
							)}
							strokeWidth={1}
							strokeDasharray={rate === 1 ? undefined : "2 3"}
						/>
					))}

					{AXIS_LABELS.map(({ rate, label }) => (
						<text
							key={label}
							x={PAD_LEFT - 6}
							y={toY({ rate })}
							textAnchor="end"
							dominantBaseline="middle"
							className="fill-muted-foreground text-[7px]"
						>
							{label}
						</text>
					))}

					{/* Behind the curve so a click near a handle still reaches it. */}
					<rect
						x={PAD_LEFT}
						y={PAD_TOP}
						width={PLOT_WIDTH}
						height={PLOT_HEIGHT}
						fill="transparent"
						className={cn(
							points.length < MAX_CURVE_POINTS && "cursor-copy",
						)}
						onPointerDown={(event) => onPlotPointerDown({ event })}
					/>

					<path
						d={buildCurvePath({ curve: activeCurve })}
						fill="none"
						className="stroke-primary"
						strokeWidth={2}
						strokeLinecap="round"
						strokeLinejoin="round"
						pointerEvents="none"
					/>

					{points.map((point, index) => (
						<circle
							key={`${index}:${point.position}`}
							cx={toX({ position: point.position })}
							cy={toY({ rate: point.rate })}
							r={HANDLE_RADIUS}
							strokeWidth={1.5}
							className={cn(
								"stroke-primary cursor-grab",
								selectedIndex === index ? "fill-primary" : "fill-background",
								draggingIndex === index && "cursor-grabbing",
							)}
							onPointerDown={(event) => onHandlePointerDown({ index, event })}
						/>
					))}
				</svg>
			</div>

			<div className="flex justify-end gap-1.5">
				<Button
					variant="secondary"
					size="icon"
					title="Reset curve"
					aria-label="Reset curve"
					onClick={onReset}
				>
					<RotateCcwIcon />
				</Button>
				<Button
					variant="secondary"
					size="icon"
					title="Remove selected point"
					aria-label="Remove selected point"
					disabled={!canRemoveSelected}
					onClick={onRemoveSelected}
				>
					<MinusIcon />
				</Button>
			</div>
		</div>
	);
}
