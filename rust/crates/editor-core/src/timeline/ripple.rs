//! Ripple editing: closing the gap an edit left behind.
//!
//! Run as a post-pass over a whole command rather than inside one, by diffing
//! the tracks before and after. That is why it is expressed as interval
//! arithmetic instead of as knowledge of what the command did: it does not need
//! to know, only to see what space came free.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

use crate::model::{SceneTracks, Track};

/// A half-open span of timeline time that came free.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Interval {
    start: i64,
    end: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RippleAdjustment {
    pub track_id: String,
    /// Everything starting at or after this time moves left.
    pub after_time: MediaTime,
    pub shift_amount: MediaTime,
}

/// Only a span with real width is worth keeping; a zero-length or inverted one
/// is not a gap.
fn push_interval(intervals: &mut Vec<Interval>, start: i64, end: i64) {
    if end <= start {
        return;
    }
    intervals.push(Interval { start, end });
}

/// Sort and merge touching or overlapping spans, so the arithmetic below only
/// ever sees a disjoint ascending set.
fn normalize(intervals: Vec<Interval>) -> Vec<Interval> {
    let mut sorted: Vec<Interval> = intervals
        .into_iter()
        .filter(|interval| interval.end > interval.start)
        .collect();
    sorted.sort_by_key(|interval| interval.start);

    let mut merged: Vec<Interval> = Vec::with_capacity(sorted.len());
    for interval in sorted {
        match merged.last_mut() {
            Some(previous) if interval.start <= previous.end => {
                previous.end = previous.end.max(interval.end);
            }
            _ => merged.push(interval),
        }
    }
    merged
}

fn subtract_one(source: Interval, overlapping: &[Interval]) -> Vec<Interval> {
    let mut remaining = vec![source];

    for cut in overlapping {
        let mut next: Vec<Interval> = Vec::new();
        for interval in &remaining {
            if cut.end <= interval.start || cut.start >= interval.end {
                next.push(*interval);
                continue;
            }
            push_interval(&mut next, interval.start, cut.start);
            push_interval(&mut next, cut.end, interval.end);
        }
        remaining = next;
        if remaining.is_empty() {
            return remaining;
        }
    }

    remaining
}

fn subtract(source: Vec<Interval>, overlapping: Vec<Interval>) -> Vec<Interval> {
    let overlapping = normalize(overlapping);
    normalize(source)
        .into_iter()
        .flat_map(|interval| subtract_one(interval, &overlapping))
        .collect()
}

struct Span {
    id: String,
    start: i64,
    end: i64,
}

fn spans(track: &Track) -> Vec<Span> {
    track
        .elements()
        .iter()
        .map(|element| Span {
            id: element.id.clone(),
            start: element.start_time.as_ticks(),
            end: element.start_time.as_ticks() + element.duration.as_ticks(),
        })
        .collect()
}

fn track_list(tracks: &SceneTracks) -> Vec<&Track> {
    let mut list: Vec<&Track> = tracks.overlay.iter().collect();
    list.push(&tracks.main);
    list.extend(tracks.audio.iter());
    list
}

