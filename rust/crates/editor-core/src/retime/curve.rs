//! The speed curve: a Catmull-Rom spline through the handles, interpolated in
//! log space, plus the numeric integral that turns source time into clip time.
//!
//! Interpolating the *logarithm* of speed rather than speed is what makes the
//! graph behave: its axis is logarithmic, so a spline drawn straight through the
//! handles on screen is a spline through their logs. Going up an octave and back
//! down lands where it started instead of drifting high, and the curve cannot
//! undershoot into zero or negative speed the way a steep linear drop can.

use std::cell::RefCell;

use crate::model::{RetimeConfig, RetimeCurve, RetimeCurvePoint};

use super::rate::clamp_curve_rate;

/// Handles closer together than this collapse into one. Two handles at the same
/// position would make the curve vertical — an instant speed jump the time
/// integral cannot resolve — and dragging one onto another is easy to do by
/// accident, so the near-miss is treated as the same miss.
const MIN_POINT_SPACING: f64 = 0.005;

pub const MAX_CURVE_POINTS: usize = 12;

/// Segments the curve is diced into to integrate it. The speed at a point is
/// cheap to evaluate but the clip's own clock is the integral of 1/speed, which
/// has no closed form for a spline — so it is summed numerically once per curve
/// and cached. Trapezoid error falls off as 1/N², so this is far finer than the
/// millisecond the timeline rounds to.
const TABLE_RESOLUTION: usize = 512;

struct RetimeCurveTable {
    /// Clip time elapsed at each evenly spaced source position, in units of the
    /// clip's visible source span. Monotonically increasing.
    clip_at_source: Vec<f64>,
    /// Source position reached at each evenly spaced fraction of clip time.
    source_at_clip: Vec<f64>,
    /// Clip seconds the curve yields per source second: the whole integral.
    clip_per_source: f64,
}

/// The TypeScript keyed this on the curve *object*, which Rust cannot do. Keying
/// on the curve's contents works here precisely because a curve is at most
/// [`MAX_CURVE_POINTS`] handles, so comparing one is cheap — the same trick would
/// not survive on a keyframe channel or a track tree.
const TABLE_CACHE_CAPACITY: usize = 8;

thread_local! {
    static TABLE_CACHE: RefCell<Vec<(RetimeCurve, RetimeCurveTable)>> =
        RefCell::new(Vec::new());
}

/// The clip's speed curve, or nothing if it plays at one speed. A curve with no
/// handles left is treated as no curve, so an emptied one cannot silently freeze
/// a clip at some leftover speed.
pub fn retime_curve(retime: Option<&RetimeConfig>) -> Option<&RetimeCurve> {
    retime
        .and_then(|config| config.curve.as_ref())
        .filter(|curve| !curve.points.is_empty())
}

/// Puts a curve into the shape the maths assumes: handles in order, none on top
/// of another, speeds inside the axis, and a handle pinned at each end so the
/// curve spans the whole clip.
pub fn sanitize_retime_curve(curve: &RetimeCurve) -> RetimeCurve {
    let mut sorted: Vec<RetimeCurvePoint> = curve
        .points
        .iter()
        .filter(|point| point.position.is_finite())
        .map(|point| RetimeCurvePoint {
            position: point.position.max(0.0).min(1.0),
            rate: clamp_curve_rate(point.rate),
        })
        .collect();
    // `Array.prototype.sort` is stable, and equal positions do occur, so the
    // sort here has to be stable too or a collapsed pair could keep the other
    // handle's speed.
    sorted.sort_by(|a, b| a.position.partial_cmp(&b.position).expect("finite"));

    let mut points: Vec<RetimeCurvePoint> = Vec::with_capacity(sorted.len());
    for point in sorted {
        match points.last() {
            // Keep the later handle's speed: while dragging, the handle under
            // the pointer is the one the user means.
            Some(previous) if point.position - previous.position < MIN_POINT_SPACING => {
                let last = points.len() - 1;
                points[last] = point;
            }
            _ => points.push(point),
        }
    }

    if points.is_empty() {
        points.push(RetimeCurvePoint {
            position: 0.0,
            rate: 1.0,
        });
    }
    if points[0].position > 0.0 {
        points.insert(
            0,
            RetimeCurvePoint {
                position: 0.0,
                rate: points[0].rate,
            },
        );
    }
    let last = points[points.len() - 1];
    if last.position < 1.0 {
        points.push(RetimeCurvePoint {
            position: 1.0,
            rate: last.rate,
        });
    }

    // Capped after the ends are pinned, so the cap is the real handle count and
    // the curve still reaches both ends of the clip.
    let points = if points.len() <= MAX_CURVE_POINTS {
        points
    } else {
        let last = points[points.len() - 1];
        let mut capped: Vec<RetimeCurvePoint> =
            points.into_iter().take(MAX_CURVE_POINTS - 1).collect();
        capped.push(last);
        capped
    };

    RetimeCurve {
        preset: curve.preset,
        points,
    }
}

