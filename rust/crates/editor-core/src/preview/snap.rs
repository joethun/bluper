//! Snapping for the preview canvas: position, uniform scale, per-axis scale and
//! rotation.
//!
//! Everything works in canvas coordinates with the origin at the canvas
//! *centre*, which is why the targets are `0`, `-width / 2` and `+width / 2`
//! rather than `0` and `width`. Thresholds arrive per-axis because the preview
//! is letterboxed into its container: one screen pixel is a different number of
//! canvas units on each axis as soon as the two aspect ratios differ.
//!
//! An element snaps by its axis-aligned bounding box, not its rotated outline.
//! For a `w × h` rectangle turned by `θ` the AABB half-extents are
//! `(w·|cos θ| + h·|sin θ|) / 2` and `(w·|sin θ| + h·|cos θ|) / 2`, so a
//! 45°-rotated square reaches further than its own width — which is what the
//! user sees touching the edge of the frame.
//!
//! Floating-point *order* is load-bearing here. Both this module and the
//! TypeScript it replaces are held to the same bit pattern by
//! `preview-snap-parity.test.ts`, so a reassociated sum is a test failure, not
//! a wash.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::math::js_round;

/// Rotation snaps to the four right angles, so the element can be flipped onto
/// an axis without the user having to land on the degree exactly.
const ROTATION_SNAP_STEP_DEGREES: f64 = 90.0;
const ROTATION_SNAP_THRESHOLD_DEGREES: f64 = 5.0;

/// Smallest magnitude a snap may give a scale. A snap that would collapse the
/// element to nothing is not a snap the user asked for, and it is unrecoverable
/// by dragging — the handle it was dragged by no longer has any size.
#[export]
pub const PREVIEW_MIN_SCALE: f64 = 0.01;

/// Snap radius in *screen* pixels. The caller converts it into the per-axis
/// canvas-unit thresholds these functions take, since the preview's scale is
/// only known to the UI.
#[export]
pub const PREVIEW_SNAP_THRESHOLD_SCREEN_PIXELS: f64 = 8.0;

/// Which way a guide line runs. Horizontal lines mark a `y`, vertical lines an
/// `x` — the axis the line *spans*, not the axis it constrains.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewSnapLineKind {
    Horizontal,
    Vertical,
}

/// A guide the UI draws while a gesture is snapped.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapLine {
    #[serde(rename = "type")]
    pub kind: PreviewSnapLineKind,
    pub position: f64,
}

/// A canvas-space `(x, y)` pair. Doubles as the per-axis snap threshold, which
/// is a distance on each axis rather than a point.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapPoint {
    pub x: f64,
    pub y: f64,
}

/// A width/height pair in canvas units.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapSize {
    pub width: f64,
    pub height: f64,
}

/// Which edges the gesture is actually dragging. A corner handle moves two of
/// them; a side handle one. It breaks ties between equidistant candidates and
/// decides which guides are worth drawing, so that dragging the right edge onto
/// the frame does not also light up the left one.
///
/// The distinction between "absent" and "present but all false" is behaviour:
/// absent means the caller has no opinion and every touching edge draws its
/// guide, whereas an empty preference draws none.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScaleEdgePreference {
    #[serde(default)]
    pub left: Option<bool>,
    #[serde(default)]
    pub right: Option<bool>,
    #[serde(default)]
    pub top: Option<bool>,
    #[serde(default)]
    pub bottom: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScaleEdge {
    Left,
    Right,
    Top,
    Bottom,
}

fn has_preferred_edge(
    preferred_edges: Option<&PreviewScaleEdgePreference>,
    edge: ScaleEdge,
) -> bool {
    let Some(preference) = preferred_edges else {
        return false;
    };
    let flag = match edge {
        ScaleEdge::Left => preference.left,
        ScaleEdge::Right => preference.right,
        ScaleEdge::Top => preference.top,
        ScaleEdge::Bottom => preference.bottom,
    };
    flag == Some(true)
}

/// A scale the gesture could snap to, and how far the corresponding edge is
/// from its target right now.
struct ScaleCandidate {
    scale: f64,
    distance: f64,
    lines: Vec<PreviewSnapLine>,
    edge: ScaleEdge,
}

/// The nearest candidate, with the *first* of a tie kept unless a later one is
/// on an edge the gesture is actually dragging.
///
/// The comparisons are deliberately the two strict ones rather than an ordering:
/// a `NaN` distance loses both, so it falls through to the preference check the
/// same way a genuine tie does.
fn pick_closest_scale_candidate<'candidates>(
    candidates: &'candidates [ScaleCandidate],
    preferred_edges: Option<&PreviewScaleEdgePreference>,
) -> Option<&'candidates ScaleCandidate> {
    let (first, rest) = candidates.split_first()?;
    let mut best = first;

    for candidate in rest {
        if candidate.distance < best.distance {
            best = candidate;
            continue;
        }
        if candidate.distance > best.distance {
            continue;
        }
        let prefer_candidate = has_preferred_edge(preferred_edges, candidate.edge);
        let prefer_best = has_preferred_edge(preferred_edges, best.edge);
        if prefer_candidate && !prefer_best {
            best = candidate;
        }
    }

    Some(best)
}

