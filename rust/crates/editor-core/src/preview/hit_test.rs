//! What the pointer is over in the preview — `apps/web/src/preview/hit-test.ts`.
//!
//! Elements are tested as rotated rectangles: the point is moved into each
//! element's own frame and compared against its half-extents, which is the
//! same test the transform handles use and is why a rotated clip is grabbed
//! by its rotated outline rather than by its axis-aligned bounding box.
//!
//! Indices cross the bridge, not elements. The caller already holds the array
//! it built the bounds from, so sending whole timeline elements back would
//! serialise a clip's entire parameter tree to answer "which one".

use bridge::export;
use serde::Deserialize;

/// One element's placement on the canvas, as the hit test sees it.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HitTestBounds {
    pub cx: f64,
    pub cy: f64,
    pub width: f64,
    pub height: f64,
    /// Degrees, matching what an element's transform stores.
    pub rotation: f64,
}

/// Whether a canvas point falls inside a rotated rectangle. A negative width
/// or height is a flipped element, and flipping does not move the outline —
/// hence the absolute values.
fn point_in_rotated_rect(px: f64, py: f64, bounds: HitTestBounds) -> bool {
    let angle_rad = (bounds.rotation * std::f64::consts::PI) / 180.0;
    let cos = (-angle_rad).cos();
    let sin = (-angle_rad).sin();
    let dx = px - bounds.cx;
    let dy = py - bounds.cy;
    let local_x = dx * cos - dy * sin;
    let local_y = dx * sin + dy * cos;
    let half_width = bounds.width.abs() / 2.0;
    let half_height = bounds.height.abs() / 2.0;

    local_x >= -half_width
        && local_x <= half_width
        && local_y >= -half_height
        && local_y <= half_height
}

/// Every element under the point, front to back.
///
/// The caller's array is in draw order — back to front — so this walks it
/// backwards: the first result is the topmost element, which is the one a
/// plain click selects.
pub fn hit_element_indexes(canvas_x: f64, canvas_y: f64, bounds: &[HitTestBounds]) -> Vec<u32> {
    (0..bounds.len())
        .rev()
        .filter(|index| point_in_rotated_rect(canvas_x, canvas_y, bounds[*index]))
        .map(|index| index as u32)
        .collect()
}

/// A reference to one element on the timeline.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HitTestElementRef {
    pub track_id: String,
    pub element_id: String,
}

/// The first hit that is already selected, as an index into `hits`.
///
/// This is what makes clicking a stack of overlapping clips keep the one the
/// user is working on rather than jumping to whatever is on top. With nothing
/// selected there is no preference to honour and the answer is `None`.
pub fn preferred_hit_index(
    hits: &[HitTestElementRef],
    preferred_elements: &[HitTestElementRef],
) -> Option<u32> {
    if preferred_elements.is_empty() {
        return None;
    }

    hits.iter()
        .position(|hit| preferred_elements.contains(hit))
        .map(|index| index as u32)
}

// Bridge surface.

/// Indices into the caller's array, topmost first.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HitTestIndexes {
    pub indexes: Vec<u32>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HitElementIndexesOptions {
    pub canvas_x: f64,
    pub canvas_y: f64,
    /// In draw order, back to front.
    pub bounds: Vec<HitTestBounds>,
}

