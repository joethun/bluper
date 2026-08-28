//! Storage accounting — how much room is left, and whether a write fits.

mod quota;

pub use quota::{
    EvaluateStorageCapacityOptions, FormatStorageBytesOptions, QuotaErrorOptions,
    STORAGE_HEADROOM_RESERVE_BYTES, StorageCapacityCheckResult, StorageCapacityReason,
    StorageQuotaFromDiskOptions, StorageQuotaStatus, evaluate_storage_capacity,
    evaluate_storage_capacity_value, format_storage_bytes, format_storage_bytes_value,
    is_quota_exceeded_error, is_quota_exceeded_error_value, storage_quota_from_disk_bytes,
    storage_quota_from_disk_bytes_value,
};
