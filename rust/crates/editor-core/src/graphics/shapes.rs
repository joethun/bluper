//! The outlines the built-in graphics draw —
//! `apps/web/src/graphics/definitions/*.ts`.
//!
//! Same split as the shape masks: the vertices, the radius clamps and the
//! corner tangents are arithmetic and live here; the `Path2D` they are played
//! into, the fills and the aligned stroke stay in the webview, which is where
//! a canvas exists.
//!
//! Every shape insets itself by half the stroke when the stroke is centred, so
//! a stroked graphic still fits its own box: a centred stroke straddles the
//! path, and without the inset its outer half would be cut off by the edge of
//! the element.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::math::js_round;

/// Which built-in graphic an outline is for. The wire values are the
/// definition ids.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphicShapeKind {
    Rectangle,
    Ellipse,
    Polygon,
    Star,
}

/// One step of a graphic's outline, in the element's own pixels.
///
/// `ArcTo` and `RoundRect` are `Path2D` calls rather than curves worked out
/// here: the browser already has the corner-arc construction, and reproducing
/// it would change the rendering by a fraction of a pixel for nothing.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GraphicOutlineCommand {
    MoveTo {
        x: f64,
        y: f64,
    },
    LineTo {
        x: f64,
        y: f64,
    },
    /// The arc that runs from the current point to the tangent of the line
    /// `(x1, y1) -> (x2, y2)`, as `CanvasPath.arcTo` defines it.
    ArcTo {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        radius: f64,
    },
    Ellipse {
        center_x: f64,
        center_y: f64,
        radius_x: f64,
        radius_y: f64,
    },
    RoundRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        radius: f64,
    },
    ClosePath,
}

/// A graphic's outline as a command list. Wrapped in a struct rather than
/// returned as a bare `Vec`, which crosses the bridge as an object with
/// numeric keys.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphicShapeOutline {
    pub commands: Vec<GraphicOutlineCommand>,
}

/// Args to [`build_graphic_shape_outline`].
///
/// The per-shape numbers are optional because they come out of a parameter map
/// that only carries what the shape defines; an absent one falls back to the
/// definition's default, exactly as the TypeScript's `?? default` did.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphicShapeOptions {
    pub shape: GraphicShapeKind,
    /// The element's size in pixels.
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub stroke_width: Option<f64>,
    #[serde(default)]
    pub stroke_align: Option<String>,
    /// Rectangle and polygon: percent of the largest radius that fits, capped
    /// at 50.
    #[serde(default)]
    pub corner_radius: Option<f64>,
    /// Polygon only.
    #[serde(default)]
    pub sides: Option<f64>,
    /// Star only.
    #[serde(default)]
    pub points: Option<f64>,
    /// Star only: how far in the inner vertices sit, as a percentage.
    #[serde(default)]
    pub depth: Option<f64>,
}

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

/// Half the stroke, for a centred stroke only. An inside stroke is clipped to
/// the path and an outside one is drawn past it, so neither moves the path.
fn stroke_inset(stroke_width: f64, stroke_align: Option<&str>) -> f64 {
    if stroke_align.unwrap_or("center") == "center" {
        stroke_width / 2.0
    } else {
        0.0
    }
}

/// A percentage of the largest radius that fits, where 50% is "as round as it
/// goes" — a pill for a rectangle, fully filleted for a polygon.
fn radius_from_percent(percent: Option<f64>, max_radius: f64) -> f64 {
    let percent = percent.unwrap_or(0.0).max(0.0);
    (max_radius * percent.min(50.0)) / 50.0
}

fn polygon_vertices(center_x: f64, center_y: f64, radius: f64, sides: usize) -> Vec<Point> {
    (0..sides)
        .map(|index| {
            let angle = -std::f64::consts::FRAC_PI_2
                + (index as f64 * std::f64::consts::PI * 2.0) / sides as f64;
            Point {
                x: center_x + angle.cos() * radius,
                y: center_y + angle.sin() * radius,
            }
        })
        .collect()
}

fn distance(a: Point, b: Point) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}

/// A zero-length vector normalises to itself rather than to NaN — two
/// coincident vertices then produce a degenerate corner instead of a path
/// full of NaN that draws nothing at all.
fn normalize(point: Point) -> Point {
    let length = point.x.hypot(point.y);
    let length = if length == 0.0 { 1.0 } else { length };
    Point {
        x: point.x / length,
        y: point.y / length,
    }
}