#[export]
pub fn get_hit_element_indexes(
    HitElementIndexesOptions {
        canvas_x,
        canvas_y,
        bounds,
    }: HitElementIndexesOptions,
) -> HitTestIndexes {
    HitTestIndexes {
        indexes: hit_element_indexes(canvas_x, canvas_y, &bounds),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreferredHitIndexOptions {
    pub hits: Vec<HitTestElementRef>,
    pub preferred_elements: Vec<HitTestElementRef>,
}

/// `undefined` when nothing preferred was hit — the façade maps it to the
/// `null` its callers already branch on.
#[export]
pub fn get_preferred_hit_index(
    PreferredHitIndexOptions {
        hits,
        preferred_elements,
    }: PreferredHitIndexOptions,
) -> Option<u32> {
    preferred_hit_index(&hits, &preferred_elements)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(cx: f64, cy: f64, width: f64, height: f64, rotation: f64) -> HitTestBounds {
        HitTestBounds {
            cx,
            cy,
            width,
            height,
            rotation,
        }
    }

    fn element(track: &str, id: &str) -> HitTestElementRef {
        HitTestElementRef {
            track_id: track.to_string(),
            element_id: id.to_string(),
        }
    }

    #[test]
    fn a_point_inside_an_axis_aligned_box_hits_it() {
        let boxes = [bounds(100.0, 100.0, 200.0, 100.0, 0.0)];
        assert_eq!(hit_element_indexes(100.0, 100.0, &boxes), vec![0]);
        assert_eq!(hit_element_indexes(199.0, 149.0, &boxes), vec![0]);
    }

    #[test]
    fn the_edge_counts_as_inside() {
        // Inclusive on all four sides, so a click on the outline selects.
        let boxes = [bounds(0.0, 0.0, 100.0, 100.0, 0.0)];
        assert_eq!(hit_element_indexes(50.0, 50.0, &boxes), vec![0]);
        assert!(hit_element_indexes(50.001, 50.0, &boxes).is_empty());
    }

    #[test]
    fn rotation_moves_the_box_rather_than_growing_it() {
        // A 200x40 bar turned 90° covers a tall thin strip: a point 80 above
        // the centre is inside it, and one 80 to the right is not — the
        // opposite of the unrotated case.
        let boxes = [bounds(0.0, 0.0, 200.0, 40.0, 90.0)];
        assert_eq!(hit_element_indexes(0.0, 80.0, &boxes), vec![0]);
        assert!(hit_element_indexes(80.0, 0.0, &boxes).is_empty());
    }

    #[test]
    fn a_flipped_element_keeps_its_outline() {
        // Negative scale flips the picture; it does not move the box, so the
        // extents are compared as magnitudes.
        let boxes = [bounds(0.0, 0.0, -200.0, -100.0, 0.0)];
        assert_eq!(hit_element_indexes(90.0, 40.0, &boxes), vec![0]);
    }

    #[test]
    fn hits_come_back_topmost_first() {
        // The caller's array is back-to-front, so the last entry is on top.
        let boxes = [
            bounds(0.0, 0.0, 100.0, 100.0, 0.0),
            bounds(0.0, 0.0, 50.0, 50.0, 0.0),
            bounds(500.0, 500.0, 50.0, 50.0, 0.0),
        ];
        assert_eq!(hit_element_indexes(0.0, 0.0, &boxes), vec![1, 0]);
    }

    #[test]
    fn nothing_under_the_pointer_is_an_empty_list() {
        let boxes = [bounds(0.0, 0.0, 10.0, 10.0, 0.0)];
        assert!(hit_element_indexes(100.0, 100.0, &boxes).is_empty());
        assert!(hit_element_indexes(0.0, 0.0, &[]).is_empty());
    }

    #[test]
    fn the_selected_element_wins_over_the_one_on_top() {
        // Clicking a stack keeps the clip being worked on rather than jumping
        // to whatever happens to be drawn last.
        let hits = [element("track-a", "top"), element("track-b", "selected")];
        let preferred = [element("track-b", "selected")];
        assert_eq!(preferred_hit_index(&hits, &preferred), Some(1));
    }

    #[test]
    fn a_reference_has_to_match_on_both_halves() {
        // Element ids are unique per track, so the track is part of identity.
        let hits = [element("track-a", "clip")];
        assert_eq!(preferred_hit_index(&hits, &[element("track-b", "clip")]), None);
        assert_eq!(preferred_hit_index(&hits, &[element("track-a", "other")]), None);
    }

    #[test]
    fn no_selection_means_no_preference() {
        let hits = [element("track-a", "clip")];
        assert_eq!(preferred_hit_index(&hits, &[]), None);
    }

    #[test]
    fn the_first_preferred_hit_wins_not_the_first_preference() {
        // Order is read off the hit stack — front to back — so the topmost
        // selected element is the one that keeps the selection.
        let hits = [
            element("track-a", "one"),
            element("track-b", "two"),
            element("track-c", "three"),
        ];
        let preferred = [element("track-c", "three"), element("track-b", "two")];
        assert_eq!(preferred_hit_index(&hits, &preferred), Some(1));
    }
}
