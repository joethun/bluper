//! Where a mask's outline and its grab handles land on the canvas.
//!
//! A mask stores its placement normalised against the element it is attached
//! to: `center_x`/`center_y` are offsets from the element's centre in units of
//! the element's own width and height, and `width`/`height` are fractions of
//! them. Everything here turns that back into canvas coordinates so the preview
//! can draw the outline and put handles under the pointer.
//!
//! Ported from `apps/web/src/masks/handle-positions.ts`. `rotate_offset` came
//! along from `apps/web/src/utils/geometry.ts` rather than being left behind —
//! a helper this small is not worth a second boundary crossing, and the TS
//! original stays where it is for the other callers.
//!
//! No `Math.round` appears in this module, so none of the JS rounding rules in
//! [`crate::math`] are in play. `sin`/`cos` are, and V8's are not bit-identical
//! to the system libm's; the parity test compares those fields relatively.

use bridge::export;
use serde::{Deserialize, Serialize};

/// Screen-space distance from the split line to its rotate/feather icons. Taken
/// before the display scale is divided out, so the icons keep a constant size
/// on screen however far the preview is zoomed.
const LINE_HANDLE_OFFSET_SCREEN_PX: f64 = 20.0;

/// The same idea for a box mask's icons, kept as its own constant because the
/// two have drifted apart before.
const BOX_HANDLE_OFFSET_SCREEN_PX: f64 = 20.0;

/// A split mask's line has no length of its own — it cuts the whole frame — so
/// the drawn segment is simply run far enough past the element's box that its
/// ends are never on screen.
const LINE_EXTENT_MULTIPLIER: f64 = 50.0;

/// Canvas units the feather handle moves per unit of feather. Must stay equal
/// to `builtin::box_like::FEATHER_HANDLE_SCALE`, which is the value the editor
/// reads, or dragging the handle will not track the pointer.
const FEATHER_HANDLE_SCALE: f64 = 0.11;

const CURSOR_ROTATE: &str = "crosshair";
const CURSOR_RESIZE_DIAGONAL: &str = "nwse-resize";
const CURSOR_RESIZE_HORIZONTAL: &str = "ew-resize";
const CURSOR_RESIZE_VERTICAL: &str = "ns-resize";

/// What a caller gets when it names no handle and no cursor: the overlay body
/// itself, which drags the whole mask.
const CURSOR_MOVE: &str = "move";

/// The element's box in canvas coordinates — centre, size, and its own
/// rotation.
///
/// `rotation` is carried so a caller can hand its `ElementBounds` straight
/// through, but nothing here reads it: a mask's handles are laid out in the
/// mask's own rotated frame, and the element's rotation is applied by the
/// overlay's transform further up.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskOverlayBounds {
    pub cx: f64,
    pub cy: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
}

/// A canvas-space point.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskOverlayPoint {
    pub x: f64,
    pub y: f64,
}

/// Which edge of a box mask a handle resizes.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskHandleSide {
    Left,
    Right,
    Top,
    Bottom,
}

/// Horizontal half a corner handle sits in.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskHandleCornerX {
    Left,
    Right,
}

/// Vertical half a corner handle sits in.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskHandleCornerY {
    Top,
    Bottom,
}

/// A corner named by both axes, so the drag code can mirror the right one.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaskHandleCorner {
    pub x: MaskHandleCornerX,
    pub y: MaskHandleCornerY,
}

/// Which control a handle is. Freeform masks add the anchor and segment
/// variants; this module never produces those, but it passes them through when
/// a caller hands one in as an overlay's `handle_id`.
///
/// `PathAnchor` is not named `Anchor` on purpose: `Tsify`'s derive expands in a
/// scope where a variant of that name is ambiguous with
/// `wasm_bindgen::convert::FromWasmAbi::Anchor`, which is a hard error under
/// `deny(ambiguous_associated_items)`. The `serde` rename keeps the wire tag
/// `"anchor"`, which is what `MaskHandleId` in `apps/web/src/masks/types.ts`
/// reads.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MaskHandleId {
    Position,
    Rotation,
    Feather,
    Scale,
    Edge { side: MaskHandleSide },
    Corner { corner: MaskHandleCorner },
    #[serde(rename = "anchor")]
    PathAnchor { point_id: String },
    Segment { index: i64 },
}

/// How a handle is drawn — a square at a corner, a bar along an edge, a glyph,
/// or a freeform path point.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskHandleKind {
    Corner,
    Edge,
    Icon,
    Point,
}

/// The glyph an icon handle shows.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskHandleIcon {
    Rotate,
    Feather,
}

/// Which way an edge handle's bar runs.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskHandleEdgeAxis {
    Horizontal,
    Vertical,
}

/// Which of a box mask's dimensions the user is allowed to change, which is
/// what decides the set of resize handles.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MaskHandleSizeMode {
    None,
    Uniform,
    WidthHeight,
    HeightOnly,
    WidthOnly,
}

/// One grab handle, positioned in canvas coordinates.
///
/// The optional fields are absent rather than null when they do not apply, so
/// the shape matches what the TypeScript built by omitting the key. `is_selected`
/// is never set here — selection is layered on by the freeform editor, and the
/// field exists so those handles and these share one type.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskHandlePosition {
    pub id: MaskHandleId,
    pub x: f64,
    pub y: f64,
    pub cursor: String,
    pub kind: MaskHandleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_selected: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_axis: Option<MaskHandleEdgeAxis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<MaskHandleIcon>,
}

