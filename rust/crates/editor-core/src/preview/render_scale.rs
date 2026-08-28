//! How many of the project's pixels the preview actually draws —
//! `apps/web/src/preview/render-scale.ts`.
//!
//! Every editor that plays high-resolution footage in real time separates the
//! resolution it *edits* at from the resolution it *shows* at: Premiere calls
//! the two Playback Resolution and Paused Resolution, Resolve calls the first
//! Timeline Proxy Mode. The picture is composited from the same
//! full-resolution sources either way — only the raster the compositor fills
//! is smaller, and the display stretches it back.
//!
//! That lever is worth more here than in a native editor. There is no WebGPU
//! in WebKitGTK, so the Linux build composites through WebGL and every decoded
//! frame reaches the GPU by way of a CPU readback whose cost is per pixel.
//! Half scale is a quarter of the readback, a quarter of the fill for every
//! layer, blend, mask and effect pass, and a quarter of the surface to present.
//!
//! Two rules set the scale:
//!
//! - **Never draw more pixels than the screen shows.** The preview is a panel
//!   in a window, so a 4K project is usually being looked at through something
//!   like 900 x 500. Rendering the other 90% for the browser to throw away in
//!   its downscale is pure waste, and giving them up costs no visible quality.
//! - **Give up resolution while it is moving, not while it is still.** A frame
//!   that misses its slot is worse than a soft one, so if playback is not
//!   keeping up the scale steps down; the moment it stops, full quality comes
//!   back for the frame the user is actually looking at.
//!
//! The adaptive half is a state machine, and the state is passed in and out
//! rather than held here: the caller owns one per preview surface, and a pure
//! step keeps it off the bridge's hands.

use bridge::export;
use serde::{Deserialize, Serialize};

/// The scales the preview is allowed to render at.
///
/// Halving steps, as every editor's playback-resolution menu uses. A coarse
/// ladder is the point rather than a limitation: changing scale resizes the
/// compositor's surface, so the set of reachable sizes wants to be small
/// enough that ordinary panel resizing settles on one of them and stays there.
const SCALE_LADDER: [f64; 4] = [1.0, 1.0 / 2.0, 1.0 / 4.0, 1.0 / 8.0];

/// How far down the ladder playback may go on its own. Two steps is a
/// sixteenth of the pixels — past that the preview stops being worth looking
/// at, and the honest answer is that the project needs proxies rather than a
/// blurrier picture.
const MAX_ADAPTIVE_STEPS: u32 = 2;

/// Frames in a row that have to miss or beat the budget before the scale
/// moves. Long enough that one slow frame — a seek, a cut onto a fresh
/// decoder — does not drop the resolution, short enough that a genuinely heavy
/// stretch is answered within a few frames.
const STEP_DOWN_AFTER_FRAMES: u32 = 4;
const STEP_UP_AFTER_FRAMES: u32 = 24;

/// Fraction of the frame budget a render has to fit inside before the scale is
/// allowed back up. Well under 1 so stepping up does not immediately produce
/// the overrun that steps it back down.
const STEP_UP_HEADROOM: f64 = 0.5;

/// What the adaptive half remembers between frames: how far down the ladder it
/// has walked, and how long the current run of misses or beats is.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderScaleState {
    pub steps: u32,
    pub overruns: u32,
    pub underruns: u32,
}

/// The largest scale worth rendering at, given how big the canvas is on screen.
///
/// `display_width`/`display_height` are the CSS pixels the canvas occupies, so
/// zooming the preview in raises the answer and shrinking the panel lowers it.
/// Returns the smallest ladder entry that still covers every device pixel on
/// show, which is the largest reduction that cannot be seen.
pub fn fit_scale_to_display(
    canvas_width: f64,
    canvas_height: f64,
    display_width: f64,
    display_height: f64,
    device_pixel_ratio: f64,
) -> f64 {
    // Before the viewport has been measured there is nothing to fit to, and
    // guessing small would show the first frame blurred.
    if !(canvas_width > 0.0)
        || !(canvas_height > 0.0)
        || !(display_width > 0.0)
        || !(display_height > 0.0)
    {
        return 1.0;
    }

    let needed = ((display_width * device_pixel_ratio) / canvas_width)
        .max((display_height * device_pixel_ratio) / canvas_height);
    // Walking down while the entry still covers what is needed leaves the last
    // one that does. The ladder descends, so the result is the smallest.
    let mut scale = SCALE_LADDER[0];
    for candidate in SCALE_LADDER {
        if candidate < needed {
            break;
        }
        scale = candidate;
    }
    scale
}

/// `steps` ladder entries below `scale`, stopping at the bottom of the ladder.
/// A scale that is not on the ladder (nothing produces one today) is treated
/// as the nearest entry at or below it.
fn step_down_from(scale: f64, steps: u32) -> f64 {
    let start = SCALE_LADDER
        .iter()
        .position(|candidate| *candidate <= scale)
        .unwrap_or(SCALE_LADDER.len() - 1);
    let index = (start + steps as usize).min(SCALE_LADDER.len() - 1);
    SCALE_LADDER[index]
}

