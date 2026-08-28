//! Effect-side helpers: the per-frame numerics that the canvas drawing layer
//! calls. Drawing itself stays TypeScript — the canvas context is a browser
//! API and nothing here would buy anything by crossing the bridge with it.

use bridge::export;
use serde::Deserialize;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UnitSizeOptions {
    pub width: f64,
    pub height: f64,
}

/// One "unit" of visual distance. Blur radii and offsets are written in units
/// so an effect looks the same on a 720p clip and a 4K one instead of turning
/// into a hairline on the larger frame.
#[export]
pub fn unit_size(UnitSizeOptions { width, height }: UnitSizeOptions) -> f64 {
    width.min(height) / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_smaller_dimension() {
        assert_eq!(
            unit_size(UnitSizeOptions {
                width: 1920.0,
                height: 1080.0,
            }),
            1.08
        );
    }

    #[test]
    fn divides_by_a_thousand() {
        assert_eq!(
            unit_size(UnitSizeOptions {
                width: 500.0,
                height: 1000.0,
            }),
            0.5
        );
    }
}
