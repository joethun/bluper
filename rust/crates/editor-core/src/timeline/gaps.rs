//! Empty space between clips, and closing it.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

use crate::model::{SceneTracks, Track};

/// Empty space on one track that sits between two pieces of material — or
/// between the start of the timeline and the first clip.
///
/// Space *after* the last clip is deliberately not a gap: there is nothing on
/// the far side to pull back, so closing it would be a no-op.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineGap {
    pub track_id: String,
    pub start_time: MediaTime,
    pub end_time: MediaTime,
}

/// Walks the track in start order carrying a high-water mark of how far material
/// reaches, so overlapping clips — which a track can hold while a transition is
/// being placed — close a gap rather than opening a phantom one behind them.
fn scan_gaps(track: &Track) -> Vec<TimelineGap> {
    let mut sorted: Vec<(i64, i64)> = track
        .elements()
        .iter()
        .map(|element| {
            (
                element.start_time.as_ticks(),
                element.start_time.as_ticks() + element.duration.as_ticks(),
            )
        })
        .collect();
    sorted.sort_by_key(|(start, _)| *start);

    let mut gaps = Vec::new();
    let mut filled_until = 0i64;
    for (start, end) in sorted {
        if start > filled_until {
            gaps.push(TimelineGap {
                track_id: track.id().to_string(),
                start_time: MediaTime::from_ticks(filled_until),
                end_time: MediaTime::from_ticks(start),
            });
        }
        filled_until = filled_until.max(end);
    }
    gaps
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FindGapAtTimeOptions {
    pub track: Track,
    pub time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundGap {
    pub gap: Option<TimelineGap>,
}

/// The gap `time` falls inside, if any.
#[export]
pub fn find_gap_at_time(FindGapAtTimeOptions { track, time }: FindGapAtTimeOptions) -> FoundGap {
    let ticks = time.as_ticks();
    FoundGap {
        gap: scan_gaps(&track).into_iter().find(|gap| {
            ticks >= gap.start_time.as_ticks() && ticks < gap.end_time.as_ticks()
        }),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackOptions {
    pub track: Track,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundGaps {
    pub gaps: Vec<TimelineGap>,
}

/// Every gap on the track, in timeline order.
#[export]
pub fn find_gaps(TrackOptions { track }: TrackOptions) -> FoundGaps {
    FoundGaps {
        gaps: scan_gaps(&track),
    }
}

fn close_in_track(track: &Track, gap: &TimelineGap) -> Track {
    if track.id() != gap.track_id {
        return track.clone();
    }
    let shift = gap.end_time.as_ticks() - gap.start_time.as_ticks();
    if shift <= 0 {
        return track.clone();
    }

    let elements = track
        .elements()
        .iter()
        .map(|element| {
            if element.start_time.as_ticks() >= gap.end_time.as_ticks() {
                let mut moved = element.clone();
                moved.start_time = MediaTime::from_ticks(element.start_time.as_ticks() - shift);
                moved
            } else {
                element.clone()
            }
        })
        .collect();
    track.with_elements(elements)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloseGapOptions {
    pub tracks: SceneTracks,
    pub gap: TimelineGap,
}

/// Pulls everything after the gap back over it, on that track alone.
///
/// Only the one track moves. Closing a gap on every track at once would be a
/// different edit — it would slide unrelated material out of sync with the
/// picture it was cut against — so the caller asks for the track it clicked.
#[export]
pub fn close_gap(CloseGapOptions { tracks, gap }: CloseGapOptions) -> SceneTracks {
    SceneTracks {
        overlay: tracks
            .overlay
            .iter()
            .map(|track| close_in_track(track, &gap))
            .collect(),
        main: close_in_track(&tracks.main, &gap),
        audio: tracks
            .audio
            .iter()
            .map(|track| close_in_track(track, &gap))
            .collect(),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloseAllGapsOptions {
    pub tracks: SceneTracks,
    pub track: Track,
}

/// Closes every gap on the track, latest first — closing an earlier one would
/// move every gap behind it, and the shifts are computed against positions that
/// have not moved yet.
#[export]
pub fn close_all_gaps(
    CloseAllGapsOptions { tracks, track }: CloseAllGapsOptions,
) -> SceneTracks {
    let mut next = tracks;
    for gap in scan_gaps(&track).into_iter().rev() {
        next = close_gap(CloseGapOptions { tracks: next, gap });
    }
    next
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
            kind: ElementKind::Text {
                hidden: None,
                fade: None,
            },
        }
    }

    fn track(elements: Vec<TimelineElement>) -> Track {
        Track::Video {
            id: "main".to_string(),
            name: "Main".to_string(),
            elements,
            muted: false,
            hidden: false,
        }
    }

    fn scene(track: Track) -> SceneTracks {
        SceneTracks {
            overlay: vec![],
            main: track,
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

    #[test]
    fn a_gap_before_the_first_clip_counts() {
        let gaps = scan_gaps(&track(vec![element("a", 500, 100)]));
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].start_time.as_ticks(), 0);
        assert_eq!(gaps[0].end_time.as_ticks(), 500);
    }

    #[test]
    fn space_after_the_last_clip_is_not_a_gap() {
        // Nothing on the far side to pull back, so there is nothing to close.
        let gaps = scan_gaps(&track(vec![element("a", 0, 100)]));
        assert_eq!(gaps, vec![]);
    }

    #[test]
    fn overlapping_clips_do_not_open_a_phantom_gap_behind_them() {
        // `b` starts inside `a`. The high-water mark means the space after `b`'s
        // start is already filled, so no gap is reported.
        let gaps = scan_gaps(&track(vec![
            element("a", 0, 1000),
            element("b", 400, 200),
            element("c", 1000, 100),
        ]));
        assert_eq!(gaps, vec![]);
    }

    #[test]
    fn clips_out_of_order_are_scanned_in_time_order() {
        let gaps = scan_gaps(&track(vec![
            element("late", 800, 100),
            element("early", 0, 200),
        ]));
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].start_time.as_ticks(), 200);
        assert_eq!(gaps[0].end_time.as_ticks(), 800);
    }

    #[test]
    fn find_gap_at_time_uses_a_half_open_span() {
        let found = |time: i64| {
            find_gap_at_time(FindGapAtTimeOptions {
                track: track(vec![element("a", 0, 100), element("b", 500, 100)]),
                time: MediaTime::from_ticks(time),
            })
            .gap
            .is_some()
        };
        assert!(!found(99));
        assert!(found(100));
        assert!(found(499));
        // The gap ends where the next clip begins.
        assert!(!found(500));
    }

    #[test]
    fn closing_a_gap_moves_only_the_clips_after_it() {
        let tracks = scene(track(vec![
            element("a", 0, 100),
            element("b", 500, 100),
            element("c", 700, 100),
        ]));
        let gap = TimelineGap {
            track_id: "main".to_string(),
            start_time: MediaTime::from_ticks(100),
            end_time: MediaTime::from_ticks(500),
        };
        assert_eq!(starts(&close_gap(CloseGapOptions { tracks, gap })), vec![0, 100, 300]);
    }

    #[test]
    fn closing_a_gap_on_another_track_leaves_this_one_alone() {
        let tracks = scene(track(vec![element("a", 0, 100), element("b", 500, 100)]));
        let gap = TimelineGap {
            track_id: "somewhere-else".to_string(),
            start_time: MediaTime::from_ticks(100),
            end_time: MediaTime::from_ticks(500),
        };
        assert_eq!(starts(&close_gap(CloseGapOptions { tracks, gap })), vec![0, 500]);
    }

    #[test]
    fn closing_all_gaps_leaves_the_track_contiguous() {
        let tracks = scene(track(vec![
            element("a", 200, 100),
            element("b", 800, 100),
            element("c", 2000, 100),
        ]));
        let closed = close_all_gaps(CloseAllGapsOptions {
            tracks: tracks.clone(),
            track: tracks.main.clone(),
        });
        assert_eq!(starts(&closed), vec![0, 100, 200]);
    }
}
