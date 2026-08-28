import type { MouseEvent as ReactMouseEvent } from "react";
import type { FrameRate } from "bluper-wasm";
import {
	mediaTime,
	snapSeekMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import {
	getCenteredLineLeft,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import type { Bookmark, SceneTracks } from "@/timeline";

// --- Session ---

interface ScrubSession {
	kind: "scrubbing";
	/** Most recent frame-snapped time set by scrub(). */
	currentTime: MediaTime | null;
	/**
	 * Snap candidates, built once on first use and reused for the gesture.
	 * The timeline cannot be edited mid-scrub, so element edges, bookmarks and
	 * keyframes are all fixed — rebuilding them per mousemove walked every
	 * element and every keyframe in the scene and threw the result away.
	 */
	snapPoints: SnapPoint[] | null;
	/**
	 * The ruler's client-space left edge with scroll removed, cached once per
	 * gesture. Reading `getBoundingClientRect()` per mousemove forced a reflow
	 * of the whole timeline, because each scrub writes the playhead's `left`.
	 */
	rulerOriginLeft: number | null;
}

type Session = { kind: "idle" } | ScrubSession;

// --- Config ---

export interface PlayheadConfig {
	zoomLevel: number;
	duration: MediaTime;
	getActiveProjectFps: () => FrameRate | null;
	isShiftHeld: () => boolean;
	getRulerEl: () => HTMLDivElement | null;
	getRulerScrollEl: () => HTMLDivElement | null;
	getTracksScrollEl: () => HTMLDivElement | null;
	getPlayheadEl: () => HTMLDivElement | null;
	getSceneTracks: () => SceneTracks;
	getSceneBookmarks: () => Bookmark[];
	seek: (time: MediaTime) => void;
	setScrubbing: (isScrubbing: boolean) => void;
	setTimelineViewState: (viewState: {
		zoomLevel: number;
		scrollLeft: number;
		playheadTime: MediaTime;
	}) => void;
}

export interface PlayheadConfigRef {
	readonly current: PlayheadConfig;
}

// --- Pure helpers (px → logical) ---

function pixelToTime({
	clientX,
	rulerLeft,
	zoomLevel,
	duration,
}: {
	clientX: number;
	rulerLeft: number;
	zoomLevel: number;
	duration: MediaTime;
}): MediaTime {
	const contentWidth = timelineTimeToPixels({ time: duration, zoomLevel });
	const clampedX = Math.max(0, Math.min(contentWidth, clientX - rulerLeft));
	const seconds = Math.max(
		0,
		Math.min(
			duration / TICKS_PER_SECOND,
			clampedX / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel),
		),
	);
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

// --- Controller ---

export class PlayheadController {
	private lastMouseClientX = 0;
	/**
	 * True once the mouse has moved during a scrub. Cleared on mousedown so
	 * that holding the click still near a viewport edge does not cause the
	 * edge auto-scroll loop to drag the timeline while the user is stationary.
	 */
	private dragStarted = false;

	private session: Session = { kind: "idle" };
	private readonly configRef: PlayheadConfigRef;
	/** Latest un-applied pointer position, drained by the rAF below. */
	private pendingClientX: number | null = null;
	private moveRafId: number | null = null;

	constructor(deps: { configRef: PlayheadConfigRef }) {
		this.configRef = deps.configRef;
		this.onPlayheadMouseDown = this.onPlayheadMouseDown.bind(this);
		this.onRulerMouseDown = this.onRulerMouseDown.bind(this);
		this.handleMouseMove = this.handleMouseMove.bind(this);
		this.handleMouseUp = this.handleMouseUp.bind(this);
	}

	private get config(): PlayheadConfig {
		return this.configRef.current;
	}

	get isActive(): boolean {
		return this.session.kind !== "idle";
	}

	getLastMouseClientX(): number {
		return this.lastMouseClientX;
	}

	/**
	 * True only once a scrub is active *and* the mouse has actually moved.
	 * Used by edge auto-scroll to distinguish a held click from a real drag.
	 */
	isDraggingScrub(): boolean {
		return this.session.kind === "scrubbing" && this.dragStarted;
	}

	destroy(): void {
		this.deactivate();
	}

	// --- Public event handlers (bound, stable references) ---

	onPlayheadMouseDown(event: ReactMouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.dragStarted = false;
		this.session = {
			kind: "scrubbing",
			currentTime: null,
			snapPoints: null,
			rulerOriginLeft: null,
		};
		this.config.setScrubbing(true);
		this.scrub({ clientX: event.clientX, isElementSnappingEnabled: true });
		this.activate();
	}

	onRulerMouseDown(event: ReactMouseEvent): void {
		if (event.button !== 0) return;
		if (this.config.getPlayheadEl()?.contains(event.target as Node)) return;

		event.preventDefault();
		this.dragStarted = false;
		this.session = {
			kind: "scrubbing",
			currentTime: null,
			snapPoints: null,
			rulerOriginLeft: null,
		};
		this.config.setScrubbing(true);
		// No element-edge snapping on initial ruler click — avoids a jarring jump.
		this.scrub({ clientX: event.clientX, isElementSnappingEnabled: false });
		this.activate();
	}

	// --- Public non-session methods ---

	/**
	 * Imperatively updates the playhead DOM element's `left` style.
	 * Called on scroll and playback events to avoid React re-renders
	 * during animation frame updates.
	 */
	updatePlayheadLeft(time: MediaTime): void {
		const playheadEl = this.config.getPlayheadEl();
		if (!playheadEl) return;

		const centerPixel = timelineTimeToSnappedPixels({
			time,
			zoomLevel: this.config.zoomLevel,
		});
		const scrollLeft = this.config.getRulerScrollEl()?.scrollLeft ?? 0;
		playheadEl.style.left = `${getCenteredLineLeft({ centerPixel }) - scrollLeft}px`;
	}

	/**
	 * Updates the playhead position on playback events. The playhead is
	 * intentionally allowed to leave the viewport — playback never auto-scrolls
	 * the timeline; the user owns the camera.
	 */
	handlePlaybackUpdate(time: MediaTime): void {
		this.updatePlayheadLeft(time);
	}

	// --- Private ---

	private activate(): void {
		window.addEventListener("mousemove", this.handleMouseMove);
		window.addEventListener("mouseup", this.handleMouseUp);
	}

	private deactivate(): void {
		window.removeEventListener("mousemove", this.handleMouseMove);
		window.removeEventListener("mouseup", this.handleMouseUp);
		if (this.moveRafId !== null) {
			cancelAnimationFrame(this.moveRafId);
			this.moveRafId = null;
		}
		this.pendingClientX = null;
	}

	/**
	 * Converts pointer position to a frame-snapped timeline time and seeks.
	 * `isElementSnappingEnabled` controls element-edge snapping; frame-level snapping
	 * is always applied.
	 */
	private scrub({
		clientX,
		isElementSnappingEnabled,
	}: {
		clientX: number;
		isElementSnappingEnabled: boolean;
	}): void {
		const ruler = this.config.getRulerEl();
		if (!ruler) return;

		const fps = this.config.getActiveProjectFps();
		if (!fps) return;

		const { zoomLevel, duration } = this.config;
		const rawTime = pixelToTime({
			clientX,
			rulerLeft: this.getRulerLeft({ ruler }),
			zoomLevel,
			duration,
		});
		const frameTime = snapSeekMediaTime({ time: rawTime, duration, fps });

		const time = (() => {
			if (!isElementSnappingEnabled || this.config.isShiftHeld())
				return frameTime;

			const result = resolveTimelineSnap({
				targetTime: frameTime,
				snapPoints: this.getSnapPoints(),
				maxSnapDistance: getTimelineSnapThresholdInTicks({ zoomLevel }),
			});
			return result.snapPoint ? result.snappedTime : frameTime;
		})();

		if (this.session.kind === "scrubbing") {
			this.session.currentTime = time;
		}
		this.config.seek(time);
		this.lastMouseClientX = clientX;
	}

	/**
	 * Snap candidates for the active gesture, built at most once. Outside a
	 * session (a bare ruler click) they are built fresh and not retained.
	 */
	private getSnapPoints(): SnapPoint[] {
		if (this.session.kind === "scrubbing" && this.session.snapPoints) {
			return this.session.snapPoints;
		}

		const snapPoints = buildTimelineSnapPoints({
			tracks: this.config.getSceneTracks(),
			bookmarks: this.config.getSceneBookmarks(),
		});

		if (this.session.kind === "scrubbing") {
			this.session.snapPoints = snapPoints;
		}
		return snapPoints;
	}

	/**
	 * The ruler's left edge in client space. The ruler lives inside the
	 * horizontally scrolled ruler viewport, so its rect shifts as the viewport
	 * scrolls (edge auto-scroll does exactly that mid-gesture). Cache the
	 * scroll-independent origin once, then re-derive from the live scrollLeft —
	 * reading scrollLeft is far cheaper than a rect read after a style write.
	 */
	private getRulerLeft({ ruler }: { ruler: HTMLDivElement }): number {
		const scrollLeft = this.config.getRulerScrollEl()?.scrollLeft ?? 0;

		if (this.session.kind !== "scrubbing") {
			return ruler.getBoundingClientRect().left;
		}

		if (this.session.rulerOriginLeft === null) {
			this.session.rulerOriginLeft =
				ruler.getBoundingClientRect().left + scrollLeft;
		}
		return this.session.rulerOriginLeft - scrollLeft;
	}

	/**
	 * Mousemove can fire more than once per frame; each scrub seeks and writes
	 * the playhead's `left`, so collapse a frame's worth of movement into a
	 * single update using the latest position.
	 */
	private handleMouseMove(event: MouseEvent): void {
		if (this.session.kind !== "scrubbing") return;

		this.dragStarted = true;
		// Kept eager: edge auto-scroll polls this every frame.
		this.lastMouseClientX = event.clientX;
		this.pendingClientX = event.clientX;

		if (this.moveRafId !== null) return;
		this.moveRafId = requestAnimationFrame(() => {
			this.moveRafId = null;
			const clientX = this.pendingClientX;
			this.pendingClientX = null;
			if (clientX === null) return;
			if (this.session.kind !== "scrubbing") return;
			this.scrub({ clientX, isElementSnappingEnabled: true });
		});
	}

	private handleMouseUp(): void {
		if (this.session.kind !== "scrubbing") return;

		// Apply any movement still waiting on a frame, so releasing the mouse
		// never drops the last sliver of the drag.
		if (this.moveRafId !== null) {
			cancelAnimationFrame(this.moveRafId);
			this.moveRafId = null;
		}
		if (this.pendingClientX !== null) {
			const clientX = this.pendingClientX;
			this.pendingClientX = null;
			this.scrub({ clientX, isElementSnappingEnabled: true });
		}

		const session = this.session;
		this.config.setScrubbing(false);

		// Persist only — do not seek again. Every scrub already seeked to
		// `currentTime`, so re-issuing it here is a no-op when paused but rewinds
		// during playback: the clock has advanced past the gesture's time since
		// mousedown, so the playhead snaps backwards a frame or two and the single
		// click reads as two clicks a few dozen milliseconds apart.
		if (session.currentTime !== null) {
			this.config.setTimelineViewState({
				zoomLevel: this.config.zoomLevel,
				scrollLeft: this.config.getTracksScrollEl()?.scrollLeft ?? 0,
				playheadTime: session.currentTime,
			});
		}

		this.session = { kind: "idle" };
		this.deactivate();
	}
}