/// Append a guide unless one already marks the same place. Two targets can
/// share a position when a canvas dimension is zero (`-0 / 2` and `0` are the
/// same line), and the UI must not draw it twice.
fn push_unique_line(lines: &mut Vec<PreviewSnapLine>, line: PreviewSnapLine) {
    let already_present = lines.iter().any(|existing| {
        existing.kind == line.kind
            && (existing.position == line.position
                || (existing.position.is_nan() && line.position.is_nan()))
    });
    if !already_present {
        lines.push(line);
    }
}

/// `|cos θ|` and `|sin θ|` for a rotation in degrees — the two factors every
/// AABB half-extent here is built from.
fn rotation_factors(rotation: f64) -> (f64, f64) {
    let radians = rotation * std::f64::consts::PI / 180.0;
    (radians.cos().abs(), radians.sin().abs())
}

// Position snapping.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapPositionOptions {
    pub proposed_position: PreviewSnapPoint,
    pub canvas_size: PreviewSnapSize,
    pub element_size: PreviewSnapSize,
    #[serde(default)]
    pub rotation: Option<f64>,
    pub snap_threshold: PreviewSnapPoint,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapResult {
    pub snapped_position: PreviewSnapPoint,
    pub active_lines: Vec<PreviewSnapLine>,
}

struct AxisSnapCandidate {
    snapped_position: f64,
    line: PreviewSnapLine,
    distance: f64,
}

/// Nearest candidate within `threshold`, ties going to the earlier one — so the
/// order the candidates are generated in is part of the behaviour.
fn closest_axis_snap(
    candidates: &[AxisSnapCandidate],
    threshold: f64,
) -> Option<&AxisSnapCandidate> {
    let mut closest: Option<&AxisSnapCandidate> = None;
    for candidate in candidates {
        // Written as a positive test so a `NaN` distance is excluded rather
        // than admitted by a negated comparison.
        if !(candidate.distance <= threshold) {
            continue;
        }
        match closest {
            None => closest = Some(candidate),
            Some(best) if candidate.distance < best.distance => closest = Some(candidate),
            Some(_) => {}
        }
    }
    closest
}

/// Snap a proposed centre position onto the canvas centre lines and edges.
///
/// Each target is offered three ways: the element's centre on it, its near edge
/// on it, and its far edge on it. That is what lets an element sit flush against
/// the frame as well as centred in it.
#[export]
pub fn preview_snap_position(
    PreviewSnapPositionOptions {
        proposed_position,
        canvas_size,
        element_size,
        rotation,
        snap_threshold,
    }: PreviewSnapPositionOptions,
) -> PreviewSnapResult {
    let rotation = rotation.unwrap_or(0.0);

    let center_x = 0.0;
    let center_y = 0.0;
    let left = -canvas_size.width / 2.0;
    let right = canvas_size.width / 2.0;
    let top = -canvas_size.height / 2.0;
    let bottom = canvas_size.height / 2.0;

    let (cos_r, sin_r) = rotation_factors(rotation);
    let half_width = (element_size.width * cos_r + element_size.height * sin_r) / 2.0;
    let half_height = (element_size.width * sin_r + element_size.height * cos_r) / 2.0;

    let mut x_candidates: Vec<AxisSnapCandidate> = Vec::new();
    for target_x in [center_x, left, right] {
        let line = PreviewSnapLine {
            kind: PreviewSnapLineKind::Vertical,
            position: target_x,
        };
        x_candidates.push(AxisSnapCandidate {
            snapped_position: target_x,
            line,
            distance: (proposed_position.x - target_x).abs(),
        });
        x_candidates.push(AxisSnapCandidate {
            snapped_position: target_x + half_width,
            line,
            distance: (proposed_position.x - half_width - target_x).abs(),
        });
        x_candidates.push(AxisSnapCandidate {
            snapped_position: target_x - half_width,
            line,
            distance: (proposed_position.x + half_width - target_x).abs(),
        });
    }

    let mut y_candidates: Vec<AxisSnapCandidate> = Vec::new();
    for target_y in [center_y, top, bottom] {
        let line = PreviewSnapLine {
            kind: PreviewSnapLineKind::Horizontal,
            position: target_y,
        };
        y_candidates.push(AxisSnapCandidate {
            snapped_position: target_y,
            line,
            distance: (proposed_position.y - target_y).abs(),
        });
        y_candidates.push(AxisSnapCandidate {
            snapped_position: target_y + half_height,
            line,
            distance: (proposed_position.y - half_height - target_y).abs(),
        });
        y_candidates.push(AxisSnapCandidate {
            snapped_position: target_y - half_height,
            line,
            distance: (proposed_position.y + half_height - target_y).abs(),
        });
    }

    let closest_x = closest_axis_snap(&x_candidates, snap_threshold.x);
    let closest_y = closest_axis_snap(&y_candidates, snap_threshold.y);

    let x = closest_x.map_or(proposed_position.x, |candidate| candidate.snapped_position);
    let y = closest_y.map_or(proposed_position.y, |candidate| candidate.snapped_position);

    let mut active_lines: Vec<PreviewSnapLine> = Vec::new();
    if let Some(candidate) = closest_x {
        active_lines.push(candidate.line);
    }
    if let Some(candidate) = closest_y {
        active_lines.push(candidate.line);
    }

    PreviewSnapResult {
        snapped_position: PreviewSnapPoint { x, y },
        active_lines,
    }
}