/// The scale to render the next frame at, and the state to carry forward.
///
/// `ceiling_scale` is the display fit; `is_moving` is whether the playhead is
/// running or being dragged. Standing still returns the ceiling directly and
/// forgets what playback learned, so pausing always lands on the best picture
/// the panel can show — the paused-resolution half of the arrangement.
pub fn scale_for(state: RenderScaleState, ceiling_scale: f64, is_moving: bool) -> RenderScaleDecision {
    if !is_moving {
        return RenderScaleDecision {
            scale: ceiling_scale,
            state: RenderScaleState::default(),
        };
    }

    RenderScaleDecision {
        scale: step_down_from(ceiling_scale, state.steps),
        state,
    }
}

/// Records how long a frame took against the time it had.
///
/// Only called for frames rendered while moving: a paused render is off the
/// hot path — an eyedropper sample, the frame after an edit — and how long it
/// took says nothing about whether playback can keep up.
pub fn record_frame(state: RenderScaleState, duration_ms: f64, budget_ms: f64) -> RenderScaleState {
    if !(budget_ms > 0.0) {
        return state;
    }

    if duration_ms > budget_ms {
        let overruns = state.overruns + 1;
        if overruns >= STEP_DOWN_AFTER_FRAMES && state.steps < MAX_ADAPTIVE_STEPS {
            return RenderScaleState {
                steps: state.steps + 1,
                overruns: 0,
                underruns: 0,
            };
        }
        return RenderScaleState {
            steps: state.steps,
            overruns,
            underruns: 0,
        };
    }

    if duration_ms < budget_ms * STEP_UP_HEADROOM {
        let underruns = state.underruns + 1;
        if underruns >= STEP_UP_AFTER_FRAMES && state.steps > 0 {
            return RenderScaleState {
                steps: state.steps - 1,
                overruns: 0,
                underruns: 0,
            };
        }
        return RenderScaleState {
            steps: state.steps,
            overruns: 0,
            underruns,
        };
    }

    // Inside the budget but without the headroom to justify moving: this is
    // where a well-matched scale sits, so neither counter advances.
    RenderScaleState {
        steps: state.steps,
        overruns: 0,
        underruns: 0,
    }
}

// Bridge surface.

/// The scale for the next frame, with the state the caller stores back.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderScaleDecision {
    pub scale: f64,
    pub state: RenderScaleState,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FitScaleToDisplayOptions {
    pub canvas_width: f64,
    pub canvas_height: f64,
    pub display_width: f64,
    pub display_height: f64,
    /// Defaults to 1 for callers that have not measured the screen.
    #[serde(default)]
    pub device_pixel_ratio: Option<f64>,
}

#[export]
pub fn fit_scale_to_display_value(
    FitScaleToDisplayOptions {
        canvas_width,
        canvas_height,
        display_width,
        display_height,
        device_pixel_ratio,
    }: FitScaleToDisplayOptions,
) -> f64 {
    fit_scale_to_display(
        canvas_width,
        canvas_height,
        display_width,
        display_height,
        device_pixel_ratio.unwrap_or(1.0),
    )
}

