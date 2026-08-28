//! Whether there is room for what is about to be written —
//! `apps/web/src/services/storage/quota.ts`.
//!
//! Media lives on the real filesystem, so there is no origin quota to run out
//! of — only the disk. Asking the OS is the shell's job; deciding what the
//! answer means is this module's.
//!
//! Not knowing is deliberately not the same as knowing there is no room: an
//! unavailable estimate lets the write proceed and surface a real disk error,
//! because refusing an import that would have fitted is the worse failure.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::math::display::{FormatNumberForDisplayOptions, format_number_for_display_value};

const BYTE_UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

/// Free space held back from the figure the caller is allowed to fill.
///
/// A disk with literally nothing left is a failure mode of its own — the OS
/// starts refusing writes the app never asked to make — so the last 50MB is
/// never counted as available.
#[export]
pub const STORAGE_HEADROOM_RESERVE_BYTES: f64 = 50.0 * 1024.0 * 1024.0;

/// What the filesystem has, and what the caller may use of it.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageQuotaStatus {
    /// Free bytes on the filesystem media is written to, or `null` when the OS
    /// would not say.
    pub headroom_bytes: Option<f64>,
    /// [`headroom_bytes`](Self::headroom_bytes) less the reserve.
    pub available_bytes: Option<f64>,
}

/// Why a write was allowed or refused. `EstimateUnavailable` is an allow, not
/// a refusal — the caller learns nothing about the disk and tries anyway.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StorageCapacityReason {
    EnoughSpace,
    InsufficientSpace,
    EstimateUnavailable,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageCapacityCheckResult {
    pub can_store: bool,
    pub reason: StorageCapacityReason,
    pub available_bytes: Option<f64>,
}

/// A byte count that is actually a byte count. Anything else — a negative
/// number, a NaN, a probe that answered nothing — is "unknown".
fn normalise_byte_value(value: Option<f64>) -> Option<f64> {
    value.filter(|bytes| bytes.is_finite() && *bytes >= 0.0)
}

/// The status a reported free-space figure implies.
pub fn storage_quota_from_disk_bytes(disk_bytes: Option<f64>) -> StorageQuotaStatus {
    match normalise_byte_value(disk_bytes) {
        None => StorageQuotaStatus {
            headroom_bytes: None,
            available_bytes: None,
        },
        Some(headroom_bytes) => StorageQuotaStatus {
            headroom_bytes: Some(headroom_bytes),
            available_bytes: Some((headroom_bytes - STORAGE_HEADROOM_RESERVE_BYTES).max(0.0)),
        },
    }
}

pub fn evaluate_storage_capacity(
    required_bytes: f64,
    quota_status: StorageQuotaStatus,
) -> StorageCapacityCheckResult {
    let Some(available_bytes) = quota_status.available_bytes else {
        return StorageCapacityCheckResult {
            can_store: true,
            reason: StorageCapacityReason::EstimateUnavailable,
            available_bytes: None,
        };
    };

    if required_bytes > available_bytes {
        return StorageCapacityCheckResult {
            can_store: false,
            reason: StorageCapacityReason::InsufficientSpace,
            available_bytes: Some(available_bytes),
        };
    }

    StorageCapacityCheckResult {
        can_store: true,
        reason: StorageCapacityReason::EnoughSpace,
        available_bytes: Some(available_bytes),
    }
}

/// A byte count for a person: the largest unit it fills, and one decimal place
/// only where that decimal says something.
pub fn format_storage_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 B".to_string();
    }

    let mut value = bytes;
    let mut unit_index = 0;
    while value >= 1024.0 && unit_index < BYTE_UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    // "1.2 GB" is worth the digit; "512 B" and "48 MB" are not.
    let precision = if value >= 10.0 || unit_index == 0 {
        0.0
    } else {
        1.0
    };
    format!(
        "{} {}",
        format_number_for_display_value(FormatNumberForDisplayOptions {
            value,
            fraction_digits: Some(precision),
            min_fraction_digits: 0.0,
            max_fraction_digits: 6.0,
        }),
        BYTE_UNITS[unit_index],
    )
}

