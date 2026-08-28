//! The outlines the built-in shape masks draw — rectangle, ellipse, diamond,
//! star, heart and the cinematic bars.
//!
//! Each of `apps/web/src/masks/builtin/definitions/*.ts` used to compute its
//! own vertices and hand them to a `Path2D`. The vertices are plain
//! trigonometry over the mask's canvas geometry, so they live here; the
//! `Path2D` — a browser object with no meaning outside the canvas — is built
//! by the façade from the command list this returns.
//!
//! Both halves of each definition are covered:
//!
//! - the **outline**, in canvas units, for the body fill and for the stroke
//!   (the same shape grown or shrunk by the stroke alignment offset), and
//! - the **overlay path**, an SVG `d` string in the interaction layer's own
//!   normalised box, which the preview draws on top of the element while a
//!   mask is selected.
//!
//! The overlay strings are assembled with [`js_number_to_string`] rather than
//! Rust's `Display`: they are string-compared against what the TypeScript
//! produced, and the two disagree on negative zero — which a degenerate mask
//! size reaches by way of `-halfHeight * 0.125`.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::masks::builtin::box_like::{
    get_default_base_mask_params, get_stroke_offset, GetDefaultSquareMaskParamsOptions,
    GetStrokeOffsetOptions, MIN_MASK_DIMENSION,
};
use crate::masks::snap::{BaseMaskParams, RectangleMaskParams};
use crate::math::geometry::{rotate_point_around, GeometryPoint};
use crate::math::js_number_to_string;

/// Fraction of the outer radius the star's inner vertices sit at.
const STAR_INNER_RADIUS_RATIO: f64 = 0.45;

/// Outer and inner vertices together, alternating — a five-pointed star.
const STAR_VERTEX_COUNT: usize = 10;

/// Smallest height the cinematic bars mask will draw. Unlike the other shapes
/// the bars clamp their own height rather than going through
/// [`MIN_MASK_DIMENSION`], because the band spans the frame horizontally and
/// only its height is a real dimension.
const CINEMATIC_BARS_MIN_HEIGHT: f64 = 0.01;

/// Which built-in shape an outline is for. The wire values are the `type`
/// strings on the TypeScript `MaskDefinition`s.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MaskShapeKind {
    Rectangle,
    Ellipse,
    Diamond,
    Star,
    Heart,
    CinematicBars,
}

/// Which of a shape's two outlines is wanted. The stroke outline is the body
/// grown by the stroke-alignment offset, floored so an inside-aligned stroke
/// on a thin mask cannot invert the shape.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskOutlineKind {
    Body,
    Stroke,
}

/// One step of a mask outline, in canvas units.
///
/// The set is exactly what the shape masks need and what `Path2D` answers to:
/// straight segments for the polygons, one cubic for each half of the heart,
/// and a whole-ellipse arc for the ellipse — which is a single `ctx.ellipse`
/// call rather than four beziers, so it stays a command of its own.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MaskOutlineCommand {
    MoveTo {
        x: f64,
        y: f64,
    },
    LineTo {
        x: f64,
        y: f64,
    },
    CubicTo {
        control1: GeometryPoint,
        control2: GeometryPoint,
        end: GeometryPoint,
    },
    Ellipse {
        center_x: f64,
        center_y: f64,
        radius_x: f64,
        radius_y: f64,
        rotation_rad: f64,
    },
    ClosePath,
}

/// A shape's outline as a command list. Wrapped in a struct rather than
/// returned as a bare `Vec`, which crosses the bridge as an object with
/// numeric keys.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskShapeOutline {
    pub commands: Vec<MaskOutlineCommand>,
}

/// The placement an outline is drawn at: where the shape's centre sits, its
/// half-extents, and how far it is turned.
#[derive(Clone, Copy, Debug, PartialEq)]
struct ShapePlacement {
    center_x: f64,
    center_y: f64,
    half_width: f64,
    half_height: f64,
    rotation_rad: f64,
}