/// An outline the preview draws over the element.
///
/// The TypeScript returned the specific member type from each builder; this
/// returns the union from all of them. Every call site pushes the result into a
/// list of overlays, so nothing needed the narrower type.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MaskOverlayItem {
    Line {
        id: String,
        start: MaskOverlayPoint,
        end: MaskOverlayPoint,
        cursor: String,
        handle_id: MaskHandleId,
    },
    Rect {
        id: String,
        center: MaskOverlayPoint,
        width: f64,
        height: f64,
        rotation: f64,
        dashed: bool,
        cursor: String,
        handle_id: MaskHandleId,
    },
    Shape {
        id: String,
        center: MaskOverlayPoint,
        width: f64,
        height: f64,
        rotation: f64,
        path_data: String,
        cursor: String,
        handle_id: MaskHandleId,
    },
}

/// Rotates an offset about the origin. Ported from `rotateOffset` in
/// `apps/web/src/utils/geometry.ts`; the operation order is the TypeScript's,
/// since reassociating either component would move the last bits.
fn rotate_offset(dx: f64, dy: f64, rotation_rad: f64) -> MaskOverlayPoint {
    let cos = rotation_rad.cos();
    let sin = rotation_rad.sin();

    MaskOverlayPoint {
        x: dx * cos - dy * sin,
        y: dx * sin + dy * cos,
    }
}

/// An offset in the mask's own frame, rotated and moved onto the mask centre.
fn rotate_point(local_x: f64, local_y: f64, cx: f64, cy: f64, angle_rad: f64) -> MaskOverlayPoint {
    let rotated = rotate_offset(local_x, local_y, angle_rad);
    MaskOverlayPoint {
        x: cx + rotated.x,
        y: cy + rotated.y,
    }
}

/// The mask's centre in canvas coordinates.
fn mask_center(center_x: f64, center_y: f64, bounds: MaskOverlayBounds) -> MaskOverlayPoint {
    MaskOverlayPoint {
        x: bounds.cx + center_x * bounds.width,
        y: bounds.cy + center_y * bounds.height,
    }
}

/// Degrees to radians, written the way the TypeScript wrote it so the rounding
/// of the intermediate product matches.
fn to_radians(rotation: f64) -> f64 {
    (rotation * std::f64::consts::PI) / 180.0
}

/// An icon handle — the rotate and feather glyphs, which are the only two.
fn icon_handle(
    id: MaskHandleId,
    point: MaskOverlayPoint,
    cursor: &str,
    icon: MaskHandleIcon,
) -> MaskHandlePosition {
    MaskHandlePosition {
        id,
        x: point.x,
        y: point.y,
        cursor: cursor.to_string(),
        kind: MaskHandleKind::Icon,
        is_selected: None,
        edge_axis: None,
        rotation: None,
        icon: Some(icon),
    }
}

/// A square handle at a corner, or the single uniform-scale handle.
fn corner_handle(id: MaskHandleId, point: MaskOverlayPoint) -> MaskHandlePosition {
    MaskHandlePosition {
        id,
        x: point.x,
        y: point.y,
        cursor: CURSOR_RESIZE_DIAGONAL.to_string(),
        kind: MaskHandleKind::Corner,
        is_selected: None,
        edge_axis: None,
        rotation: None,
        icon: None,
    }
}

/// A bar along one edge. It carries the mask's rotation because the bar has to
/// be drawn turned, unlike the rotationally symmetric corner squares.
fn edge_handle(
    side: MaskHandleSide,
    point: MaskOverlayPoint,
    axis: MaskHandleEdgeAxis,
    rotation: f64,
) -> MaskHandlePosition {
    let cursor = match axis {
        MaskHandleEdgeAxis::Horizontal => CURSOR_RESIZE_HORIZONTAL,
        MaskHandleEdgeAxis::Vertical => CURSOR_RESIZE_VERTICAL,
    };
    MaskHandlePosition {
        id: MaskHandleId::Edge { side },
        x: point.x,
        y: point.y,
        cursor: cursor.to_string(),
        kind: MaskHandleKind::Edge,
        is_selected: None,
        edge_axis: Some(axis),
        rotation: Some(rotation),
        icon: None,
    }
}