/// The speed at a fraction of the way through the clip's source.
pub fn curve_rate_at_position(curve: &RetimeCurve, position: f64) -> f64 {
    let points = &curve.points;
    if points.is_empty() {
        return 1.0;
    }
    if points.len() == 1 {
        return points[0].rate;
    }

    let clamped = position.max(0.0).min(1.0);

    let mut index = 0usize;
    while index < points.len() - 2 && points[index + 1].position < clamped {
        index += 1;
    }

    let start = points[index];
    let end = points[index + 1];
    let span = end.position - start.position;
    if span <= 0.0 {
        return end.rate;
    }

    let t = ((clamped - start.position) / span).max(0.0).min(1.0);
    let y0 = start.rate.ln();
    let y1 = end.rate.ln();

    // Catmull-Rom tangents, which is what gives the curve its swing past a
    // handle on the way to the next one rather than a chain of straight ramps.
    let m0 = tangent_at(points, index);
    let m1 = tangent_at(points, index + 1);

    let t2 = t * t;
    let t3 = t2 * t;
    let log_rate = (2.0 * t3 - 3.0 * t2 + 1.0) * y0
        + (t3 - 2.0 * t2 + t) * span * m0
        + (-2.0 * t3 + 3.0 * t2) * y1
        + (t3 - t2) * span * m1;

    clamp_curve_rate(log_rate.exp())
}

fn tangent_at(points: &[RetimeCurvePoint], index: usize) -> f64 {
    let current = points[index];
    let previous = if index == 0 {
        None
    } else {
        points.get(index - 1).copied()
    };
    let next = points.get(index + 1).copied();

    match (previous, next) {
        (None, Some(next)) => {
            (next.rate.ln() - current.rate.ln())
                / MIN_POINT_SPACING.max(next.position - current.position)
        }
        (Some(previous), None) => {
            (current.rate.ln() - previous.rate.ln())
                / MIN_POINT_SPACING.max(current.position - previous.position)
        }
        (Some(previous), Some(next)) => {
            (next.rate.ln() - previous.rate.ln())
                / MIN_POINT_SPACING.max(next.position - previous.position)
        }
        // Unreachable for a curve with two or more points, which is the only
        // way this is called.
        (None, None) => 0.0,
    }
}

fn with_table<T>(curve: &RetimeCurve, read: impl FnOnce(&RetimeCurveTable) -> T) -> T {
    TABLE_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(position) = cache.iter().position(|(key, _)| key == curve) {
            // Move to front so a clip resolving repeatedly stays cached even
            // when other curves are being evaluated between its reads.
            let entry = cache.remove(position);
            cache.insert(0, entry);
            return read(&cache[0].1);
        }

        let table = build_retime_curve_table(curve);
        cache.insert(0, (curve.clone(), table));
        cache.truncate(TABLE_CACHE_CAPACITY);
        read(&cache[0].1)
    })
}