/// Canvas geometry for the shapes that inscribe themselves in the mask's box.
/// Mirrors `getBoxLikeGeometry`, whose result each definition halved before
/// building its path.
fn box_like_placement(params: &RectangleMaskParams, width: f64, height: f64) -> ShapePlacement {
    ShapePlacement {
        center_x: width / 2.0 + params.center_x * width,
        center_y: height / 2.0 + params.center_y * height,
        half_width: (params.width.max(MIN_MASK_DIMENSION) * width) / 2.0,
        half_height: (params.height.max(MIN_MASK_DIMENSION) * height) / 2.0,
        rotation_rad: (params.rotation * std::f64::consts::PI) / 180.0,
    }
}

/// Canvas geometry for the cinematic bars, which do not go through
/// `getBoxLikeGeometry`: the band is never narrower than the frame — that is
/// what lets it stay full-bleed when it is rotated — and its height has its
/// own floor.
fn cinematic_bars_placement(
    params: &RectangleMaskParams,
    width: f64,
    height: f64,
) -> ShapePlacement {
    ShapePlacement {
        center_x: width / 2.0 + params.center_x * width,
        center_y: height / 2.0 + params.center_y * height,
        half_width: (params.width * width).max(width) / 2.0,
        half_height: (params.height.max(CINEMATIC_BARS_MIN_HEIGHT) * height) / 2.0,
        rotation_rad: (params.rotation * std::f64::consts::PI) / 180.0,
    }
}

/// The stroke outline's placement: the body grown by the stroke offset, with
/// each half-extent floored at one canvas pixel so an inside stroke on a thin
/// mask does not fold the shape through itself.
fn grow_for_stroke(placement: ShapePlacement, offset: f64) -> ShapePlacement {
    ShapePlacement {
        half_width: (placement.half_width + offset).max(1.0),
        half_height: (placement.half_height + offset).max(1.0),
        ..placement
    }
}

fn polygon_commands(points: &[GeometryPoint]) -> Vec<MaskOutlineCommand> {
    let mut commands = Vec::with_capacity(points.len() + 2);
    for (index, point) in points.iter().enumerate() {
        commands.push(if index == 0 {
            MaskOutlineCommand::MoveTo {
                x: point.x,
                y: point.y,
            }
        } else {
            MaskOutlineCommand::LineTo {
                x: point.x,
                y: point.y,
            }
        });
    }
    commands.push(MaskOutlineCommand::ClosePath);
    commands
}

fn rotate_local(placement: ShapePlacement, local_x: f64, local_y: f64) -> GeometryPoint {
    rotate_point_around(
        placement.center_x + local_x,
        placement.center_y + local_y,
        placement.center_x,
        placement.center_y,
        placement.rotation_rad,
    )
}

fn rectangle_commands(placement: ShapePlacement) -> Vec<MaskOutlineCommand> {
    let corners = [
        rotate_local(placement, -placement.half_width, -placement.half_height),
        rotate_local(placement, placement.half_width, -placement.half_height),
        rotate_local(placement, placement.half_width, placement.half_height),
        rotate_local(placement, -placement.half_width, placement.half_height),
    ];
    polygon_commands(&corners)
}

fn diamond_commands(placement: ShapePlacement) -> Vec<MaskOutlineCommand> {
    let points = [
        rotate_local(placement, 0.0, -placement.half_height),
        rotate_local(placement, placement.half_width, 0.0),
        rotate_local(placement, 0.0, placement.half_height),
        rotate_local(placement, -placement.half_width, 0.0),
    ];
    polygon_commands(&points)
}

/// The star's vertices, outer and inner alternating, starting at the point
/// facing straight up.
fn star_points(placement: ShapePlacement) -> Vec<GeometryPoint> {
    (0..STAR_VERTEX_COUNT)
        .map(|index| {
            let is_outer_vertex = index % 2 == 0;
            let radius_x = if is_outer_vertex {
                placement.half_width
            } else {
                placement.half_width * STAR_INNER_RADIUS_RATIO
            };
            let radius_y = if is_outer_vertex {
                placement.half_height
            } else {
                placement.half_height * STAR_INNER_RADIUS_RATIO
            };
            let angle = (index as f64 * std::f64::consts::PI) / 5.0 - std::f64::consts::FRAC_PI_2;
            rotate_local(placement, radius_x * angle.cos(), radius_y * angle.sin())
        })
        .collect()
}

fn star_commands(placement: ShapePlacement) -> Vec<MaskOutlineCommand> {
    polygon_commands(&star_points(placement))
}