#[export]
pub fn get_initial_render_scale_state() -> RenderScaleState {
    RenderScaleState::default()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderScaleForOptions {
    pub state: RenderScaleState,
    pub ceiling_scale: f64,
    pub is_moving: bool,
}

#[export]
pub fn render_scale_for(
    RenderScaleForOptions {
        state,
        ceiling_scale,
        is_moving,
    }: RenderScaleForOptions,
) -> RenderScaleDecision {
    scale_for(state, ceiling_scale, is_moving)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordRenderFrameOptions {
    pub state: RenderScaleState,
    pub duration_ms: f64,
    pub budget_ms: f64,
}

#[export]
pub fn record_render_frame(
    RecordRenderFrameOptions {
        state,
        duration_ms,
        budget_ms,
    }: RecordRenderFrameOptions,
) -> RenderScaleState {
    record_frame(state, duration_ms, budget_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame at 60fps, which is the budget every test here measures against.
    const BUDGET: f64 = 16.6;

    fn overrun(state: RenderScaleState, times: u32) -> RenderScaleState {
        (0..times).fold(state, |carried, _| {
            record_frame(carried, BUDGET * 2.0, BUDGET)
        })
    }

    fn underrun(state: RenderScaleState, times: u32) -> RenderScaleState {
        (0..times).fold(state, |carried, _| record_frame(carried, 1.0, BUDGET))
    }

    #[test]
    fn a_panel_smaller_than_the_project_drops_the_scale() {
        // A 4K project in an 800px panel needs 800/3840 = 0.208 of the
        // pixels; the smallest ladder entry that still covers that is a
        // quarter, and an eighth would be visibly soft.
        assert_eq!(
            fit_scale_to_display(3840.0, 2160.0, 800.0, 450.0, 1.0),
            1.0 / 4.0,
        );
    }

    #[test]
    fn a_panel_larger_than_the_project_never_goes_above_full_scale() {
        // Rendering above 1 would be upscaling the composite, which the
        // display does for free.
        assert_eq!(fit_scale_to_display(640.0, 360.0, 1920.0, 1080.0, 1.0), 1.0);
    }

    #[test]
    fn a_retina_screen_needs_the_pixels_its_ratio_asks_for() {
        // The same panel at 2x needs twice the raster, which is one ladder
        // step back up.
        let at_one = fit_scale_to_display(1920.0, 1080.0, 480.0, 270.0, 1.0);
        let at_two = fit_scale_to_display(1920.0, 1080.0, 480.0, 270.0, 2.0);
        assert_eq!(at_one, 1.0 / 4.0);
        assert_eq!(at_two, 1.0 / 2.0);
    }

    #[test]
    fn the_taller_axis_decides_when_the_aspect_ratios_differ() {
        // A wide panel over a square project is bounded by the height.
        assert_eq!(
            fit_scale_to_display(1000.0, 1000.0, 1000.0, 500.0, 1.0),
            1.0,
        );
    }

    #[test]
    fn an_unmeasured_viewport_renders_at_full_scale() {
        // Guessing small would show the first frame blurred, and the measure
        // arrives a frame later anyway.
        assert_eq!(fit_scale_to_display(1920.0, 1080.0, 0.0, 0.0, 1.0), 1.0);
        assert_eq!(fit_scale_to_display(0.0, 0.0, 800.0, 450.0, 1.0), 1.0);
    }

    #[test]
    fn standing_still_shows_the_best_picture_the_panel_can_hold() {
        // Two steps down from playback, then a pause: the ceiling comes back
        // immediately and the counters are forgotten.
        let state = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES * 2);
        assert_eq!(state.steps, 2);
        let decision = scale_for(state, 1.0, false);
        assert_eq!(decision.scale, 1.0);
        assert_eq!(decision.state, RenderScaleState::default());
    }

    #[test]
    fn one_slow_frame_does_not_move_the_scale() {
        let state = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES - 1);
        assert_eq!(state.steps, 0);
        assert_eq!(scale_for(state, 1.0, true).scale, 1.0);
    }

    #[test]
    fn a_run_of_slow_frames_steps_down_one_rung() {
        let state = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES);
        assert_eq!(state.steps, 1);
        assert_eq!(scale_for(state, 1.0, true).scale, 0.5);
    }

    #[test]
    fn playback_will_not_walk_further_than_two_steps_down() {
        let state = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES * 10);
        assert_eq!(state.steps, MAX_ADAPTIVE_STEPS);
        assert_eq!(scale_for(state, 1.0, true).scale, 1.0 / 4.0);
    }

    #[test]
    fn a_fast_frame_resets_the_run_of_slow_ones() {
        // Three misses then a comfortable frame: the next miss starts a new
        // run rather than tipping the fourth one over.
        let state = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES - 1);
        let state = record_frame(state, 1.0, BUDGET);
        assert_eq!(state.overruns, 0);
        let state = overrun(state, STEP_DOWN_AFTER_FRAMES - 1);
        assert_eq!(state.steps, 0);
    }

    #[test]
    fn a_long_comfortable_run_steps_back_up() {
        let dropped = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES);
        let recovered = underrun(dropped, STEP_UP_AFTER_FRAMES);
        assert_eq!(recovered.steps, 0);
    }

    #[test]
    fn stepping_up_takes_far_longer_than_stepping_down() {
        // Asymmetric on purpose: dropping resolution answers a stall in four
        // frames, raising it waits until the stretch is convincingly over.
        let dropped = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES);
        let not_yet = underrun(dropped, STEP_UP_AFTER_FRAMES - 1);
        assert_eq!(not_yet.steps, 1);
    }

    #[test]
    fn a_frame_inside_the_budget_without_headroom_moves_nothing() {
        // 0.75 of the budget is neither a miss nor comfortable: this is where
        // a well-matched scale sits, and both counters stay at zero.
        let state = overrun(RenderScaleState::default(), 2);
        let held = record_frame(state, BUDGET * 0.75, BUDGET);
        assert_eq!(held.overruns, 0);
        assert_eq!(held.underruns, 0);
        assert_eq!(held.steps, 0);
    }

    #[test]
    fn a_budget_of_zero_is_not_a_measurement() {
        let state = RenderScaleState {
            steps: 1,
            overruns: 3,
            underruns: 0,
        };
        assert_eq!(record_frame(state, 100.0, 0.0), state);
    }

    #[test]
    fn stepping_down_starts_from_the_ceiling_not_from_full_scale() {
        // A panel that already fits at half scale steps to a quarter, not to
        // a half — the two inputs compose rather than compete.
        let state = overrun(RenderScaleState::default(), STEP_DOWN_AFTER_FRAMES);
        assert_eq!(scale_for(state, 0.5, true).scale, 1.0 / 4.0);
    }

    #[test]
    fn stepping_down_stops_at_the_bottom_of_the_ladder() {
        let state = RenderScaleState {
            steps: MAX_ADAPTIVE_STEPS,
            overruns: 0,
            underruns: 0,
        };
        assert_eq!(scale_for(state, 1.0 / 8.0, true).scale, 1.0 / 8.0);
    }
}