fn track_adjustments(
    track_id: &str,
    before: &[Span],
    after: &[Span],
    all_after_ids: &[String],
) -> Vec<RippleAdjustment> {
    let mut vacated: Vec<Interval> = Vec::new();
    let mut joined: Vec<Interval> = Vec::new();

    for span in before {
        match after.iter().find(|candidate| candidate.id == span.id) {
            None => {
                // Gone from this track. If it turned up on another one it was
                // moved, not deleted, and moving leaves the timeline's total
                // occupancy unchanged — so no gap to close.
                let moved_elsewhere = all_after_ids.iter().any(|id| id == &span.id);
                if !moved_elsewhere {
                    push_interval(&mut vacated, span.start, span.end);
                }
            }
            Some(current) => {
                // Still here but shorter: the tail it gave up is a gap.
                if span.end > current.end {
                    push_interval(&mut vacated, current.end, span.end);
                }
            }
        }
    }

    for span in after {
        if before.iter().any(|candidate| candidate.id == span.id) {
            continue;
        }
        // Something new landed here, so this span is not free after all.
        push_interval(&mut joined, span.start, span.end);
    }

    subtract(vacated, joined)
        .into_iter()
        .filter_map(|interval| {
            let shift = interval.end - interval.start;
            (shift > 0).then(|| RippleAdjustment {
                track_id: track_id.to_string(),
                after_time: MediaTime::from_ticks(interval.end),
                shift_amount: MediaTime::from_ticks(shift),
            })
        })
        .collect()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputeRippleOptions {
    pub before_tracks: SceneTracks,
    pub after_tracks: SceneTracks,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RippleAdjustments {
    pub adjustments: Vec<RippleAdjustment>,
}

/// What space an edit freed, per track.
#[export]
pub fn compute_ripple_adjustments(
    ComputeRippleOptions {
        before_tracks,
        after_tracks,
    }: ComputeRippleOptions,
) -> RippleAdjustments {
    let after_tracks_list = track_list(&after_tracks);
    let all_after_ids: Vec<String> = after_tracks_list
        .iter()
        .flat_map(|track| track.elements().iter().map(|element| element.id.clone()))
        .collect();

    let adjustments = track_list(&before_tracks)
        .into_iter()
        .flat_map(|before_track| {
            let after = after_tracks_list
                .iter()
                .find(|track| track.id() == before_track.id())
                .map(|track| spans(track))
                .unwrap_or_default();
            track_adjustments(
                before_track.id(),
                &spans(before_track),
                &after,
                &all_after_ids,
            )
        })
        .collect();

    RippleAdjustments { adjustments }
}

fn apply_to_track(track: &Track, adjustments: &[&RippleAdjustment]) -> Track {
    if adjustments.is_empty() {
        return track.clone();
    }

    // Latest gap first. Closing from the right means an earlier adjustment's
    // `afterTime` still refers to where things were when it was computed.
    let mut ordered: Vec<&&RippleAdjustment> = adjustments.iter().collect();
    ordered.sort_by(|a, b| b.after_time.as_ticks().cmp(&a.after_time.as_ticks()));

    let mut elements = track.elements().to_vec();
    for adjustment in ordered {
        for element in elements.iter_mut() {
            if element.start_time.as_ticks() >= adjustment.after_time.as_ticks() {
                element.start_time = MediaTime::from_ticks(
                    element.start_time.as_ticks() - adjustment.shift_amount.as_ticks(),
                );
            }
        }
    }
    track.with_elements(elements)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRippleOptions {
    pub tracks: SceneTracks,
    pub adjustments: Vec<RippleAdjustment>,
}

/// Close the gaps, pulling everything after each one to the left.
#[export]
pub fn apply_ripple_adjustments(
    ApplyRippleOptions {
        tracks,
        adjustments,
    }: ApplyRippleOptions,
) -> SceneTracks {
    if adjustments.is_empty() {
        return tracks;
    }

    let for_track = |id: &str| -> Vec<&RippleAdjustment> {
        adjustments
            .iter()
            .filter(|adjustment| adjustment.track_id == id)
            .collect()
    };

    SceneTracks {
        overlay: tracks
            .overlay
            .iter()
            .map(|track| apply_to_track(track, &for_track(track.id())))
            .collect(),
        main: apply_to_track(&tracks.main, &for_track(tracks.main.id())),
        audio: tracks
            .audio
            .iter()
            .map(|track| apply_to_track(track, &for_track(track.id())))
            .collect(),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShiftElementsOptions {
    pub elements: Vec<crate::model::TimelineElement>,
    pub after_time: MediaTime,
    pub shift_amount: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShiftedElements {
    pub elements: Vec<crate::model::TimelineElement>,
}

/// Move everything starting at or after `afterTime` left by `shiftAmount`.
/// Exported on its own because closing a gap by hand uses it directly, without
/// the diff that normally decides where the gaps are.
#[export]
pub fn ripple_shift_elements(
    ShiftElementsOptions {
        elements,
        after_time,
        shift_amount,
    }: ShiftElementsOptions,
) -> ShiftedElements {
    ShiftedElements {
        elements: elements
            .into_iter()
            .map(|mut element| {
                if element.start_time.as_ticks() >= after_time.as_ticks() {
                    element.start_time = MediaTime::from_ticks(
                        element.start_time.as_ticks() - shift_amount.as_ticks(),
                    );
                }
                element
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ElementKind, TimelineElement};
    use std::collections::HashMap;

    fn element(id: &str, start: i64, duration: i64) -> TimelineElement {
        TimelineElement {
            id: id.to_string(),
            name: id.to_string(),
            duration: MediaTime::from_ticks(duration),
            start_time: MediaTime::from_ticks(start),
            trim_start: MediaTime::ZERO,
            trim_end: MediaTime::ZERO,
            source_duration: None,
            animations: None,
            params: HashMap::new(),
            group_id: None,
            kind: ElementKind::Text {
                hidden: None,
                fade: None,
            },
        }
    }

    fn tracks(elements: Vec<TimelineElement>) -> SceneTracks {
        SceneTracks {
            overlay: vec![],
            main: Track::Video {
                id: "main".to_string(),
                name: "Main".to_string(),
                elements,
                muted: false,
                hidden: false,
            },
            audio: vec![],
        }
    }

    fn starts(tracks: &SceneTracks) -> Vec<i64> {
        tracks
            .main
            .elements()
            .iter()
            .map(|element| element.start_time.as_ticks())
            .collect()
    }

    fn ripple(before: SceneTracks, after: SceneTracks) -> SceneTracks {
        let adjustments = compute_ripple_adjustments(ComputeRippleOptions {
            before_tracks: before,
            after_tracks: after.clone(),
        })
        .adjustments;
        apply_ripple_adjustments(ApplyRippleOptions {
            tracks: after,
            adjustments,
        })
    }

    #[test]
    fn deleting_a_clip_pulls_the_rest_left_over_its_gap() {
        let before = tracks(vec![
            element("a", 0, 1000),
            element("b", 1000, 1000),
            element("c", 2000, 1000),
        ]);
        let after = tracks(vec![element("a", 0, 1000), element("c", 2000, 1000)]);

        assert_eq!(starts(&ripple(before, after)), vec![0, 1000]);
    }

    #[test]
    fn shortening_a_clip_closes_the_tail_it_gave_up() {
        let before = tracks(vec![element("a", 0, 1000), element("b", 1000, 1000)]);
        let after = tracks(vec![element("a", 0, 400), element("b", 1000, 1000)]);

        // 600 ticks came free at the end of `a`, so `b` moves back by that much.
        assert_eq!(starts(&ripple(before, after)), vec![0, 400]);
    }

    #[test]
    fn a_clip_moved_to_another_track_leaves_no_gap_to_close() {
        // Moving does not change how much the timeline holds, so nothing shifts.
        let before = SceneTracks {
            overlay: vec![Track::Text {
                id: "overlay".to_string(),
                name: "Text".to_string(),
                elements: vec![],
                hidden: false,
            }],
            ..tracks(vec![element("a", 0, 1000), element("b", 1000, 1000)])
        };
        let after = SceneTracks {
            overlay: vec![Track::Text {
                id: "overlay".to_string(),
                name: "Text".to_string(),
                elements: vec![element("a", 0, 1000)],
                hidden: false,
            }],
            ..tracks(vec![element("b", 1000, 1000)])
        };

        let adjustments = compute_ripple_adjustments(ComputeRippleOptions {
            before_tracks: before,
            after_tracks: after,
        })
        .adjustments;
        assert_eq!(adjustments, vec![]);
    }

    #[test]
    fn a_replacement_landing_in_the_gap_cancels_it() {
        let before = tracks(vec![element("a", 0, 1000), element("b", 1000, 1000)]);
        // `a` is gone but `new` occupies exactly the space it left.
        let after = tracks(vec![element("new", 0, 1000), element("b", 1000, 1000)]);

        let adjustments = compute_ripple_adjustments(ComputeRippleOptions {
            before_tracks: before,
            after_tracks: after,
        })
        .adjustments;
        assert_eq!(adjustments, vec![]);
    }

    #[test]
    fn a_replacement_covering_part_of_the_gap_leaves_the_rest() {
        let before = tracks(vec![element("a", 0, 1000), element("b", 1000, 1000)]);
        // `new` covers the first 400, so 600 is still free.
        let after = tracks(vec![element("new", 0, 400), element("b", 1000, 1000)]);

        assert_eq!(starts(&ripple(before, after)), vec![0, 400]);
    }

    #[test]
    fn two_gaps_close_together_without_double_counting() {
        let before = tracks(vec![
            element("a", 0, 500),
            element("b", 500, 500),
            element("c", 1000, 500),
            element("d", 1500, 500),
        ]);
        // Both `a` and `c` deleted: 500 before `b` and 500 before `d`.
        let after = tracks(vec![element("b", 500, 500), element("d", 1500, 500)]);

        assert_eq!(starts(&ripple(before, after)), vec![0, 500]);
    }

    #[test]
    fn adjacent_gaps_merge_into_one_shift() {
        let before = tracks(vec![
            element("a", 0, 500),
            element("b", 500, 500),
            element("c", 1000, 500),
        ]);
        // `a` and `b` are adjacent, so the freed span is one 1000-tick interval.
        let after = tracks(vec![element("c", 1000, 500)]);

        assert_eq!(starts(&ripple(before, after)), vec![0]);
    }

    #[test]
    fn applying_no_adjustments_returns_the_tracks_untouched() {
        let original = tracks(vec![element("a", 300, 500)]);
        let result = apply_ripple_adjustments(ApplyRippleOptions {
            tracks: original.clone(),
            adjustments: vec![],
        });
        assert_eq!(result, original);
    }

    #[test]
    fn a_shift_leaves_the_tracks_own_flags_alone() {
        // `with_elements` has to preserve the variant and its flags; a muted
        // track that came back unmuted would be a silent regression.
        let before = tracks(vec![element("a", 0, 500), element("b", 500, 500)]);
        let mut after = tracks(vec![element("b", 500, 500)]);
        let Track::Video { muted, hidden, .. } = &mut after.main else {
            panic!("main is a video track")
        };
        *muted = true;
        *hidden = true;

        let rippled = ripple(before, after);
        let Track::Video { muted, hidden, .. } = &rippled.main else {
            panic!("still a video track")
        };
        assert!(*muted && *hidden, "track flags were lost in the rebuild");
    }

    #[test]
    fn an_element_before_the_gap_does_not_move() {
        let before = tracks(vec![
            element("early", 0, 200),
            element("a", 500, 500),
            element("b", 1000, 500),
        ]);
        let after = tracks(vec![element("early", 0, 200), element("b", 1000, 500)]);

        // `early` sits before the freed span, so only `b` moves.
        assert_eq!(starts(&ripple(before, after)), vec![0, 500]);
    }
}