/// Two cubics, one per lobe, meeting at the cleft and at the point. The
/// multipliers are the shape's proportions and nothing else derives them.
fn heart_commands(placement: ShapePlacement) -> Vec<MaskOutlineCommand> {
    let half_width = placement.half_width;
    let half_height = placement.half_height;

    let start = rotate_local(placement, 0.0, -half_height * 0.475);
    let right_control1 = rotate_local(placement, half_width, -half_height * 1.225);
    let right_control2 = rotate_local(placement, half_width, -half_height * 0.125);
    let bottom = rotate_local(placement, 0.0, half_height * 0.725);
    let left_control1 = rotate_local(placement, -half_width, -half_height * 0.125);
    let left_control2 = rotate_local(placement, -half_width, -half_height * 1.225);

    vec![
        MaskOutlineCommand::MoveTo {
            x: start.x,
            y: start.y,
        },
        MaskOutlineCommand::CubicTo {
            control1: right_control1,
            control2: right_control2,
            end: bottom,
        },
        MaskOutlineCommand::CubicTo {
            control1: left_control1,
            control2: left_control2,
            end: start,
        },
        MaskOutlineCommand::ClosePath,
    ]
}

fn ellipse_commands(placement: ShapePlacement) -> Vec<MaskOutlineCommand> {
    vec![MaskOutlineCommand::Ellipse {
        center_x: placement.center_x,
        center_y: placement.center_y,
        radius_x: placement.half_width,
        radius_y: placement.half_height,
        rotation_rad: placement.rotation_rad,
    }]
}

/// Args to [`build_mask_shape_outline`].
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildMaskShapeOutlineOptions {
    pub shape: MaskShapeKind,
    pub params: RectangleMaskParams,
    /// The element's canvas size, in pixels.
    pub width: f64,
    pub height: f64,
    pub outline: MaskOutlineKind,
}

/// The shape's outline in canvas units, ready to be replayed into a `Path2D`.
#[export]
pub fn build_mask_shape_outline(
    BuildMaskShapeOutlineOptions {
        shape,
        params,
        width,
        height,
        outline,
    }: BuildMaskShapeOutlineOptions,
) -> MaskShapeOutline {
    let placement = if shape == MaskShapeKind::CinematicBars {
        cinematic_bars_placement(&params, width, height)
    } else {
        box_like_placement(&params, width, height)
    };
    let placement = match outline {
        MaskOutlineKind::Body => placement,
        MaskOutlineKind::Stroke => grow_for_stroke(
            placement,
            get_stroke_offset(GetStrokeOffsetOptions {
                stroke_align: params.base.stroke_align.clone(),
                stroke_width: params.base.stroke_width,
            }),
        ),
    };

    MaskShapeOutline {
        commands: match shape {
            MaskShapeKind::Rectangle | MaskShapeKind::CinematicBars => {
                rectangle_commands(placement)
            }
            MaskShapeKind::Diamond => diamond_commands(placement),
            MaskShapeKind::Star => star_commands(placement),
            MaskShapeKind::Heart => heart_commands(placement),
            MaskShapeKind::Ellipse => ellipse_commands(placement),
        },
    }
}

/// Args to [`build_mask_shape_overlay_path`]. The size is the shape's own box
/// in the overlay's coordinates, which the interaction layer has already
/// scaled — so the path is always drawn from `0,0`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskShapeOverlayPathOptions {
    pub shape: MaskShapeKind,
    pub width: f64,
    pub height: f64,
}