/// The polygon's outline, with each corner rounded to `radius` where there is
/// room for it.
///
/// The tangent offset is how far back along each edge the arc has to start for
/// a circle of `radius` to sit in the corner; it is capped at half the shorter
/// edge so two adjacent corners cannot overrun each other.
fn rounded_polygon_commands(vertices: &[Point], radius: f64) -> Vec<GraphicOutlineCommand> {
    if vertices.len() < 3 {
        return Vec::new();
    }

    if radius <= 0.0 {
        let mut commands: Vec<GraphicOutlineCommand> = vertices
            .iter()
            .enumerate()
            .map(|(index, vertex)| {
                if index == 0 {
                    GraphicOutlineCommand::MoveTo {
                        x: vertex.x,
                        y: vertex.y,
                    }
                } else {
                    GraphicOutlineCommand::LineTo {
                        x: vertex.x,
                        y: vertex.y,
                    }
                }
            })
            .collect();
        commands.push(GraphicOutlineCommand::ClosePath);
        return commands;
    }

    let mut commands = Vec::with_capacity(vertices.len() * 2 + 1);
    for index in 0..vertices.len() {
        let previous = vertices[(index + vertices.len() - 1) % vertices.len()];
        let current = vertices[index];
        let next = vertices[(index + 1) % vertices.len()];
        let to_previous = normalize(Point {
            x: previous.x - current.x,
            y: previous.y - current.y,
        });
        let to_next = normalize(Point {
            x: next.x - current.x,
            y: next.y - current.y,
        });
        let angle = (to_previous.x * to_next.x + to_previous.y * to_next.y)
            .clamp(-1.0, 1.0)
            .acos();
        let max_offset = distance(previous, current).min(distance(current, next)) / 2.0;
        let tangent_offset = (radius / (angle / 2.0).tan()).min(max_offset);
        let start = Point {
            x: current.x + to_previous.x * tangent_offset,
            y: current.y + to_previous.y * tangent_offset,
        };
        let end = Point {
            x: current.x + to_next.x * tangent_offset,
            y: current.y + to_next.y * tangent_offset,
        };

        commands.push(if index == 0 {
            GraphicOutlineCommand::MoveTo {
                x: start.x,
                y: start.y,
            }
        } else {
            GraphicOutlineCommand::LineTo {
                x: start.x,
                y: start.y,
            }
        });
        commands.push(GraphicOutlineCommand::ArcTo {
            x1: current.x,
            y1: current.y,
            x2: end.x,
            y2: end.y,
            radius: radius.min(max_offset),
        });
    }

    commands.push(GraphicOutlineCommand::ClosePath);
    commands
}

fn star_commands(
    center_x: f64,
    center_y: f64,
    outer_radius: f64,
    inner_radius: f64,
    points: usize,
) -> Vec<GraphicOutlineCommand> {
    let mut commands = Vec::with_capacity(points * 2 + 1);
    for index in 0..points * 2 {
        let radius = if index % 2 == 0 {
            outer_radius
        } else {
            inner_radius
        };
        let angle =
            -std::f64::consts::FRAC_PI_2 + (index as f64 * std::f64::consts::PI) / points as f64;
        let x = center_x + angle.cos() * radius;
        let y = center_y + angle.sin() * radius;

        commands.push(if index == 0 {
            GraphicOutlineCommand::MoveTo { x, y }
        } else {
            GraphicOutlineCommand::LineTo { x, y }
        });
    }

    commands.push(GraphicOutlineCommand::ClosePath);
    commands
}