fn build_retime_curve_table(curve: &RetimeCurve) -> RetimeCurveTable {
    let sanitized = sanitize_retime_curve(curve);
    let count = TABLE_RESOLUTION + 1;
    let step = 1.0 / TABLE_RESOLUTION as f64;

    let rates: Vec<f64> = (0..count)
        .map(|index| curve_rate_at_position(&sanitized, index as f64 * step))
        .collect();

    let mut clip_at_source = vec![0.0_f64; count];
    for index in 1..count {
        // Trapezoid on 1/rate: the clip time a slice of source takes up.
        clip_at_source[index] =
            clip_at_source[index - 1] + (step * (1.0 / rates[index - 1] + 1.0 / rates[index])) / 2.0;
    }

    let clip_per_source = clip_at_source[count - 1];
    let mut source_at_clip = vec![0.0_f64; count];
    source_at_clip[count - 1] = 1.0;

    // Invert by walking the two axes together. Both directions read the table as
    // piecewise linear, so a source position mapped forward and back lands on
    // itself instead of drifting by the interpolation error.
    let mut source = 0usize;
    for index in 1..count - 1 {
        let target = index as f64 * step * clip_per_source;
        while source < count - 2 && clip_at_source[source + 1] < target {
            source += 1;
        }
        let span_clip = clip_at_source[source + 1] - clip_at_source[source];
        let within_span = if span_clip > 0.0 {
            (target - clip_at_source[source]) / span_clip
        } else {
            0.0
        };
        source_at_clip[index] = (source as f64 + within_span) * step;
    }

    RetimeCurveTable {
        clip_at_source,
        source_at_clip,
        clip_per_source,
    }
}

fn lookup(table: &[f64], fraction: f64) -> f64 {
    let scaled = fraction * TABLE_RESOLUTION as f64;
    let lower = scaled.floor();
    if lower >= TABLE_RESOLUTION as f64 {
        return table[TABLE_RESOLUTION];
    }
    if lower < 0.0 {
        return table[0];
    }
    let index = lower as usize;
    let within = scaled - lower;
    table[index] * (1.0 - within) + table[index + 1] * within
}

/// The clip seconds one second of source takes up across the whole curve.
pub fn curve_clip_per_source(curve: &RetimeCurve) -> f64 {
    with_table(curve, |table| table.clip_per_source)
}

pub fn curve_source_fraction_at_clip_fraction(curve: &RetimeCurve, clip_fraction: f64) -> f64 {
    with_table(curve, |table| lookup(&table.source_at_clip, clip_fraction))
}

pub fn curve_clip_fraction_at_source_fraction(curve: &RetimeCurve, source_fraction: f64) -> f64 {
    with_table(curve, |table| lookup(&table.clip_at_source, source_fraction))
}

/// Speeds sampled evenly across the curve, for drawing it. One call per redraw
/// beats one spline evaluation per pixel from the render path.
pub fn sample_curve_rates(curve: &RetimeCurve, sample_count: usize) -> Vec<f64> {
    let sanitized = sanitize_retime_curve(curve);
    (0..=sample_count)
        .map(|index| {
            curve_rate_at_position(&sanitized, index as f64 / sample_count as f64)
        })
        .collect()
}

/// The same shape running a constant factor faster or slower. In log space this
/// is a shift, so every handle keeps its height relative to the others.
pub fn scale_retime_curve_rates(curve: &RetimeCurve, factor: f64) -> RetimeCurve {
    if !factor.is_finite() || factor <= 0.0 {
        return curve.clone();
    }

    RetimeCurve {
        preset: curve.preset,
        points: curve
            .points
            .iter()
            .map(|point| RetimeCurvePoint {
                position: point.position,
                rate: clamp_curve_rate(point.rate * factor),
            })
            .collect(),
    }
}