/// The SVG `d` string the preview outlines a selected mask with.
///
/// The rectangle has none: its overlay is the bounding box the interaction
/// layer already draws, so asking for one answers the empty string, which is
/// what `getBoxMaskOverlays` reads as "no path".
#[export]
pub fn build_mask_shape_overlay_path(
    MaskShapeOverlayPathOptions {
        shape,
        width,
        height,
    }: MaskShapeOverlayPathOptions,
) -> String {
    let number = js_number_to_string;
    let center_x = width / 2.0;
    let center_y = height / 2.0;
    let half_width = width / 2.0;
    let half_height = height / 2.0;

    match shape {
        MaskShapeKind::Rectangle => String::new(),
        MaskShapeKind::CinematicBars => format!(
            "M 0,0 H {} V {} H 0 Z",
            number(width),
            number(height)
        ),
        MaskShapeKind::Diamond => format!(
            "M {},0 L {},{} L {},{} L 0,{} Z",
            number(width / 2.0),
            number(width),
            number(height / 2.0),
            number(width / 2.0),
            number(height),
            number(height / 2.0),
        ),
        MaskShapeKind::Ellipse => {
            let radius_x = ((width - 1.0) / 2.0).max(0.0);
            let radius_y = ((height - 1.0) / 2.0).max(0.0);
            format!(
                "M {},{} A {},{} 0 1,1 {},{} A {},{} 0 1,1 {},{} Z",
                number(center_x),
                number(center_y - radius_y),
                number(radius_x),
                number(radius_y),
                number(center_x),
                number(center_y + radius_y),
                number(radius_x),
                number(radius_y),
                number(center_x),
                number(center_y - radius_y),
            )
        }
        MaskShapeKind::Heart => format!(
            "M {},{} C {},{} {},{} {},{} C {},{} {},{} {},{} Z",
            number(center_x),
            number(center_y - half_height * 0.475),
            number(center_x + half_width),
            number(center_y - half_height * 1.225),
            number(center_x + half_width),
            number(center_y - half_height * 0.125),
            number(center_x),
            number(center_y + half_height * 0.725),
            number(center_x - half_width),
            number(center_y - half_height * 0.125),
            number(center_x - half_width),
            number(center_y - half_height * 1.225),
            number(center_x),
            number(center_y - half_height * 0.475),
        ),
        MaskShapeKind::Star => {
            let mut segments: Vec<String> = Vec::with_capacity(STAR_VERTEX_COUNT);
            for index in 0..STAR_VERTEX_COUNT {
                let is_outer_vertex = index % 2 == 0;
                let radius_x = if is_outer_vertex {
                    half_width
                } else {
                    half_width * STAR_INNER_RADIUS_RATIO
                };
                let radius_y = if is_outer_vertex {
                    half_height
                } else {
                    half_height * STAR_INNER_RADIUS_RATIO
                };
                let angle =
                    (index as f64 * std::f64::consts::PI) / 5.0 - std::f64::consts::FRAC_PI_2;
                segments.push(format!(
                    "{} {},{}",
                    if index == 0 { "M" } else { "L" },
                    number(center_x + radius_x * angle.cos()),
                    number(center_y + radius_y * angle.sin()),
                ));
            }
            format!("{} Z", segments.join(" "))
        }
    }
}