/// The graphic's outline, ready to be replayed into a `Path2D`.
#[export]
pub fn build_graphic_shape_outline(
    GraphicShapeOptions {
        shape,
        width,
        height,
        stroke_width,
        stroke_align,
        corner_radius,
        sides,
        points,
        depth,
    }: GraphicShapeOptions,
) -> GraphicShapeOutline {
    let inset = stroke_inset(
        stroke_width.unwrap_or(0.0).max(0.0),
        stroke_align.as_deref(),
    );
    let center_x = width / 2.0;
    let center_y = height / 2.0;

    let commands = match shape {
        GraphicShapeKind::Rectangle => {
            let draw_width = (width - inset * 2.0).max(1.0);
            let draw_height = (height - inset * 2.0).max(1.0);
            vec![GraphicOutlineCommand::RoundRect {
                x: inset,
                y: inset,
                width: draw_width,
                height: draw_height,
                radius: radius_from_percent(corner_radius, draw_width.min(draw_height) / 2.0),
            }]
        }
        GraphicShapeKind::Ellipse => vec![GraphicOutlineCommand::Ellipse {
            center_x,
            center_y,
            radius_x: (width / 2.0 - inset).max(1.0),
            radius_y: (height / 2.0 - inset).max(1.0),
        }],
        GraphicShapeKind::Polygon => {
            let sides = js_round(sides.unwrap_or(5.0)).clamp(3.0, 12.0) as usize;
            let radius = (width.min(height) / 2.0 - inset).max(1.0);
            // The largest circle that fits in a corner of a regular polygon is
            // bounded by half the edge length, which is this.
            let max_corner_radius = radius * (std::f64::consts::PI / sides as f64).sin();
            rounded_polygon_commands(
                &polygon_vertices(center_x, center_y, radius, sides),
                radius_from_percent(corner_radius, max_corner_radius),
            )
        }
        GraphicShapeKind::Star => {
            let points = js_round(points.unwrap_or(5.0)).clamp(3.0, 12.0) as usize;
            let depth = depth.unwrap_or(45.0).clamp(1.0, 99.0) / 100.0;
            let outer_radius = (width.min(height) / 2.0 - inset).max(1.0);
            star_commands(
                center_x,
                center_y,
                outer_radius,
                outer_radius * depth,
                points,
            )
        }
    };

    GraphicShapeOutline { commands }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(shape: GraphicShapeKind) -> GraphicShapeOptions {
        GraphicShapeOptions {
            shape,
            width: 200.0,
            height: 100.0,
            stroke_width: None,
            stroke_align: None,
            corner_radius: None,
            sides: None,
            points: None,
            depth: None,
        }
    }

    fn commands(options: GraphicShapeOptions) -> Vec<GraphicOutlineCommand> {
        build_graphic_shape_outline(options).commands
    }

    fn approx(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 1e-9,
            "expected {expected}, got {actual}",
        );
    }

    #[test]
    fn a_rectangle_fills_the_element_when_nothing_is_stroked() {
        assert_eq!(
            commands(options(GraphicShapeKind::Rectangle)),
            vec![GraphicOutlineCommand::RoundRect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
                radius: 0.0,
            }],
        );
    }

    #[test]
    fn a_centred_stroke_insets_the_path_by_half_its_width() {
        // Without this the outer half of the stroke would be cut off by the
        // edge of the element.
        let mut stroked = options(GraphicShapeKind::Rectangle);
        stroked.stroke_width = Some(10.0);
        assert_eq!(
            commands(stroked),
            vec![GraphicOutlineCommand::RoundRect {
                x: 5.0,
                y: 5.0,
                width: 190.0,
                height: 90.0,
                radius: 0.0,
            }],
        );
    }

    #[test]
    fn an_inside_or_outside_stroke_leaves_the_path_where_it_is() {
        for align in ["inside", "outside"] {
            let mut stroked = options(GraphicShapeKind::Rectangle);
            stroked.stroke_width = Some(10.0);
            stroked.stroke_align = Some(align.to_string());
            assert_eq!(
                commands(stroked),
                vec![GraphicOutlineCommand::RoundRect {
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 100.0,
                    radius: 0.0,
                }],
                "stroke aligned {align}",
            );
        }
    }

    #[test]
    fn a_corner_radius_of_fifty_percent_is_as_round_as_the_shape_goes() {
        // Half the short side: the rectangle becomes a pill, and asking for
        // more than 50 does not make it rounder.
        let mut rounded = options(GraphicShapeKind::Rectangle);
        rounded.corner_radius = Some(50.0);
        let mut over = options(GraphicShapeKind::Rectangle);
        over.corner_radius = Some(400.0);
        let expected = vec![GraphicOutlineCommand::RoundRect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
            radius: 50.0,
        }];
        assert_eq!(commands(rounded), expected);
        assert_eq!(commands(over), expected);
    }

    #[test]
    fn an_ellipse_fills_the_box_it_is_given() {
        assert_eq!(
            commands(options(GraphicShapeKind::Ellipse)),
            vec![GraphicOutlineCommand::Ellipse {
                center_x: 100.0,
                center_y: 50.0,
                radius_x: 100.0,
                radius_y: 50.0,
            }],
        );
    }

    #[test]
    fn a_shape_narrower_than_its_stroke_still_draws() {
        // One pixel rather than a negative radius, which would draw nothing
        // and leave an empty element behind.
        let mut hairline = options(GraphicShapeKind::Ellipse);
        hairline.stroke_width = Some(500.0);
        assert_eq!(
            commands(hairline),
            vec![GraphicOutlineCommand::Ellipse {
                center_x: 100.0,
                center_y: 50.0,
                radius_x: 1.0,
                radius_y: 1.0,
            }],
        );
    }

    #[test]
    fn a_polygon_has_one_vertex_per_side_starting_at_the_top() {
        let mut triangle = options(GraphicShapeKind::Polygon);
        triangle.sides = Some(3.0);
        let commands = commands(triangle);
        assert_eq!(commands.len(), 4);
        // The circumscribed radius is half the short side: 50.
        match commands[0] {
            GraphicOutlineCommand::MoveTo { x, y } => {
                approx(x, 100.0);
                approx(y, 0.0);
            }
            other => panic!("expected a moveTo, got {other:?}"),
        }
        assert_eq!(commands[3], GraphicOutlineCommand::ClosePath);
    }

    #[test]
    fn a_polygons_side_count_is_clamped_to_what_the_slider_allows() {
        for (requested, expected_vertices) in [(1.0, 3), (2.4, 3), (12.0, 12), (40.0, 12)] {
            let mut polygon = options(GraphicShapeKind::Polygon);
            polygon.sides = Some(requested);
            // One command per vertex plus the close.
            assert_eq!(
                commands(polygon).len(),
                expected_vertices + 1,
                "{requested} sides",
            );
        }
    }

    #[test]
    fn a_rounded_polygon_draws_an_arc_at_every_corner() {
        let mut polygon = options(GraphicShapeKind::Polygon);
        polygon.sides = Some(5.0);
        polygon.corner_radius = Some(25.0);
        let commands = commands(polygon);
        // A line-or-move and an arc per corner, then the close.
        assert_eq!(commands.len(), 5 * 2 + 1);
        assert!(matches!(commands[0], GraphicOutlineCommand::MoveTo { .. }));
        assert!(matches!(commands[1], GraphicOutlineCommand::ArcTo { .. }));
        assert_eq!(commands[10], GraphicOutlineCommand::ClosePath);
    }

    #[test]
    fn a_corner_arc_cannot_overrun_the_edge_it_sits_on() {
        // At the cap the tangent offset is half the shorter edge, so adjacent
        // corners meet rather than crossing through each other.
        let mut polygon = options(GraphicShapeKind::Polygon);
        polygon.sides = Some(3.0);
        polygon.corner_radius = Some(50.0);
        let radius = 50.0_f64;
        let vertices = polygon_vertices(100.0, 50.0, radius, 3);
        let edge = distance(vertices[0], vertices[1]);
        for command in commands(polygon) {
            if let GraphicOutlineCommand::ArcTo { radius, .. } = command {
                assert!(
                    radius <= edge / 2.0 + 1e-9,
                    "arc radius {radius} overruns half the {edge}px edge",
                );
            }
        }
    }

    #[test]
    fn a_star_alternates_two_vertices_per_point() {
        let mut star = options(GraphicShapeKind::Star);
        star.points = Some(5.0);
        let commands = commands(star);
        assert_eq!(commands.len(), 5 * 2 + 1);
        // First vertex is an outer one, straight up from the centre.
        match commands[0] {
            GraphicOutlineCommand::MoveTo { x, y } => {
                approx(x, 100.0);
                approx(y, 0.0);
            }
            other => panic!("expected a moveTo, got {other:?}"),
        }
    }

    #[test]
    fn a_stars_depth_moves_the_inner_vertices() {
        // Depth is a percentage of the outer radius: at 20 the inner vertices
        // sit at a fifth of it, which is a spikier star.
        let mut star = options(GraphicShapeKind::Star);
        star.points = Some(4.0);
        star.depth = Some(20.0);
        let commands = commands(star);
        // Second vertex is inner, an eighth of a turn clockwise from the top.
        match commands[1] {
            GraphicOutlineCommand::LineTo { x, y } => {
                let inner_radius = 50.0 * 0.2;
                let angle = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI / 4.0;
                approx(x, 100.0 + angle.cos() * inner_radius);
                approx(y, 50.0 + angle.sin() * inner_radius);
            }
            other => panic!("expected a lineTo, got {other:?}"),
        }
    }

    #[test]
    fn a_stars_depth_is_clamped_away_from_both_degenerate_ends() {
        // 0% would collapse the star to a point and 100% would make it a
        // polygon; the slider stops one short of each.
        let mut flat = options(GraphicShapeKind::Star);
        flat.points = Some(5.0);
        flat.depth = Some(0.0);
        match commands(flat)[1] {
            GraphicOutlineCommand::LineTo { x, y } => {
                let inner_radius = 50.0 * 0.01;
                let angle = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI / 5.0;
                approx(x, 100.0 + angle.cos() * inner_radius);
                approx(y, 50.0 + angle.sin() * inner_radius);
            }
            other => panic!("expected a lineTo, got {other:?}"),
        }
    }
}