/// Whether a caught error is the storage system saying it is full.
///
/// Three shapes reach this: the app's own error, the DOM's
/// `QuotaExceededError`, and Firefox's older `NS_ERROR_DOM_QUOTA_REACHED`. The
/// message sweep is the last resort for a wrapper that kept the words and lost
/// the name.
pub fn is_quota_exceeded_error(name: &str, message: &str) -> bool {
    name == "QuotaExceededError"
        || name == "NS_ERROR_DOM_QUOTA_REACHED"
        || message.to_lowercase().contains("quota")
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StorageQuotaFromDiskOptions {
    /// Absent when the shell could not read the filesystem.
    #[serde(default)]
    pub disk_bytes: Option<f64>,
}

#[export]
pub fn storage_quota_from_disk_bytes_value(
    StorageQuotaFromDiskOptions { disk_bytes }: StorageQuotaFromDiskOptions,
) -> StorageQuotaStatus {
    storage_quota_from_disk_bytes(disk_bytes)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateStorageCapacityOptions {
    pub required_bytes: f64,
    pub quota_status: StorageQuotaStatus,
}

#[export]
pub fn evaluate_storage_capacity_value(
    EvaluateStorageCapacityOptions {
        required_bytes,
        quota_status,
    }: EvaluateStorageCapacityOptions,
) -> StorageCapacityCheckResult {
    evaluate_storage_capacity(required_bytes, quota_status)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatStorageBytesOptions {
    pub bytes: f64,
}

#[export]
pub fn format_storage_bytes_value(
    FormatStorageBytesOptions { bytes }: FormatStorageBytesOptions,
) -> String {
    format_storage_bytes(bytes)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuotaErrorOptions {
    pub name: String,
    pub message: String,
}

#[export]
pub fn is_quota_exceeded_error_value(
    QuotaErrorOptions { name, message }: QuotaErrorOptions,
) -> bool {
    is_quota_exceeded_error(&name, &message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIGABYTE: f64 = 1024.0 * 1024.0 * 1024.0;

    #[test]
    fn the_reserve_comes_off_the_free_space() {
        let status = storage_quota_from_disk_bytes(Some(GIGABYTE));
        assert_eq!(status.headroom_bytes, Some(GIGABYTE));
        assert_eq!(
            status.available_bytes,
            Some(GIGABYTE - STORAGE_HEADROOM_RESERVE_BYTES),
        );
    }

    #[test]
    fn a_disk_inside_the_reserve_reports_nothing_available_rather_than_negative() {
        let status = storage_quota_from_disk_bytes(Some(1024.0));
        assert_eq!(status.available_bytes, Some(0.0));
    }

    #[test]
    fn an_unreadable_disk_is_unknown_on_both_counts() {
        for reading in [None, Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
            let status = storage_quota_from_disk_bytes(reading);
            assert_eq!(status.headroom_bytes, None, "reading {reading:?}");
            assert_eq!(status.available_bytes, None, "reading {reading:?}");
        }
    }

    #[test]
    fn a_write_that_fits_is_allowed() {
        let result = evaluate_storage_capacity(1024.0, storage_quota_from_disk_bytes(Some(GIGABYTE)));
        assert!(result.can_store);
        assert_eq!(result.reason, StorageCapacityReason::EnoughSpace);
    }

    #[test]
    fn a_write_bigger_than_what_is_left_is_refused() {
        let result =
            evaluate_storage_capacity(GIGABYTE * 2.0, storage_quota_from_disk_bytes(Some(GIGABYTE)));
        assert!(!result.can_store);
        assert_eq!(result.reason, StorageCapacityReason::InsufficientSpace);
        assert_eq!(
            result.available_bytes,
            Some(GIGABYTE - STORAGE_HEADROOM_RESERVE_BYTES),
        );
    }

    #[test]
    fn a_write_exactly_filling_what_is_left_is_allowed() {
        let status = storage_quota_from_disk_bytes(Some(GIGABYTE));
        let result = evaluate_storage_capacity(
            status.available_bytes.expect("available space"),
            status,
        );
        assert!(result.can_store);
    }

    #[test]
    fn not_knowing_lets_the_write_proceed() {
        // Refusing an import that would have fitted is worse than attempting a
        // write the filesystem then refuses with a real error.
        let result = evaluate_storage_capacity(GIGABYTE, storage_quota_from_disk_bytes(None));
        assert!(result.can_store);
        assert_eq!(result.reason, StorageCapacityReason::EstimateUnavailable);
        assert_eq!(result.available_bytes, None);
    }

    #[test]
    fn byte_counts_are_formatted_at_the_unit_they_fill() {
        assert_eq!(format_storage_bytes(0.0), "0 B");
        assert_eq!(format_storage_bytes(512.0), "512 B");
        assert_eq!(format_storage_bytes(1024.0), "1.0 KB");
        assert_eq!(format_storage_bytes(1024.0 * 1024.0 * 2.5), "2.5 MB");
        assert_eq!(format_storage_bytes(GIGABYTE * 1024.0), "1.0 TB");
    }

    #[test]
    fn the_decimal_is_dropped_once_it_stops_saying_anything() {
        // Ten and above, the tenth of a unit is noise; bytes never get one at
        // all, since a tenth of a byte does not exist.
        assert_eq!(format_storage_bytes(1024.0 * 48.0), "48 KB");
        assert_eq!(format_storage_bytes(1024.0 * 9.5), "9.5 KB");
        assert_eq!(format_storage_bytes(700.0), "700 B");
    }

    #[test]
    fn a_nonsense_size_formats_as_nothing_rather_than_nan() {
        assert_eq!(format_storage_bytes(-5.0), "0 B");
        assert_eq!(format_storage_bytes(f64::NAN), "0 B");
    }

    #[test]
    fn the_platforms_full_disk_errors_are_recognised_by_name() {
        assert!(is_quota_exceeded_error("QuotaExceededError", ""));
        assert!(is_quota_exceeded_error("NS_ERROR_DOM_QUOTA_REACHED", ""));
        assert!(!is_quota_exceeded_error("TypeError", "not a function"));
    }

    #[test]
    fn a_wrapper_that_kept_the_words_is_still_recognised() {
        assert!(is_quota_exceeded_error(
            "Error",
            "The QUOTA was exceeded while writing",
        ));
        assert!(is_quota_exceeded_error("Error", "storage quota reached"));
    }
}