// Uniform scale snapping.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapScaleOptions {
    pub proposed_scale: f64,
    pub position: PreviewSnapPoint,
    pub base_width: f64,
    pub base_height: f64,
    #[serde(default)]
    pub rotation: Option<f64>,
    pub canvas_size: PreviewSnapSize,
    pub snap_threshold: PreviewSnapPoint,
    #[serde(default)]
    pub preferred_edges: Option<PreviewScaleEdgePreference>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScaleSnapResult {
    pub snapped_scale: f64,
    pub active_lines: Vec<PreviewSnapLine>,
}

/// A target position paired with the guide that marks it.
struct SnapTarget {
    position: f64,
    line: PreviewSnapLine,
}

fn vertical_targets(canvas_width: f64) -> [SnapTarget; 3] {
    [-canvas_width / 2.0, 0.0, canvas_width / 2.0].map(|position| SnapTarget {
        position,
        line: PreviewSnapLine {
            kind: PreviewSnapLineKind::Vertical,
            position,
        },
    })
}

fn horizontal_targets(canvas_height: f64) -> [SnapTarget; 3] {
    [-canvas_height / 2.0, 0.0, canvas_height / 2.0].map(|position| SnapTarget {
        position,
        line: PreviewSnapLine {
            kind: PreviewSnapLineKind::Horizontal,
            position,
        },
    })
}

/// Snap a uniform scale so one of the element's AABB edges lands on a canvas
/// edge or centre line.
///
/// The candidate that wins may come from either axis: a corner drag is one
/// number, and whichever edge is closest to a target is the one that decides it.
#[export]
pub fn preview_snap_scale(
    PreviewSnapScaleOptions {
        proposed_scale,
        position,
        base_width,
        base_height,
        rotation,
        canvas_size,
        snap_threshold,
        preferred_edges,
    }: PreviewSnapScaleOptions,
) -> PreviewScaleSnapResult {
    let rotation = rotation.unwrap_or(0.0);
    let preferred_edges = preferred_edges.as_ref();

    let (cos_r, sin_r) = rotation_factors(rotation);
    let aabb_base_half_w = (base_width * cos_r + base_height * sin_r) / 2.0;
    let aabb_base_half_h = (base_width * sin_r + base_height * cos_r) / 2.0;

    let left_edge = position.x - aabb_base_half_w * proposed_scale;
    let right_edge = position.x + aabb_base_half_w * proposed_scale;
    let top_edge = position.y - aabb_base_half_h * proposed_scale;
    let bottom_edge = position.y + aabb_base_half_h * proposed_scale;

    let vertical = vertical_targets(canvas_size.width);
    let horizontal = horizontal_targets(canvas_size.height);

    let mut candidates: Vec<ScaleCandidate> = Vec::new();

    for target in &vertical {
        let distance_left = (left_edge - target.position).abs();
        if distance_left <= snap_threshold.x {
            let scale = (position.x - target.position) / aabb_base_half_w;
            if scale.abs() > PREVIEW_MIN_SCALE {
                candidates.push(ScaleCandidate {
                    scale,
                    distance: distance_left,
                    lines: vec![target.line],
                    edge: ScaleEdge::Left,
                });
            }
        }
        let distance_right = (right_edge - target.position).abs();
        if distance_right <= snap_threshold.x {
            let scale = (target.position - position.x) / aabb_base_half_w;
            if scale.abs() > PREVIEW_MIN_SCALE {
                candidates.push(ScaleCandidate {
                    scale,
                    distance: distance_right,
                    lines: vec![target.line],
                    edge: ScaleEdge::Right,
                });
            }
        }
    }

    for target in &horizontal {
        let distance_top = (top_edge - target.position).abs();
        if distance_top <= snap_threshold.y {
            let scale = (position.y - target.position) / aabb_base_half_h;
            if scale.abs() > PREVIEW_MIN_SCALE {
                candidates.push(ScaleCandidate {
                    scale,
                    distance: distance_top,
                    lines: vec![target.line],
                    edge: ScaleEdge::Top,
                });
            }
        }
        let distance_bottom = (bottom_edge - target.position).abs();
        if distance_bottom <= snap_threshold.y {
            let scale = (target.position - position.y) / aabb_base_half_h;
            if scale.abs() > PREVIEW_MIN_SCALE {
                candidates.push(ScaleCandidate {
                    scale,
                    distance: distance_bottom,
                    lines: vec![target.line],
                    edge: ScaleEdge::Bottom,
                });
            }
        }
    }

    let Some(best) = pick_closest_scale_candidate(&candidates, preferred_edges) else {
        return PreviewScaleSnapResult {
            snapped_scale: proposed_scale,
            active_lines: Vec::new(),
        };
    };
    // `best.lines` is only the guide for the edge that decided the scale. The
    // guides actually drawn are recomputed below, because snapping one edge can
    // bring others flush at the same time.
    let snapped_left = position.x - aabb_base_half_w * best.scale;
    let snapped_right = position.x + aabb_base_half_w * best.scale;
    let snapped_top = position.y - aabb_base_half_h * best.scale;
    let snapped_bottom = position.y + aabb_base_half_h * best.scale;

    // One canvas unit of slack: the snapped scale is exact for the edge that
    // won, and within rounding of any other edge that happens to coincide.
    let mut active_lines: Vec<PreviewSnapLine> = Vec::new();
    for target in &vertical {
        let touches_left = (snapped_left - target.position).abs() <= 1.0;
        let touches_right = (snapped_right - target.position).abs() <= 1.0;
        let draw = (has_preferred_edge(preferred_edges, ScaleEdge::Left) && touches_left)
            || (has_preferred_edge(preferred_edges, ScaleEdge::Right) && touches_right)
            || (preferred_edges.is_none() && (touches_left || touches_right));
        if draw {
            push_unique_line(&mut active_lines, target.line);
        }
    }
    for target in &horizontal {
        let touches_top = (snapped_top - target.position).abs() <= 1.0;
        let touches_bottom = (snapped_bottom - target.position).abs() <= 1.0;
        let draw = (has_preferred_edge(preferred_edges, ScaleEdge::Top) && touches_top)
            || (has_preferred_edge(preferred_edges, ScaleEdge::Bottom) && touches_bottom)
            || (preferred_edges.is_none() && (touches_top || touches_bottom));
        if draw {
            push_unique_line(&mut active_lines, target.line);
        }
    }

    PreviewScaleSnapResult {
        snapped_scale: best.scale,
        active_lines,
    }
}