/// The two ends of a split mask's drawn line.
///
/// The renderer defines the split line as:
///   - normal direction: `(cos(rotation), sin(rotation))`
///   - line direction (parallel to the cut): `(-sin(rotation), cos(rotation))`
///   - reference point: `(center_x * width, center_y * height)` from the
///     element centre
///
/// So `rotation = 0` puts the normal to the right, which makes the line run
/// vertically. Getting this backwards silently transposes every split mask, so
/// the convention lives here next to the only code that depends on it.
fn line_mask_line_points(
    center_x: f64,
    center_y: f64,
    rotation: f64,
    bounds: MaskOverlayBounds,
) -> (MaskOverlayPoint, MaskOverlayPoint) {
    let angle_rad = to_radians(rotation);
    let normal_x = angle_rad.cos();
    let normal_y = angle_rad.sin();
    let line_dir_x = -normal_y;
    let line_dir_y = normal_x;

    let center = mask_center(center_x, center_y, bounds);

    let extent = bounds.width.max(bounds.height) * LINE_EXTENT_MULTIPLIER;

    (
        MaskOverlayPoint {
            x: center.x - line_dir_x * extent,
            y: center.y - line_dir_y * extent,
        },
        MaskOverlayPoint {
            x: center.x + line_dir_x * extent,
            y: center.y + line_dir_y * extent,
        },
    )
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskOverlayLineOptions {
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub bounds: MaskOverlayBounds,
    #[serde(default)]
    pub handle_id: Option<MaskHandleId>,
    #[serde(default)]
    pub cursor: Option<String>,
}

/// The line a split mask cuts along, long enough to leave the frame at both
/// ends.
#[export]
pub fn get_line_mask_overlay(
    MaskOverlayLineOptions {
        center_x,
        center_y,
        rotation,
        bounds,
        handle_id,
        cursor,
    }: MaskOverlayLineOptions,
) -> MaskOverlayItem {
    let (start, end) = line_mask_line_points(center_x, center_y, rotation, bounds);

    MaskOverlayItem::Line {
        id: "line".to_string(),
        start,
        end,
        cursor: cursor.unwrap_or_else(|| CURSOR_MOVE.to_string()),
        handle_id: handle_id.unwrap_or(MaskHandleId::Position),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskHandlePositionList {
    pub handles: Vec<MaskHandlePosition>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskHandleLineOptions {
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub feather: f64,
    pub bounds: MaskOverlayBounds,
    pub display_scale: f64,
}

/// A split mask's two icon handles: rotate on the normal's side of the line,
/// feather on the other, pushed further out the softer the edge is so the glyph
/// stays clear of the gradient it controls.
#[export]
pub fn get_line_mask_handle_positions(
    MaskHandleLineOptions {
        center_x,
        center_y,
        rotation,
        feather,
        bounds,
        display_scale,
    }: MaskHandleLineOptions,
) -> MaskHandlePositionList {
    let angle_rad = to_radians(rotation);
    let normal_x = angle_rad.cos();
    let normal_y = angle_rad.sin();

    let center = mask_center(center_x, center_y, bounds);

    let icon_offset_canvas = LINE_HANDLE_OFFSET_SCREEN_PX / display_scale;
    let feather_offset = icon_offset_canvas + feather * FEATHER_HANDLE_SCALE;

    MaskHandlePositionList {
        handles: vec![
            icon_handle(
                MaskHandleId::Rotation,
                MaskOverlayPoint {
                    x: center.x + normal_x * icon_offset_canvas,
                    y: center.y + normal_y * icon_offset_canvas,
                },
                CURSOR_ROTATE,
                MaskHandleIcon::Rotate,
            ),
            icon_handle(
                MaskHandleId::Feather,
                MaskOverlayPoint {
                    x: center.x - normal_x * feather_offset,
                    y: center.y - normal_y * feather_offset,
                },
                CURSOR_RESIZE_HORIZONTAL,
                MaskHandleIcon::Feather,
            ),
        ],
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskHandleBoxOptions {
    pub center_x: f64,
    pub center_y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub feather: f64,
    pub size_mode: MaskHandleSizeMode,
    #[serde(default)]
    pub show_scale_handle: Option<bool>,
    pub bounds: MaskOverlayBounds,
    pub display_scale: f64,
}

/// Every handle a box-like mask offers, in the order the overlay stacks them:
/// rotate above, feather below, then whichever resize handles the size mode
/// allows.
#[export]
pub fn get_box_mask_handle_positions(
    MaskHandleBoxOptions {
        center_x,
        center_y,
        width,
        height,
        rotation,
        feather,
        size_mode,
        show_scale_handle,
        bounds,
        display_scale,
    }: MaskHandleBoxOptions,
) -> MaskHandlePositionList {
    let show_scale_handle = show_scale_handle.unwrap_or(true);

    let center = mask_center(center_x, center_y, bounds);
    let cx = center.x;
    let cy = center.y;
    let angle_rad = to_radians(rotation);
    let half_width = (width * bounds.width) / 2.0;
    let half_height = (height * bounds.height) / 2.0;

    let mut handles: Vec<MaskHandlePosition> = Vec::new();
    let handle_offset_canvas = BOX_HANDLE_OFFSET_SCREEN_PX / display_scale;

    handles.push(icon_handle(
        MaskHandleId::Rotation,
        rotate_point(0.0, -half_height - handle_offset_canvas, cx, cy, angle_rad),
        CURSOR_ROTATE,
        MaskHandleIcon::Rotate,
    ));

    handles.push(icon_handle(
        MaskHandleId::Feather,
        rotate_point(
            0.0,
            half_height + handle_offset_canvas + feather * FEATHER_HANDLE_SCALE,
            cx,
            cy,
            angle_rad,
        ),
        CURSOR_RESIZE_VERTICAL,
        MaskHandleIcon::Feather,
    ));

    match size_mode {
        MaskHandleSizeMode::WidthHeight => {
            // Clockwise from the top-left, which is the order the drag code's
            // opposite-corner lookup assumes.
            let corners = [
                (
                    -half_width,
                    -half_height,
                    MaskHandleCornerX::Left,
                    MaskHandleCornerY::Top,
                ),
                (
                    half_width,
                    -half_height,
                    MaskHandleCornerX::Right,
                    MaskHandleCornerY::Top,
                ),
                (
                    half_width,
                    half_height,
                    MaskHandleCornerX::Right,
                    MaskHandleCornerY::Bottom,
                ),
                (
                    -half_width,
                    half_height,
                    MaskHandleCornerX::Left,
                    MaskHandleCornerY::Bottom,
                ),
            ];
            for (local_x, local_y, corner_x, corner_y) in corners {
                handles.push(corner_handle(
                    MaskHandleId::Corner {
                        corner: MaskHandleCorner {
                            x: corner_x,
                            y: corner_y,
                        },
                    },
                    rotate_point(local_x, local_y, cx, cy, angle_rad),
                ));
            }
            // No top edge handle: the rotate icon already occupies that spot.
            handles.push(edge_handle(
                MaskHandleSide::Left,
                rotate_point(-half_width, 0.0, cx, cy, angle_rad),
                MaskHandleEdgeAxis::Horizontal,
                rotation,
            ));
            handles.push(edge_handle(
                MaskHandleSide::Right,
                rotate_point(half_width, 0.0, cx, cy, angle_rad),
                MaskHandleEdgeAxis::Horizontal,
                rotation,
            ));
            handles.push(edge_handle(
                MaskHandleSide::Bottom,
                rotate_point(0.0, half_height, cx, cy, angle_rad),
                MaskHandleEdgeAxis::Vertical,
                rotation,
            ));
        }
        MaskHandleSizeMode::HeightOnly => {
            handles.push(edge_handle(
                MaskHandleSide::Top,
                rotate_point(0.0, -half_height, cx, cy, angle_rad),
                MaskHandleEdgeAxis::Vertical,
                rotation,
            ));
            handles.push(edge_handle(
                MaskHandleSide::Bottom,
                rotate_point(0.0, half_height, cx, cy, angle_rad),
                MaskHandleEdgeAxis::Vertical,
                rotation,
            ));
        }
        MaskHandleSizeMode::WidthOnly => {
            handles.push(edge_handle(
                MaskHandleSide::Left,
                rotate_point(-half_width, 0.0, cx, cy, angle_rad),
                MaskHandleEdgeAxis::Horizontal,
                rotation,
            ));
            handles.push(edge_handle(
                MaskHandleSide::Right,
                rotate_point(half_width, 0.0, cx, cy, angle_rad),
                MaskHandleEdgeAxis::Horizontal,
                rotation,
            ));
        }
        MaskHandleSizeMode::Uniform => {
            if show_scale_handle {
                handles.push(corner_handle(
                    MaskHandleId::Scale,
                    rotate_point(half_width, half_height, cx, cy, angle_rad),
                ));
            }
        }
        MaskHandleSizeMode::None => {}
    }

    MaskHandlePositionList { handles }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskOverlayRectOptions {
    pub center_x: f64,
    pub center_y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub bounds: MaskOverlayBounds,
    #[serde(default)]
    pub handle_id: Option<MaskHandleId>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub dashed: Option<bool>,
}

/// The box mask's bounding rectangle, in canvas units.
fn box_rect_overlay(
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    bounds: MaskOverlayBounds,
    handle_id: MaskHandleId,
    cursor: String,
    dashed: bool,
) -> MaskOverlayItem {
    MaskOverlayItem::Rect {
        id: "bounding-box".to_string(),
        center: mask_center(center_x, center_y, bounds),
        width: width * bounds.width,
        height: height * bounds.height,
        rotation,
        dashed,
        cursor,
        handle_id,
    }
}

/// The dragging surface for a box-like mask, and the outline the user sees.
#[export]
pub fn get_box_mask_rect_overlay(
    MaskOverlayRectOptions {
        center_x,
        center_y,
        width,
        height,
        rotation,
        bounds,
        handle_id,
        cursor,
        dashed,
    }: MaskOverlayRectOptions,
) -> MaskOverlayItem {
    box_rect_overlay(
        center_x,
        center_y,
        width,
        height,
        rotation,
        bounds,
        handle_id.unwrap_or(MaskHandleId::Position),
        cursor.unwrap_or_else(|| CURSOR_MOVE.to_string()),
        dashed.unwrap_or(false),
    )
}

/// The mask's own silhouette, for the shapes whose outline is not their
/// bounding box — a star, a heart.
fn box_shape_overlay(
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    bounds: MaskOverlayBounds,
    path_data: String,
    handle_id: MaskHandleId,
    cursor: String,
) -> MaskOverlayItem {
    MaskOverlayItem::Shape {
        id: "shape-outline".to_string(),
        center: mask_center(center_x, center_y, bounds),
        width: width * bounds.width,
        height: height * bounds.height,
        rotation,
        path_data,
        cursor,
        handle_id,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskOverlayBoxParams {
    pub center_x: f64,
    pub center_y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskOverlayBoxOptions {
    pub params: MaskOverlayBoxParams,
    pub bounds: MaskOverlayBounds,
    #[serde(default)]
    pub path_data: Option<String>,
    #[serde(default)]
    pub show_bounding_box: Option<bool>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskOverlayList {
    pub overlays: Vec<MaskOverlayItem>,
}

/// Both outlines a box-like mask can want: the bounding box, and the shape's
/// own path when it has one. When a path is present the box is dashed, so the
/// two are told apart at a glance.
///
/// The TypeScript tested `path_data` for truthiness, which makes an empty
/// string mean "no path". That is kept, not corrected: a definition whose
/// `buildOverlayPath` returns `""` for a degenerate size relies on it.
#[export]
pub fn get_box_mask_overlays(
    MaskOverlayBoxOptions {
        params,
        bounds,
        path_data,
        show_bounding_box,
    }: MaskOverlayBoxOptions,
) -> MaskOverlayList {
    let path_data = path_data.filter(|value| !value.is_empty());
    let show_bounding_box = show_bounding_box.unwrap_or(true);

    let mut overlays: Vec<MaskOverlayItem> = Vec::new();

    if show_bounding_box {
        overlays.push(box_rect_overlay(
            params.center_x,
            params.center_y,
            params.width,
            params.height,
            params.rotation,
            bounds,
            MaskHandleId::Position,
            CURSOR_MOVE.to_string(),
            path_data.is_some(),
        ));
    }

    if let Some(path_data) = path_data {
        overlays.push(box_shape_overlay(
            params.center_x,
            params.center_y,
            params.width,
            params.height,
            params.rotation,
            bounds,
            path_data,
            MaskHandleId::Position,
            CURSOR_MOVE.to_string(),
        ));
    }

    MaskOverlayList { overlays }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds() -> MaskOverlayBounds {
        MaskOverlayBounds {
            cx: 100.0,
            cy: 200.0,
            width: 400.0,
            height: 300.0,
            rotation: 0.0,
        }
    }

    fn line_ends(overlay: &MaskOverlayItem) -> (MaskOverlayPoint, MaskOverlayPoint) {
        match overlay {
            MaskOverlayItem::Line { start, end, .. } => (*start, *end),
            other => panic!("expected a line overlay, got {other:?}"),
        }
    }

    fn handle(list: &MaskHandlePositionList, id: &MaskHandleId) -> MaskHandlePosition {
        list.handles
            .iter()
            .find(|candidate| &candidate.id == id)
            .unwrap_or_else(|| panic!("no {id:?} handle in {:?}", list.handles))
            .clone()
    }

    fn ids(list: &MaskHandlePositionList) -> Vec<MaskHandleId> {
        list.handles.iter().map(|handle| handle.id.clone()).collect()
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn an_unrotated_split_line_runs_vertically_through_the_mask_centre() {
        let overlay = get_line_mask_overlay(MaskOverlayLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            bounds: bounds(),
            handle_id: None,
            cursor: None,
        });
        let (start, end) = line_ends(&overlay);
        // rotation 0 → normal points right → the drawn line is vertical.
        assert_eq!(start.x, 100.0);
        assert_eq!(end.x, 100.0);
        assert_eq!(start.y, 200.0 - 400.0 * LINE_EXTENT_MULTIPLIER);
        assert_eq!(end.y, 200.0 + 400.0 * LINE_EXTENT_MULTIPLIER);
    }

    #[test]
    fn the_line_extent_follows_the_larger_bound() {
        let tall = MaskOverlayBounds {
            cx: 0.0,
            cy: 0.0,
            width: 10.0,
            height: 700.0,
            rotation: 0.0,
        };
        let (start, end) = line_ends(&get_line_mask_overlay(MaskOverlayLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            bounds: tall,
            handle_id: None,
            cursor: None,
        }));
        assert_eq!(end.y - start.y, 2.0 * 700.0 * LINE_EXTENT_MULTIPLIER);
        assert_eq!(end.y, 700.0 * 50.0);
    }

    #[test]
    fn a_ninety_degree_split_line_runs_horizontally() {
        let (start, end) = line_ends(&get_line_mask_overlay(MaskOverlayLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 90.0,
            bounds: bounds(),
            handle_id: None,
            cursor: None,
        }));
        let extent = 400.0 * LINE_EXTENT_MULTIPLIER;
        // normal now points down, so the line direction is (-1, ~0).
        assert_close(start.x, 100.0 + extent);
        assert_close(end.x, 100.0 - extent);
        assert_close(start.y, 200.0);
        assert_close(end.y, 200.0);
    }

    #[test]
    fn the_split_line_centre_is_offset_by_the_normalised_params() {
        let (start, _) = line_ends(&get_line_mask_overlay(MaskOverlayLineOptions {
            center_x: 0.25,
            center_y: -0.5,
            rotation: 0.0,
            bounds: bounds(),
            handle_id: None,
            cursor: None,
        }));
        assert_eq!(start.x, 100.0 + 0.25 * 400.0);
        assert_eq!(start.y, 200.0 + -0.5 * 300.0 - 400.0 * LINE_EXTENT_MULTIPLIER);
    }

    #[test]
    fn the_line_overlay_defaults_to_dragging_the_whole_mask() {
        let overlay = get_line_mask_overlay(MaskOverlayLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            bounds: bounds(),
            handle_id: None,
            cursor: None,
        });
        match overlay {
            MaskOverlayItem::Line {
                id,
                cursor,
                handle_id,
                ..
            } => {
                assert_eq!(id, "line");
                assert_eq!(cursor, "move");
                assert_eq!(handle_id, MaskHandleId::Position);
            }
            other => panic!("expected a line overlay, got {other:?}"),
        }
    }

    #[test]
    fn a_freeform_handle_id_passes_through_the_line_overlay_untouched() {
        let overlay = get_line_mask_overlay(MaskOverlayLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            bounds: bounds(),
            handle_id: Some(MaskHandleId::Segment { index: 3 }),
            cursor: Some("grabbing".to_string()),
        });
        match overlay {
            MaskOverlayItem::Line {
                cursor, handle_id, ..
            } => {
                assert_eq!(cursor, "grabbing");
                assert_eq!(handle_id, MaskHandleId::Segment { index: 3 });
            }
            other => panic!("expected a line overlay, got {other:?}"),
        }
    }

    #[test]
    fn line_handles_sit_on_opposite_sides_of_the_cut() {
        let list = get_line_mask_handle_positions(MaskHandleLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            feather: 0.0,
            bounds: bounds(),
            display_scale: 1.0,
        });
        assert_eq!(ids(&list), vec![MaskHandleId::Rotation, MaskHandleId::Feather]);

        let rotate = handle(&list, &MaskHandleId::Rotation);
        assert_eq!(rotate.x, 100.0 + LINE_HANDLE_OFFSET_SCREEN_PX);
        assert_eq!(rotate.y, 200.0);
        assert_eq!(rotate.kind, MaskHandleKind::Icon);
        assert_eq!(rotate.icon, Some(MaskHandleIcon::Rotate));
        assert_eq!(rotate.cursor, "crosshair");
        assert_eq!(rotate.edge_axis, None);
        assert_eq!(rotate.rotation, None);

        let feather = handle(&list, &MaskHandleId::Feather);
        assert_eq!(feather.x, 100.0 - LINE_HANDLE_OFFSET_SCREEN_PX);
        assert_eq!(feather.y, 200.0);
        assert_eq!(feather.icon, Some(MaskHandleIcon::Feather));
        assert_eq!(feather.cursor, "ew-resize");
    }

    #[test]
    fn the_line_feather_handle_moves_out_with_the_feather_amount() {
        let list = get_line_mask_handle_positions(MaskHandleLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            feather: 200.0,
            bounds: bounds(),
            display_scale: 2.0,
        });
        // display_scale 2 halves the icon offset; the feather term is in canvas
        // units already and is not scaled.
        let icon_offset = LINE_HANDLE_OFFSET_SCREEN_PX / 2.0;
        let expected = icon_offset + 200.0 * FEATHER_HANDLE_SCALE;
        assert_eq!(handle(&list, &MaskHandleId::Feather).x, 100.0 - expected);
        assert_eq!(handle(&list, &MaskHandleId::Rotation).x, 100.0 + icon_offset);
    }

    #[test]
    fn a_rotated_split_puts_its_handles_along_the_normal() {
        let list = get_line_mask_handle_positions(MaskHandleLineOptions {
            center_x: 0.0,
            center_y: 0.0,
            rotation: 90.0,
            feather: 0.0,
            bounds: bounds(),
            display_scale: 1.0,
        });
        let rotate = handle(&list, &MaskHandleId::Rotation);
        assert_close(rotate.x, 100.0);
        assert_close(rotate.y, 200.0 + LINE_HANDLE_OFFSET_SCREEN_PX);
        let feather = handle(&list, &MaskHandleId::Feather);
        assert_close(feather.x, 100.0);
        assert_close(feather.y, 200.0 - LINE_HANDLE_OFFSET_SCREEN_PX);
    }

    fn box_options(size_mode: MaskHandleSizeMode, rotation: f64) -> MaskHandleBoxOptions {
        MaskHandleBoxOptions {
            center_x: 0.0,
            center_y: 0.0,
            width: 0.5,
            height: 0.5,
            rotation,
            feather: 0.0,
            size_mode,
            show_scale_handle: None,
            bounds: bounds(),
            display_scale: 1.0,
        }
    }

    #[test]
    fn a_width_height_box_offers_every_resize_handle_but_the_top_edge() {
        let list = get_box_mask_handle_positions(box_options(
            MaskHandleSizeMode::WidthHeight,
            0.0,
        ));
        assert_eq!(
            ids(&list),
            vec![
                MaskHandleId::Rotation,
                MaskHandleId::Feather,
                MaskHandleId::Corner {
                    corner: MaskHandleCorner {
                        x: MaskHandleCornerX::Left,
                        y: MaskHandleCornerY::Top
                    }
                },
                MaskHandleId::Corner {
                    corner: MaskHandleCorner {
                        x: MaskHandleCornerX::Right,
                        y: MaskHandleCornerY::Top
                    }
                },
                MaskHandleId::Corner {
                    corner: MaskHandleCorner {
                        x: MaskHandleCornerX::Right,
                        y: MaskHandleCornerY::Bottom
                    }
                },
                MaskHandleId::Corner {
                    corner: MaskHandleCorner {
                        x: MaskHandleCornerX::Left,
                        y: MaskHandleCornerY::Bottom
                    }
                },
                MaskHandleId::Edge {
                    side: MaskHandleSide::Left
                },
                MaskHandleId::Edge {
                    side: MaskHandleSide::Right
                },
                MaskHandleId::Edge {
                    side: MaskHandleSide::Bottom
                },
            ]
        );

        // 0.5 of a 400x300 box, so the half-extents are 100 and 75.
        let top_left = handle(
            &list,
            &MaskHandleId::Corner {
                corner: MaskHandleCorner {
                    x: MaskHandleCornerX::Left,
                    y: MaskHandleCornerY::Top,
                },
            },
        );
        assert_eq!((top_left.x, top_left.y), (0.0, 125.0));
        assert_eq!(top_left.kind, MaskHandleKind::Corner);
        assert_eq!(top_left.cursor, "nwse-resize");
        assert_eq!(top_left.icon, None);

        let left = handle(
            &list,
            &MaskHandleId::Edge {
                side: MaskHandleSide::Left,
            },
        );
        assert_eq!((left.x, left.y), (0.0, 200.0));
        assert_eq!(left.kind, MaskHandleKind::Edge);
        assert_eq!(left.edge_axis, Some(MaskHandleEdgeAxis::Horizontal));
        assert_eq!(left.rotation, Some(0.0));
        assert_eq!(left.cursor, "ew-resize");

        let bottom = handle(
            &list,
            &MaskHandleId::Edge {
                side: MaskHandleSide::Bottom,
            },
        );
        assert_eq!((bottom.x, bottom.y), (100.0, 275.0));
        assert_eq!(bottom.edge_axis, Some(MaskHandleEdgeAxis::Vertical));
        assert_eq!(bottom.cursor, "ns-resize");
    }

    #[test]
    fn the_box_icon_handles_straddle_the_box_vertically() {
        let list = get_box_mask_handle_positions(box_options(MaskHandleSizeMode::None, 0.0));
        assert_eq!(ids(&list), vec![MaskHandleId::Rotation, MaskHandleId::Feather]);
        let rotate = handle(&list, &MaskHandleId::Rotation);
        assert_eq!((rotate.x, rotate.y), (100.0, 125.0 - BOX_HANDLE_OFFSET_SCREEN_PX));
        let feather = handle(&list, &MaskHandleId::Feather);
        assert_eq!(
            (feather.x, feather.y),
            (100.0, 275.0 + BOX_HANDLE_OFFSET_SCREEN_PX)
        );
    }

    #[test]
    fn the_box_feather_handle_moves_out_with_the_feather_amount() {
        let mut options = box_options(MaskHandleSizeMode::None, 0.0);
        options.feather = 500.0;
        let list = get_box_mask_handle_positions(options);
        let feather = handle(&list, &MaskHandleId::Feather);
        assert_eq!(
            feather.y,
            275.0 + BOX_HANDLE_OFFSET_SCREEN_PX + 500.0 * FEATHER_HANDLE_SCALE
        );
    }

    #[test]
    fn rotating_a_box_turns_its_handles_about_the_mask_centre() {
        let list = get_box_mask_handle_positions(box_options(
            MaskHandleSizeMode::WidthHeight,
            90.0,
        ));
        // A +90° rotation sends local (x, y) to (-y, x).
        let top_left = handle(
            &list,
            &MaskHandleId::Corner {
                corner: MaskHandleCorner {
                    x: MaskHandleCornerX::Left,
                    y: MaskHandleCornerY::Top,
                },
            },
        );
        assert_close(top_left.x, 100.0 + 75.0);
        assert_close(top_left.y, 200.0 - 100.0);

        let right = handle(
            &list,
            &MaskHandleId::Edge {
                side: MaskHandleSide::Right,
            },
        );
        assert_close(right.x, 100.0);
        assert_close(right.y, 200.0 + 100.0);
        // The edge bar still reports the mask's rotation so it can be drawn
        // turned to match.
        assert_eq!(right.rotation, Some(90.0));
    }

    #[test]
    fn height_only_and_width_only_expose_just_their_axis() {
        let height_only =
            get_box_mask_handle_positions(box_options(MaskHandleSizeMode::HeightOnly, 0.0));
        assert_eq!(
            ids(&height_only),
            vec![
                MaskHandleId::Rotation,
                MaskHandleId::Feather,
                MaskHandleId::Edge {
                    side: MaskHandleSide::Top
                },
                MaskHandleId::Edge {
                    side: MaskHandleSide::Bottom
                },
            ]
        );
        let top = handle(
            &height_only,
            &MaskHandleId::Edge {
                side: MaskHandleSide::Top,
            },
        );
        assert_eq!((top.x, top.y), (100.0, 125.0));

        let width_only =
            get_box_mask_handle_positions(box_options(MaskHandleSizeMode::WidthOnly, 0.0));
        assert_eq!(
            ids(&width_only),
            vec![
                MaskHandleId::Rotation,
                MaskHandleId::Feather,
                MaskHandleId::Edge {
                    side: MaskHandleSide::Left
                },
                MaskHandleId::Edge {
                    side: MaskHandleSide::Right
                },
            ]
        );
        let right = handle(
            &width_only,
            &MaskHandleId::Edge {
                side: MaskHandleSide::Right,
            },
        );
        assert_eq!((right.x, right.y), (200.0, 200.0));
    }

    #[test]
    fn uniform_masks_get_one_scale_handle_unless_it_is_suppressed() {
        let shown = get_box_mask_handle_positions(box_options(MaskHandleSizeMode::Uniform, 0.0));
        assert_eq!(
            ids(&shown),
            vec![
                MaskHandleId::Rotation,
                MaskHandleId::Feather,
                MaskHandleId::Scale
            ]
        );
        let scale = handle(&shown, &MaskHandleId::Scale);
        assert_eq!((scale.x, scale.y), (200.0, 275.0));
        assert_eq!(scale.kind, MaskHandleKind::Corner);

        let mut suppressed = box_options(MaskHandleSizeMode::Uniform, 0.0);
        suppressed.show_scale_handle = Some(false);
        let hidden = get_box_mask_handle_positions(suppressed);
        assert_eq!(ids(&hidden), vec![MaskHandleId::Rotation, MaskHandleId::Feather]);
    }

    #[test]
    fn degenerate_bounds_collapse_every_handle_onto_the_icon_offsets() {
        let empty = MaskOverlayBounds {
            cx: 50.0,
            cy: 60.0,
            width: 0.0,
            height: 0.0,
            rotation: 0.0,
        };
        let list = get_box_mask_handle_positions(MaskHandleBoxOptions {
            center_x: 0.3,
            center_y: -0.7,
            width: 0.5,
            height: 0.5,
            rotation: 0.0,
            feather: 0.0,
            size_mode: MaskHandleSizeMode::WidthHeight,
            show_scale_handle: None,
            bounds: empty,
            display_scale: 1.0,
        });
        // A zero-size element makes the normalised centre offsets vanish too,
        // so everything lands on the element centre — apart from the icons,
        // which keep their fixed screen offset.
        for handle in &list.handles {
            assert_eq!(handle.x, 50.0);
        }
        assert_eq!(handle(&list, &MaskHandleId::Rotation).y, 60.0 - 20.0);
        assert_eq!(handle(&list, &MaskHandleId::Feather).y, 60.0 + 20.0);
        assert_eq!(
            handle(
                &list,
                &MaskHandleId::Edge {
                    side: MaskHandleSide::Bottom
                }
            )
            .y,
            60.0
        );

        let (start, end) = line_ends(&get_line_mask_overlay(MaskOverlayLineOptions {
            center_x: 0.3,
            center_y: -0.7,
            rotation: 0.0,
            bounds: empty,
            handle_id: None,
            cursor: None,
        }));
        // Zero extent leaves a degenerate line rather than a NaN.
        assert_eq!(start, MaskOverlayPoint { x: 50.0, y: 60.0 });
        assert_eq!(end, MaskOverlayPoint { x: 50.0, y: 60.0 });
    }

    #[test]
    fn the_rect_overlay_scales_the_normalised_size_onto_the_element() {
        let overlay = get_box_mask_rect_overlay(MaskOverlayRectOptions {
            center_x: 0.25,
            center_y: 0.5,
            width: 0.5,
            height: 0.25,
            rotation: 30.0,
            bounds: bounds(),
            handle_id: None,
            cursor: None,
            dashed: None,
        });
        assert_eq!(
            overlay,
            MaskOverlayItem::Rect {
                id: "bounding-box".to_string(),
                center: MaskOverlayPoint { x: 200.0, y: 350.0 },
                width: 200.0,
                height: 75.0,
                rotation: 30.0,
                dashed: false,
                cursor: "move".to_string(),
                handle_id: MaskHandleId::Position,
            }
        );
    }

    #[test]
    fn a_shape_path_adds_an_outline_and_dashes_the_box() {
        let list = get_box_mask_overlays(MaskOverlayBoxOptions {
            params: MaskOverlayBoxParams {
                center_x: 0.0,
                center_y: 0.0,
                width: 1.0,
                height: 1.0,
                rotation: 0.0,
            },
            bounds: bounds(),
            path_data: Some("M0 0 L1 1".to_string()),
            show_bounding_box: None,
        });
        assert_eq!(list.overlays.len(), 2);
        match &list.overlays[0] {
            MaskOverlayItem::Rect { dashed, .. } => assert!(*dashed),
            other => panic!("expected the bounding box first, got {other:?}"),
        }
        assert_eq!(
            list.overlays[1],
            MaskOverlayItem::Shape {
                id: "shape-outline".to_string(),
                center: MaskOverlayPoint { x: 100.0, y: 200.0 },
                width: 400.0,
                height: 300.0,
                rotation: 0.0,
                path_data: "M0 0 L1 1".to_string(),
                cursor: "move".to_string(),
                handle_id: MaskHandleId::Position,
            }
        );
    }

    #[test]
    fn no_path_leaves_a_solid_bounding_box_on_its_own() {
        let list = get_box_mask_overlays(MaskOverlayBoxOptions {
            params: MaskOverlayBoxParams {
                center_x: 0.0,
                center_y: 0.0,
                width: 1.0,
                height: 1.0,
                rotation: 0.0,
            },
            bounds: bounds(),
            path_data: None,
            show_bounding_box: None,
        });
        assert_eq!(list.overlays.len(), 1);
        match &list.overlays[0] {
            MaskOverlayItem::Rect { dashed, .. } => assert!(!*dashed),
            other => panic!("expected a bounding box, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_path_counts_as_no_path_at_all() {
        let list = get_box_mask_overlays(MaskOverlayBoxOptions {
            params: MaskOverlayBoxParams {
                center_x: 0.0,
                center_y: 0.0,
                width: 1.0,
                height: 1.0,
                rotation: 0.0,
            },
            bounds: bounds(),
            path_data: Some(String::new()),
            show_bounding_box: None,
        });
        assert_eq!(list.overlays.len(), 1);
        match &list.overlays[0] {
            MaskOverlayItem::Rect { dashed, .. } => assert!(!*dashed),
            other => panic!("expected a bounding box, got {other:?}"),
        }
    }

    #[test]
    fn hiding_the_bounding_box_leaves_only_the_shape() {
        let list = get_box_mask_overlays(MaskOverlayBoxOptions {
            params: MaskOverlayBoxParams {
                center_x: 0.0,
                center_y: 0.0,
                width: 1.0,
                height: 1.0,
                rotation: 0.0,
            },
            bounds: bounds(),
            path_data: Some("M0 0".to_string()),
            show_bounding_box: Some(false),
        });
        assert_eq!(list.overlays.len(), 1);
        match &list.overlays[0] {
            MaskOverlayItem::Shape { .. } => {}
            other => panic!("expected a shape outline, got {other:?}"),
        }

        let neither = get_box_mask_overlays(MaskOverlayBoxOptions {
            params: MaskOverlayBoxParams {
                center_x: 0.0,
                center_y: 0.0,
                width: 1.0,
                height: 1.0,
                rotation: 0.0,
            },
            bounds: bounds(),
            path_data: None,
            show_bounding_box: Some(false),
        });
        assert!(neither.overlays.is_empty());
    }

    #[test]
    fn optional_handle_fields_are_omitted_rather_than_null() {
        let list = get_box_mask_handle_positions(box_options(
            MaskHandleSizeMode::WidthHeight,
            0.0,
        ));
        let rotate = serde_json::to_value(handle(&list, &MaskHandleId::Rotation)).unwrap();
        let object = rotate.as_object().unwrap();
        assert!(!object.contains_key("isSelected"));
        assert!(!object.contains_key("edgeAxis"));
        assert!(!object.contains_key("rotation"));
        assert_eq!(object.get("icon").and_then(|icon| icon.as_str()), Some("rotate"));

        let corner = serde_json::to_value(handle(
            &list,
            &MaskHandleId::Corner {
                corner: MaskHandleCorner {
                    x: MaskHandleCornerX::Left,
                    y: MaskHandleCornerY::Top,
                },
            },
        ))
        .unwrap();
        assert!(!corner.as_object().unwrap().contains_key("icon"));
        assert_eq!(
            corner.get("id").unwrap(),
            &serde_json::json!({ "kind": "corner", "corner": { "x": "left", "y": "top" } })
        );
    }

    #[test]
    fn the_size_mode_names_match_the_typescript_strings() {
        for (text, expected) in [
            ("none", MaskHandleSizeMode::None),
            ("uniform", MaskHandleSizeMode::Uniform),
            ("width-height", MaskHandleSizeMode::WidthHeight),
            ("height-only", MaskHandleSizeMode::HeightOnly),
            ("width-only", MaskHandleSizeMode::WidthOnly),
        ] {
            let parsed: MaskHandleSizeMode =
                serde_json::from_value(serde_json::Value::String(text.to_string())).unwrap();
            assert_eq!(parsed, expected);
        }
    }
}
