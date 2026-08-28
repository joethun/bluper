//! Held stills: where a clip shows the frame pinned at a particular source time
//! rather than continuing to walk the source.

mod sample;

pub use sample::{
    ResolveSampledSourceTimeOptions, resolve_sampled_source_time,
};