// Per-axis scale snapping.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapScaleAxesOptions {
    pub proposed_scale_x: f64,
    pub proposed_scale_y: f64,
    pub position: PreviewSnapPoint,
    pub base_width: f64,
    pub base_height: f64,
    #[serde(default)]
    pub rotation: Option<f64>,
    pub canvas_size: PreviewSnapSize,
    pub snap_threshold: PreviewSnapPoint,
    #[serde(default)]
    pub preferred_edges: Option<PreviewScaleEdgePreference>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAxisSnapResult {
    pub snapped_scale: f64,
    /// `Infinity` when no candidate was within threshold, so the caller can
    /// compare the two axes and take whichever snapped harder.
    pub snap_distance: f64,
    pub active_lines: Vec<PreviewSnapLine>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAxesSnapResult {
    pub x: PreviewAxisSnapResult,
    pub y: PreviewAxisSnapResult,
}

/// Rotations closer than this to an axis are treated as *on* it, because the
/// other axis then contributes nothing to the AABB and solving for its scale is
/// a division by (almost) zero.
const AXIS_CONTRIBUTION_EPSILON: f64 = 1e-6;

fn axis_result(
    candidates: &[ScaleCandidate],
    proposed_scale: f64,
    preferred_edges: Option<&PreviewScaleEdgePreference>,
) -> PreviewAxisSnapResult {
    match pick_closest_scale_candidate(candidates, preferred_edges) {
        None => PreviewAxisSnapResult {
            snapped_scale: proposed_scale,
            snap_distance: f64::INFINITY,
            active_lines: Vec::new(),
        },
        Some(best) => PreviewAxisSnapResult {
            snapped_scale: best.scale,
            snap_distance: best.distance,
            active_lines: best.lines.clone(),
        },
    }
}

/// Snap `scaleX` and `scaleY` independently, for a side handle or a corner drag
/// with the aspect ratio unlocked.
///
/// Each axis is solved from the AABB equation with the *other* axis held at its
/// proposed scale, which is why the numerators subtract the other axis's
/// contribution. A rotated element's AABB mixes both scales, so a vertical guide
/// can constrain `scaleY` and a horizontal one `scaleX` — the two blocks per
/// axis are those two routes, each valid only while its factor is non-zero.
#[export]
pub fn preview_snap_scale_axes(
    PreviewSnapScaleAxesOptions {
        proposed_scale_x,
        proposed_scale_y,
        position,
        base_width,
        base_height,
        rotation,
        canvas_size,
        snap_threshold,
        preferred_edges,
    }: PreviewSnapScaleAxesOptions,
) -> PreviewAxesSnapResult {
    let rotation = rotation.unwrap_or(0.0);
    let preferred_edges = preferred_edges.as_ref();

    let canvas_left = -canvas_size.width / 2.0;
    let canvas_right = canvas_size.width / 2.0;
    let canvas_top = -canvas_size.height / 2.0;
    let canvas_bottom = canvas_size.height / 2.0;

    let (cos_r, sin_r) = rotation_factors(rotation);

    let current_aabb_half_w =
        (base_width * proposed_scale_x * cos_r + base_height * proposed_scale_y * sin_r) / 2.0;
    let current_aabb_half_h =
        (base_width * proposed_scale_x * sin_r + base_height * proposed_scale_y * cos_r) / 2.0;
    let current_left_edge = position.x - current_aabb_half_w;
    let current_right_edge = position.x + current_aabb_half_w;
    let current_top_edge = position.y - current_aabb_half_h;
    let current_bottom_edge = position.y + current_aabb_half_h;

    let mut x_candidates: Vec<ScaleCandidate> = Vec::new();
    let y_contrib_w = base_height * proposed_scale_y * sin_r;
    let y_contrib_h = base_height * proposed_scale_y * cos_r;

    if cos_r > AXIS_CONTRIBUTION_EPSILON {
        for target in [canvas_left, 0.0, canvas_right] {
            let line = PreviewSnapLine {
                kind: PreviewSnapLineKind::Vertical,
                position: target,
            };
            let distance_left = (current_left_edge - target).abs();
            if distance_left <= snap_threshold.x {
                let scale = (2.0 * (position.x - target) - y_contrib_w) / (base_width * cos_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    x_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_left,
                        lines: vec![line],
                        edge: ScaleEdge::Left,
                    });
                }
            }
            let distance_right = (current_right_edge - target).abs();
            if distance_right <= snap_threshold.x {
                let scale = (2.0 * (target - position.x) - y_contrib_w) / (base_width * cos_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    x_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_right,
                        lines: vec![line],
                        edge: ScaleEdge::Right,
                    });
                }
            }
        }
    }

    if sin_r > AXIS_CONTRIBUTION_EPSILON {
        for target in [canvas_top, 0.0, canvas_bottom] {
            let line = PreviewSnapLine {
                kind: PreviewSnapLineKind::Horizontal,
                position: target,
            };
            let distance_top = (current_top_edge - target).abs();
            if distance_top <= snap_threshold.y {
                let scale = (2.0 * (position.y - target) - y_contrib_h) / (base_width * sin_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    x_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_top,
                        lines: vec![line],
                        edge: ScaleEdge::Top,
                    });
                }
            }
            let distance_bottom = (current_bottom_edge - target).abs();
            if distance_bottom <= snap_threshold.y {
                let scale = (2.0 * (target - position.y) - y_contrib_h) / (base_width * sin_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    x_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_bottom,
                        lines: vec![line],
                        edge: ScaleEdge::Bottom,
                    });
                }
            }
        }
    }

    let mut y_candidates: Vec<ScaleCandidate> = Vec::new();
    let x_contrib_w = base_width * proposed_scale_x * cos_r;
    let x_contrib_h = base_width * proposed_scale_x * sin_r;

    if sin_r > AXIS_CONTRIBUTION_EPSILON {
        for target in [canvas_left, 0.0, canvas_right] {
            let line = PreviewSnapLine {
                kind: PreviewSnapLineKind::Vertical,
                position: target,
            };
            let distance_left = (current_left_edge - target).abs();
            if distance_left <= snap_threshold.x {
                let scale = (2.0 * (position.x - target) - x_contrib_w) / (base_height * sin_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    y_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_left,
                        lines: vec![line],
                        edge: ScaleEdge::Left,
                    });
                }
            }
            let distance_right = (current_right_edge - target).abs();
            if distance_right <= snap_threshold.x {
                let scale = (2.0 * (target - position.x) - x_contrib_w) / (base_height * sin_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    y_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_right,
                        lines: vec![line],
                        edge: ScaleEdge::Right,
                    });
                }
            }
        }
    }

    if cos_r > AXIS_CONTRIBUTION_EPSILON {
        for target in [canvas_top, 0.0, canvas_bottom] {
            let line = PreviewSnapLine {
                kind: PreviewSnapLineKind::Horizontal,
                position: target,
            };
            let distance_top = (current_top_edge - target).abs();
            if distance_top <= snap_threshold.y {
                let scale = (2.0 * (position.y - target) - x_contrib_h) / (base_height * cos_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    y_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_top,
                        lines: vec![line],
                        edge: ScaleEdge::Top,
                    });
                }
            }
            let distance_bottom = (current_bottom_edge - target).abs();
            if distance_bottom <= snap_threshold.y {
                let scale = (2.0 * (target - position.y) - x_contrib_h) / (base_height * cos_r);
                if scale.abs() > PREVIEW_MIN_SCALE {
                    y_candidates.push(ScaleCandidate {
                        scale,
                        distance: distance_bottom,
                        lines: vec![line],
                        edge: ScaleEdge::Bottom,
                    });
                }
            }
        }
    }

    PreviewAxesSnapResult {
        x: axis_result(&x_candidates, proposed_scale_x, preferred_edges),
        y: axis_result(&y_candidates, proposed_scale_y, preferred_edges),
    }
}