/// The stretch of curve a trim leaves visible, renormalised back onto 0..1.
pub fn slice_retime_curve(curve: &RetimeCurve, from_fraction: f64, to_fraction: f64) -> RetimeCurve {
    let from = from_fraction.max(0.0).min(1.0);
    let to = to_fraction.max(0.0).min(1.0);
    let span = to - from;

    if span <= MIN_POINT_SPACING {
        return sanitize_retime_curve(&RetimeCurve {
            preset: curve.preset,
            points: vec![RetimeCurvePoint {
                position: 0.0,
                // Deliberately the raw curve, not the sanitised one — matching
                // the TypeScript, which reads the speed before pinning ends.
                rate: curve_rate_at_position(curve, from),
            }],
        });
    }

    let sanitized = sanitize_retime_curve(curve);
    let interior = sanitized
        .points
        .iter()
        .filter(|point| point.position > from && point.position < to)
        .map(|point| RetimeCurvePoint {
            position: (point.position - from) / span,
            rate: point.rate,
        });

    let mut points = vec![RetimeCurvePoint {
        position: 0.0,
        rate: curve_rate_at_position(&sanitized, from),
    }];
    points.extend(interior);
    points.push(RetimeCurvePoint {
        position: 1.0,
        rate: curve_rate_at_position(&sanitized, to),
    });

    sanitize_retime_curve(&RetimeCurve {
        preset: curve.preset,
        points,
    })
}

/// Wrapper so the samples cross as a real JS array. A bare `Vec` serialises to
/// an object with numeric keys, which a caller indexing it as an array would
/// read as `undefined`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurveRateSamples {
    pub rates: Vec<f64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SampleCurveRatesOptions {
    pub curve: RetimeCurve,
    pub sample_count: usize,
}

#[bridge::export]
pub fn sample_curve_rate_series(
    SampleCurveRatesOptions { curve, sample_count }: SampleCurveRatesOptions,
) -> CurveRateSamples {
    CurveRateSamples {
        rates: sample_curve_rates(&curve, sample_count),
    }
}

// Bridge surface.

#[bridge::export]
pub const MAX_CURVE_POINTS_VALUE: usize = MAX_CURVE_POINTS;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RetimeOptions {
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
}

#[bridge::export]
pub fn get_retime_curve_of(RetimeOptions { retime }: RetimeOptions) -> Option<RetimeCurve> {
    retime_curve(retime.as_ref()).cloned()
}

#[bridge::export]
pub fn has_retime_curve(RetimeOptions { retime }: RetimeOptions) -> bool {
    retime_curve(retime.as_ref()).is_some()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CurveOptions {
    pub curve: RetimeCurve,
}

#[bridge::export]
pub fn sanitize_curve(CurveOptions { curve }: CurveOptions) -> RetimeCurve {
    sanitize_retime_curve(&curve)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CurveRateAtPositionOptions {
    pub curve: RetimeCurve,
    pub position: f64,
}

#[bridge::export]
pub fn get_curve_rate_at_position(
    CurveRateAtPositionOptions { curve, position }: CurveRateAtPositionOptions,
) -> f64 {
    curve_rate_at_position(&curve, position)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SliceCurveOptions {
    pub curve: RetimeCurve,
    pub from_fraction: f64,
    pub to_fraction: f64,
}

#[bridge::export]
pub fn slice_curve(
    SliceCurveOptions {
        curve,
        from_fraction,
        to_fraction,
    }: SliceCurveOptions,
) -> RetimeCurve {
    slice_retime_curve(&curve, from_fraction, to_fraction)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScaleCurveOptions {
    pub curve: RetimeCurve,
    pub factor: f64,
}

#[bridge::export]
pub fn scale_curve_rates(ScaleCurveOptions { curve, factor }: ScaleCurveOptions) -> RetimeCurve {
    scale_retime_curve_rates(&curve, factor)
}
