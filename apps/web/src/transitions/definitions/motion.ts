import type { TransitionDefinition } from "@/transitions/types";
import {
	DEFAULT_TRANSITION_DURATION,
	neutralSide,
	side,
	smoothstep,
} from "./shared";

type Direction = "left" | "right" | "up" | "down";

/** Unit vector the incoming clip travels along. */
function travelVector({ direction }: { direction: Direction }): {
	x: number;
	y: number;
} {
	switch (direction) {
		case "left":
			return { x: -1, y: 0 };
		case "right":
			return { x: 1, y: 0 };
		case "up":
			return { x: 0, y: -1 };
		case "down":
			return { x: 0, y: 1 };
	}
}

function directionLabel({ direction }: { direction: Direction }): string {
	return direction.charAt(0).toUpperCase() + direction.slice(1);
}

/** The incoming clip slides in over a stationary outgoing clip. */
function buildSlide({
	direction,
}: {
	direction: Direction;
}): TransitionDefinition {
	const travel = travelVector({ direction });
	return {
		type: `slide-${direction}`,
		name: `Slide ${direction}`,
		category: "motion",
		keywords: ["slide", "move", direction, directionLabel({ direction })],
		defaultDuration: DEFAULT_TRANSITION_DURATION,
		params: [],
		resolve: ({ progress, width, height }) => {
			const eased = smoothstep({ progress });
			const remaining = 1 - eased;
			return {
				outgoing: neutralSide(),
				incoming: side({
					offsetX: -travel.x * remaining * width,
					offsetY: -travel.y * remaining * height,
				}),
			};
		},
	};
}

/** Both clips travel together, as if shoved off screen. */
function buildPush({
	direction,
}: {
	direction: Direction;
}): TransitionDefinition {
	const travel = travelVector({ direction });
	return {
		type: `push-${direction}`,
		name: `Push ${direction}`,
		category: "motion",
		keywords: ["push", "shove", "slide", direction],
		defaultDuration: DEFAULT_TRANSITION_DURATION,
		params: [],
		resolve: ({ progress, width, height }) => {
			const eased = smoothstep({ progress });
			return {
				outgoing: side({
					offsetX: travel.x * eased * width,
					offsetY: travel.y * eased * height,
				}),
				incoming: side({
					offsetX: -travel.x * (1 - eased) * width,
					offsetY: -travel.y * (1 - eased) * height,
				}),
			};
		},
	};
}

const DIRECTIONS: Direction[] = ["left", "right", "up", "down"];

export const MOTION_TRANSITIONS: TransitionDefinition[] = [
	...DIRECTIONS.map((direction) => buildSlide({ direction })),
	...DIRECTIONS.map((direction) => buildPush({ direction })),
];