// Rotation snapping.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapRotationOptions {
    pub proposed_rotation: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRotationSnapResult {
    pub snapped_rotation: f64,
    pub is_snapped: bool,
}

/// Snap a rotation to the nearest right angle when it is close enough.
#[export]
pub fn preview_snap_rotation(
    PreviewSnapRotationOptions { proposed_rotation }: PreviewSnapRotationOptions,
) -> PreviewRotationSnapResult {
    let nearest_rotation_snap =
        js_round(proposed_rotation / ROTATION_SNAP_STEP_DEGREES)
            * ROTATION_SNAP_STEP_DEGREES;
    let distance_to_nearest_snap = (proposed_rotation - nearest_rotation_snap).abs();
    if distance_to_nearest_snap <= ROTATION_SNAP_THRESHOLD_DEGREES {
        return PreviewRotationSnapResult {
            snapped_rotation: nearest_rotation_snap,
            is_snapped: true,
        };
    }
    PreviewRotationSnapResult {
        snapped_rotation: proposed_rotation,
        is_snapped: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANVAS: PreviewSnapSize = PreviewSnapSize {
        width: 1920.0,
        height: 1080.0,
    };
    const ELEMENT: PreviewSnapSize = PreviewSnapSize {
        width: 100.0,
        height: 50.0,
    };
    const THRESHOLD: PreviewSnapPoint = PreviewSnapPoint { x: 8.0, y: 8.0 };

    fn position_options(x: f64, y: f64) -> PreviewSnapPositionOptions {
        PreviewSnapPositionOptions {
            proposed_position: PreviewSnapPoint { x, y },
            canvas_size: CANVAS,
            element_size: ELEMENT,
            rotation: None,
            snap_threshold: THRESHOLD,
        }
    }

    fn vertical(position: f64) -> PreviewSnapLine {
        PreviewSnapLine {
            kind: PreviewSnapLineKind::Vertical,
            position,
        }
    }

    fn horizontal(position: f64) -> PreviewSnapLine {
        PreviewSnapLine {
            kind: PreviewSnapLineKind::Horizontal,
            position,
        }
    }

    #[test]
    fn position_snaps_to_the_canvas_centre_inside_the_threshold() {
        let result = preview_snap_position(position_options(3.0, -2.0));
        assert_eq!(result.snapped_position, PreviewSnapPoint { x: 0.0, y: 0.0 });
        assert_eq!(result.active_lines, vec![vertical(0.0), horizontal(0.0)]);
    }

    #[test]
    fn position_is_left_alone_outside_the_threshold() {
        let result = preview_snap_position(position_options(100.0, 200.0));
        assert_eq!(
            result.snapped_position,
            PreviewSnapPoint { x: 100.0, y: 200.0 }
        );
        assert!(result.active_lines.is_empty());
    }

    #[test]
    fn position_snaps_the_left_edge_flush_with_the_canvas_left() {
        // The element's left edge sits 2 units inside the frame; snapping puts
        // the *centre* half a width in from the canvas edge.
        let result = preview_snap_position(position_options(-908.0, 300.0));
        assert_eq!(
            result.snapped_position,
            PreviewSnapPoint {
                x: -910.0,
                y: 300.0
            }
        );
        assert_eq!(result.active_lines, vec![vertical(-960.0)]);
    }

    #[test]
    fn position_snaps_the_right_edge_flush_with_the_canvas_right() {
        let result = preview_snap_position(position_options(906.0, 300.0));
        assert_eq!(
            result.snapped_position,
            PreviewSnapPoint { x: 910.0, y: 300.0 }
        );
        assert_eq!(result.active_lines, vec![vertical(960.0)]);
    }

    #[test]
    fn position_snaps_the_top_and_bottom_edges() {
        let top = preview_snap_position(position_options(400.0, -512.0));
        assert_eq!(
            top.snapped_position,
            PreviewSnapPoint {
                x: 400.0,
                y: -515.0
            }
        );
        assert_eq!(top.active_lines, vec![horizontal(-540.0)]);

        let bottom = preview_snap_position(position_options(400.0, 512.0));
        assert_eq!(
            bottom.snapped_position,
            PreviewSnapPoint { x: 400.0, y: 515.0 }
        );
        assert_eq!(bottom.active_lines, vec![horizontal(540.0)]);
    }

    #[test]
    fn position_snapping_works_at_negative_coordinates_on_both_axes() {
        let result = preview_snap_position(position_options(-908.0, -513.0));
        // Both axes snap by their near edge: -960 + 50 and -540 + 25.
        assert_eq!(
            result.snapped_position,
            PreviewSnapPoint {
                x: -910.0,
                y: -515.0
            }
        );
        assert_eq!(
            result.active_lines,
            vec![vertical(-960.0), horizontal(-540.0)]
        );
    }

    fn scale_options(
        proposed_scale: f64,
        position: PreviewSnapPoint,
        preferred_edges: Option<PreviewScaleEdgePreference>,
    ) -> PreviewSnapScaleOptions {
        PreviewSnapScaleOptions {
            proposed_scale,
            position,
            base_width: 100.0,
            base_height: 100.0,
            rotation: None,
            canvas_size: PreviewSnapSize {
                width: 1000.0,
                height: 1000.0,
            },
            snap_threshold: THRESHOLD,
            preferred_edges,
        }
    }

    #[test]
    fn scale_snaps_the_right_edge_onto_the_canvas_right() {
        let result = preview_snap_scale(scale_options(
            4.1,
            PreviewSnapPoint { x: 300.0, y: 0.0 },
            None,
        ));
        assert_eq!(result.snapped_scale, 4.0);
        assert_eq!(result.active_lines, vec![vertical(500.0)]);
    }

    #[test]
    fn scale_refuses_a_snap_that_would_collapse_the_element() {
        // Both edges are within the threshold of the centre line, but the only
        // scale that would put them there is 0.
        let result = preview_snap_scale(scale_options(
            0.05,
            PreviewSnapPoint { x: 0.0, y: 0.0 },
            None,
        ));
        assert_eq!(result.snapped_scale, 0.05);
        assert!(result.active_lines.is_empty());
        assert_eq!(PREVIEW_MIN_SCALE, 0.01);
    }

    #[test]
    fn scale_lights_up_every_touching_guide_when_no_edge_is_preferred() {
        // A centred element scaled to exactly fill the frame touches all four.
        let result = preview_snap_scale(scale_options(
            10.0,
            PreviewSnapPoint { x: 0.0, y: 0.0 },
            None,
        ));
        assert_eq!(result.snapped_scale, 10.0);
        assert_eq!(
            result.active_lines,
            vec![
                vertical(-500.0),
                vertical(500.0),
                horizontal(-500.0),
                horizontal(500.0),
            ]
        );
    }

    #[test]
    fn scale_keeps_only_the_preferred_edges_guide() {
        // Same geometry, but the gesture is dragging the right edge: the tie
        // between four equidistant candidates goes to it, and it is the only
        // guide drawn.
        let result = preview_snap_scale(scale_options(
            10.0,
            PreviewSnapPoint { x: 0.0, y: 0.0 },
            Some(PreviewScaleEdgePreference {
                right: Some(true),
                ..PreviewScaleEdgePreference::default()
            }),
        ));
        assert_eq!(result.snapped_scale, 10.0);
        assert_eq!(result.active_lines, vec![vertical(500.0)]);
    }

    #[test]
    fn scale_draws_nothing_when_the_preference_names_no_edge() {
        // Present-but-empty is not the same as absent: the caller said "no
        // edge", so no guide belongs on screen.
        let result = preview_snap_scale(scale_options(
            10.0,
            PreviewSnapPoint { x: 0.0, y: 0.0 },
            Some(PreviewScaleEdgePreference::default()),
        ));
        assert_eq!(result.snapped_scale, 10.0);
        assert!(result.active_lines.is_empty());
    }

    fn axes_options(
        proposed_scale_x: f64,
        proposed_scale_y: f64,
        rotation: Option<f64>,
    ) -> PreviewSnapScaleAxesOptions {
        PreviewSnapScaleAxesOptions {
            proposed_scale_x,
            proposed_scale_y,
            position: PreviewSnapPoint { x: 300.0, y: 0.0 },
            base_width: 100.0,
            base_height: 100.0,
            rotation,
            canvas_size: PreviewSnapSize {
                width: 1000.0,
                height: 1000.0,
            },
            snap_threshold: THRESHOLD,
            preferred_edges: None,
        }
    }

    #[test]
    fn axis_snapping_touches_only_the_axis_that_is_near_a_target() {
        // Unrotated, so `sinR` is zero and neither axis can be solved through
        // the other's targets. 4.125 rather than 4.1 so every intermediate is
        // exact in binary and the distance can be asserted, not approximated.
        let result = preview_snap_scale_axes(axes_options(4.125, 1.0, None));
        assert_eq!(result.x.snapped_scale, 4.0);
        assert_eq!(result.x.snap_distance, 6.25);
        assert_eq!(result.x.active_lines, vec![vertical(500.0)]);

        assert_eq!(result.y.snapped_scale, 1.0);
        assert_eq!(result.y.snap_distance, f64::INFINITY);
        assert!(result.y.active_lines.is_empty());
    }

    #[test]
    fn axis_snapping_leaves_both_axes_alone_when_nothing_is_in_range() {
        let result = preview_snap_scale_axes(axes_options(1.0, 1.0, None));
        assert_eq!(result.x.snapped_scale, 1.0);
        assert_eq!(result.x.snap_distance, f64::INFINITY);
        assert_eq!(result.y.snapped_scale, 1.0);
        assert_eq!(result.y.snap_distance, f64::INFINITY);
    }

    #[test]
    fn axis_snapping_solves_through_both_target_sets_when_rotated_off_axis() {
        // At 45° both factors are non-zero, so a vertical target constrains
        // `scaleX` and `scaleY` alike. Centred, scaled to just under full
        // bleed: all four AABB edges are ~5 units short of the frame.
        let options = PreviewSnapScaleAxesOptions {
            position: PreviewSnapPoint { x: 0.0, y: 0.0 },
            rotation: Some(45.0),
            ..axes_options(7.0, 7.0, Some(45.0))
        };
        let result = preview_snap_scale_axes(options);

        // The first candidate in range wins the tie: the left AABB edge against
        // the canvas's left.
        assert_eq!(result.x.active_lines, vec![vertical(-500.0)]);
        assert_eq!(result.y.active_lines, vec![vertical(-500.0)]);
        // Solving `(w·sx·cos + h·sy·sin) / 2 = 500` with `sy` held at 7 gives
        // the same number on both axes here, since the element is square.
        assert!((result.x.snapped_scale - 7.142_135_6).abs() < 1e-6);
        assert!((result.y.snapped_scale - 7.142_135_6).abs() < 1e-6);
        assert!((result.x.snap_distance - 5.025_253_2).abs() < 1e-6);
    }

    #[test]
    fn rotation_snaps_at_each_right_angle() {
        for (proposed, expected) in [
            (2.0, 0.0),
            (88.0, 90.0),
            (92.0, 90.0),
            (178.0, 180.0),
            (271.0, 270.0),
            (-88.0, -90.0),
            (-181.0, -180.0),
        ] {
            let result = preview_snap_rotation(PreviewSnapRotationOptions {
                proposed_rotation: proposed,
            });
            assert!(result.is_snapped, "{proposed} should snap");
            assert_eq!(result.snapped_rotation, expected, "{proposed}");
        }
    }

    #[test]
    fn rotation_is_left_alone_between_the_right_angles() {
        for proposed in [45.0, -45.0, 30.0, 50.0, 120.0, -135.0] {
            let result = preview_snap_rotation(PreviewSnapRotationOptions {
                proposed_rotation: proposed,
            });
            assert!(!result.is_snapped, "{proposed} should not snap");
            assert_eq!(result.snapped_rotation, proposed);
        }
    }

    #[test]
    fn rotation_snapping_holds_at_the_threshold_boundary() {
        // 5° is inside, 5.0000001° is not.
        let inside = preview_snap_rotation(PreviewSnapRotationOptions {
            proposed_rotation: 85.0,
        });
        assert!(inside.is_snapped);
        assert_eq!(inside.snapped_rotation, 90.0);

        let outside = preview_snap_rotation(PreviewSnapRotationOptions {
            proposed_rotation: 84.9,
        });
        assert!(!outside.is_snapped);
        assert_eq!(outside.snapped_rotation, 84.9);
    }

    #[test]
    fn a_small_negative_rotation_snaps_to_negative_zero() {
        // `Math.round(-0.022)` is `-0` in JavaScript and the sign rides through
        // the multiply. Getting this wrong is invisible to `==` and caught only
        // by the sign bit.
        let result = preview_snap_rotation(PreviewSnapRotationOptions {
            proposed_rotation: -2.0,
        });
        assert!(result.is_snapped);
        assert_eq!(result.snapped_rotation, 0.0);
        assert!(
            result.snapped_rotation.is_sign_negative(),
            "expected -0, got a positive zero"
        );
    }

    #[test]
    fn a_small_positive_rotation_snaps_to_positive_zero() {
        let result = preview_snap_rotation(PreviewSnapRotationOptions {
            proposed_rotation: 2.0,
        });
        assert!(result.is_snapped);
        assert!(!result.snapped_rotation.is_sign_negative());
    }

    #[test]
    fn a_rotation_tie_rounds_toward_positive_infinity() {
        // -45 / 90 is exactly -0.5, which `Math.round` sends to -0, not -1.
        // `f64::round` would give -1 and snap the element to -90°.
        let result = preview_snap_rotation(PreviewSnapRotationOptions {
            proposed_rotation: -45.0,
        });
        assert!(!result.is_snapped);
        assert_eq!(result.snapped_rotation, -45.0);
    }

    #[test]
    fn a_duplicate_guide_is_only_drawn_once() {
        let mut lines = vec![vertical(0.0)];
        push_unique_line(&mut lines, vertical(-0.0));
        assert_eq!(lines.len(), 1, "-0 and 0 are the same line");
        push_unique_line(&mut lines, horizontal(0.0));
        assert_eq!(lines.len(), 2, "a horizontal at 0 is a different line");
    }
}