/// The cinematic bars' own defaults. Every other shape starts from
/// `getDefaultSquareMaskParams`; the bars start full-bleed instead, wide enough
/// that rotating them by any angle still covers the frame — which is the
/// diagonal, expressed as a multiple of the width.
#[export]
pub fn get_default_cinematic_bars_mask_params(
    GetDefaultSquareMaskParamsOptions { element_size }: GetDefaultSquareMaskParamsOptions,
) -> RectangleMaskParams {
    let abs_width = element_size.map(|size| size.width.abs()).unwrap_or(0.0);
    let abs_height = element_size.map(|size| size.height.abs()).unwrap_or(0.0);
    let diagonal = if abs_width > 0.0 && abs_height > 0.0 {
        (abs_width.powi(2) + abs_height.powi(2)).sqrt()
    } else {
        0.0
    };
    let full_span_width = if abs_width > 0.0 {
        diagonal / abs_width
    } else {
        std::f64::consts::SQRT_2
    };

    let defaults = get_default_base_mask_params();
    RectangleMaskParams {
        base: BaseMaskParams {
            feather: defaults.feather,
            inverted: defaults.inverted,
            stroke_color: defaults.stroke_color,
            stroke_width: defaults.stroke_width,
            stroke_align: defaults.stroke_align,
        },
        center_x: 0.0,
        center_y: 0.0,
        width: full_span_width.max(1.0),
        height: 0.6,
        rotation: 0.0,
        scale: 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::masks::builtin::box_like::BoxMaskDefaultElementSize;

    fn params(width: f64, height: f64, rotation: f64) -> RectangleMaskParams {
        RectangleMaskParams {
            base: BaseMaskParams {
                feather: 0.0,
                inverted: false,
                stroke_color: "#ffffff".to_string(),
                stroke_width: 0.0,
                stroke_align: "center".to_string(),
            },
            center_x: 0.0,
            center_y: 0.0,
            width,
            height,
            rotation,
            scale: 1.0,
        }
    }

    fn outline(shape: MaskShapeKind, params: RectangleMaskParams) -> Vec<MaskOutlineCommand> {
        build_mask_shape_outline(BuildMaskShapeOutlineOptions {
            shape,
            params,
            width: 200.0,
            height: 100.0,
            outline: MaskOutlineKind::Body,
        })
        .commands
    }

    fn approx(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 1e-9,
            "expected {expected}, got {actual}",
        );
    }

    #[test]
    fn a_rectangle_is_four_corners_and_a_close() {
        // Half the element on each axis, centred: the corners are at the
        // quarter and three-quarter marks of a 200x100 canvas.
        let commands = outline(MaskShapeKind::Rectangle, params(0.5, 0.5, 0.0));
        assert_eq!(commands.len(), 5);
        assert_eq!(commands[0], MaskOutlineCommand::MoveTo { x: 50.0, y: 25.0 });
        assert_eq!(commands[1], MaskOutlineCommand::LineTo { x: 150.0, y: 25.0 });
        assert_eq!(commands[2], MaskOutlineCommand::LineTo { x: 150.0, y: 75.0 });
        assert_eq!(commands[3], MaskOutlineCommand::LineTo { x: 50.0, y: 75.0 });
        assert_eq!(commands[4], MaskOutlineCommand::ClosePath);
    }

    #[test]
    fn a_degenerate_size_is_floored_rather_than_collapsed() {
        // MIN_MASK_DIMENSION keeps a zero-width mask drawable: 0.01 * 200 is
        // 2px wide, so the corners sit 1px either side of the centre.
        let commands = outline(MaskShapeKind::Rectangle, params(0.0, 0.0, 0.0));
        assert_eq!(commands[0], MaskOutlineCommand::MoveTo { x: 99.0, y: 49.5 });
    }

    #[test]
    fn rotation_turns_the_corners_about_the_centre() {
        // A quarter turn sends the top-left corner's (-50, -25) offset to
        // (25, -50), so it lands right of and above the centre. The box is
        // wider than it is tall, which is what makes the turned shape stick
        // out past the element vertically.
        let commands = outline(MaskShapeKind::Rectangle, params(0.5, 0.5, 90.0));
        match commands[0] {
            MaskOutlineCommand::MoveTo { x, y } => {
                approx(x, 125.0);
                approx(y, 0.0);
            }
            other => panic!("expected a moveTo, got {other:?}"),
        }
    }

    #[test]
    fn a_diamond_touches_the_middle_of_each_edge() {
        let commands = outline(MaskShapeKind::Diamond, params(0.5, 0.5, 0.0));
        assert_eq!(commands.len(), 5);
        assert_eq!(commands[0], MaskOutlineCommand::MoveTo { x: 100.0, y: 25.0 });
        assert_eq!(commands[1], MaskOutlineCommand::LineTo { x: 150.0, y: 50.0 });
        assert_eq!(commands[2], MaskOutlineCommand::LineTo { x: 100.0, y: 75.0 });
        assert_eq!(commands[3], MaskOutlineCommand::LineTo { x: 50.0, y: 50.0 });
    }

    #[test]
    fn a_star_alternates_ten_vertices_starting_at_the_top() {
        let commands = outline(MaskShapeKind::Star, params(0.5, 0.5, 0.0));
        assert_eq!(commands.len(), STAR_VERTEX_COUNT + 1);
        // The first vertex is outer and points straight up.
        match commands[0] {
            MaskOutlineCommand::MoveTo { x, y } => {
                approx(x, 100.0);
                approx(y, 25.0);
            }
            other => panic!("expected a moveTo, got {other:?}"),
        }
        // The second is an inner vertex: 0.45 of the radius, a fifth of a turn
        // clockwise from the top.
        match commands[1] {
            MaskOutlineCommand::LineTo { x, y } => {
                let angle = std::f64::consts::PI / 5.0 - std::f64::consts::FRAC_PI_2;
                approx(x, 100.0 + 50.0 * STAR_INNER_RADIUS_RATIO * angle.cos());
                approx(y, 50.0 + 25.0 * STAR_INNER_RADIUS_RATIO * angle.sin());
            }
            other => panic!("expected a lineTo, got {other:?}"),
        }
    }

    #[test]
    fn a_heart_is_two_cubics_from_the_cleft_back_to_itself() {
        let commands = outline(MaskShapeKind::Heart, params(0.5, 0.5, 0.0));
        assert_eq!(commands.len(), 4);
        let start = match commands[0] {
            MaskOutlineCommand::MoveTo { x, y } => GeometryPoint { x, y },
            other => panic!("expected a moveTo, got {other:?}"),
        };
        // The cleft sits above the centre by 0.475 of the half-height.
        approx(start.x, 100.0);
        approx(start.y, 50.0 - 25.0 * 0.475);
        match commands[2] {
            MaskOutlineCommand::CubicTo { end, .. } => assert_eq!(end, start),
            other => panic!("expected a cubicTo, got {other:?}"),
        }
        assert_eq!(commands[3], MaskOutlineCommand::ClosePath);
    }

    #[test]
    fn an_ellipse_is_one_command_carrying_its_radii() {
        let commands = outline(MaskShapeKind::Ellipse, params(0.5, 0.5, 180.0));
        assert_eq!(commands.len(), 1);
        match commands[0] {
            MaskOutlineCommand::Ellipse {
                center_x,
                center_y,
                radius_x,
                radius_y,
                rotation_rad,
            } => {
                approx(center_x, 100.0);
                approx(center_y, 50.0);
                approx(radius_x, 50.0);
                approx(radius_y, 25.0);
                approx(rotation_rad, std::f64::consts::PI);
            }
            other => panic!("expected an ellipse, got {other:?}"),
        }
    }

    #[test]
    fn the_bars_span_the_frame_however_narrow_the_param_is() {
        // 0.1 of the width would be 20px; the band is floored at the full
        // canvas width so a rotated bar still reaches both edges.
        let commands = outline(MaskShapeKind::CinematicBars, params(0.1, 0.6, 0.0));
        assert_eq!(commands[0], MaskOutlineCommand::MoveTo { x: 0.0, y: 20.0 });
        assert_eq!(commands[1], MaskOutlineCommand::LineTo { x: 200.0, y: 20.0 });
    }

    #[test]
    fn the_bars_have_their_own_height_floor() {
        // CINEMATIC_BARS_MIN_HEIGHT, not MIN_MASK_DIMENSION — they happen to be
        // the same number, and this pins that the bars clamp height only.
        let commands = outline(MaskShapeKind::CinematicBars, params(1.0, 0.0, 0.0));
        assert_eq!(commands[0], MaskOutlineCommand::MoveTo { x: 0.0, y: 49.5 });
    }

    #[test]
    fn an_outside_stroke_grows_the_outline_by_half_its_width() {
        let mut stroked = params(0.5, 0.5, 0.0);
        stroked.base.stroke_align = "outside".to_string();
        stroked.base.stroke_width = 10.0;
        let commands = build_mask_shape_outline(BuildMaskShapeOutlineOptions {
            shape: MaskShapeKind::Rectangle,
            params: stroked,
            width: 200.0,
            height: 100.0,
            outline: MaskOutlineKind::Stroke,
        })
        .commands;
        // Body half-extents are 50 x 25; +5 on each puts the corner at 45,20.
        assert_eq!(commands[0], MaskOutlineCommand::MoveTo { x: 45.0, y: 20.0 });
    }

    #[test]
    fn an_inside_stroke_cannot_shrink_a_thin_mask_through_itself() {
        // Half-extent 1px, stroke pulling 25px inward: floored at 1 rather than
        // going negative and inverting the winding.
        let mut stroked = params(0.01, 0.5, 0.0);
        stroked.base.stroke_align = "inside".to_string();
        stroked.base.stroke_width = 50.0;
        let commands = build_mask_shape_outline(BuildMaskShapeOutlineOptions {
            shape: MaskShapeKind::Rectangle,
            params: stroked,
            width: 200.0,
            height: 100.0,
            outline: MaskOutlineKind::Stroke,
        })
        .commands;
        // Both axes floor: the height's 25px half-extent is eaten entirely by
        // the same 25px inward offset.
        assert_eq!(commands[0], MaskOutlineCommand::MoveTo { x: 99.0, y: 49.0 });
    }

    #[test]
    fn the_rectangles_overlay_path_is_empty_so_the_bounding_box_stands_alone() {
        assert_eq!(
            build_mask_shape_overlay_path(MaskShapeOverlayPathOptions {
                shape: MaskShapeKind::Rectangle,
                width: 100.0,
                height: 50.0,
            }),
            "",
        );
    }

    #[test]
    fn overlay_paths_match_the_strings_the_definitions_emitted() {
        let bars = build_mask_shape_overlay_path(MaskShapeOverlayPathOptions {
            shape: MaskShapeKind::CinematicBars,
            width: 100.0,
            height: 50.0,
        });
        assert_eq!(bars, "M 0,0 H 100 V 50 H 0 Z");

        let diamond = build_mask_shape_overlay_path(MaskShapeOverlayPathOptions {
            shape: MaskShapeKind::Diamond,
            width: 100.0,
            height: 50.0,
        });
        assert_eq!(diamond, "M 50,0 L 100,25 L 50,50 L 0,25 Z");

        let ellipse = build_mask_shape_overlay_path(MaskShapeOverlayPathOptions {
            shape: MaskShapeKind::Ellipse,
            width: 100.0,
            height: 50.0,
        });
        assert_eq!(
            ellipse,
            "M 50,0.5 A 49.5,24.5 0 1,1 50,49.5 A 49.5,24.5 0 1,1 50,0.5 Z",
        );

        let heart = build_mask_shape_overlay_path(MaskShapeOverlayPathOptions {
            shape: MaskShapeKind::Heart,
            width: 100.0,
            height: 50.0,
        });
        assert_eq!(
            heart,
            // The long tail is `25 * 1.225` in binary floating point, and it
            // is in the string the TypeScript emitted too — the point of
            // pinning the whole string is that the digits agree.
            "M 50,13.125 C 100,-5.6250000000000036 100,21.875 50,43.125 \
             C 0,21.875 0,-5.6250000000000036 50,13.125 Z",
        );
    }

    #[test]
    fn a_zero_sized_overlay_never_prints_a_negative_zero() {
        // `-halfHeight * 0.125` is -0 at zero height, which Rust's Display
        // writes as "-0" and JavaScript writes as "0". The overlay string is
        // compared against the DOM's, so the JS rule is the one that holds.
        let heart = build_mask_shape_overlay_path(MaskShapeOverlayPathOptions {
            shape: MaskShapeKind::Heart,
            width: 0.0,
            height: 0.0,
        });
        assert!(!heart.contains("-0"), "negative zero reached the path: {heart}");
    }

    #[test]
    fn the_bars_default_to_the_diagonal_so_rotation_still_covers_the_frame() {
        // A 16:9 element's diagonal is sqrt(16^2 + 9^2) = 18.357…, which is
        // 1.147… times its width.
        let defaults =
            get_default_cinematic_bars_mask_params(GetDefaultSquareMaskParamsOptions {
                element_size: Some(BoxMaskDefaultElementSize {
                    width: 1600.0,
                    height: 900.0,
                }),
            });
        approx(defaults.width, (1600f64.powi(2) + 900f64.powi(2)).sqrt() / 1600.0);
        assert_eq!(defaults.height, 0.6);
        assert_eq!(defaults.center_x, 0.0);
        assert_eq!(defaults.scale, 1.0);
    }

    #[test]
    fn the_bars_fall_back_to_root_two_with_no_element_size() {
        let defaults =
            get_default_cinematic_bars_mask_params(GetDefaultSquareMaskParamsOptions {
                element_size: None,
            });
        assert_eq!(defaults.width, std::f64::consts::SQRT_2);
    }

    #[test]
    fn the_bars_width_never_falls_below_the_full_frame() {
        // A very tall element's diagonal-to-width ratio is large, but a very
        // wide one's approaches 1 from above — the floor is what guarantees it.
        let defaults =
            get_default_cinematic_bars_mask_params(GetDefaultSquareMaskParamsOptions {
                element_size: Some(BoxMaskDefaultElementSize {
                    width: 1000.0,
                    height: 0.0,
                }),
            });
        assert_eq!(defaults.width, 1.0);
    }
}
