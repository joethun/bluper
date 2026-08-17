import { formatNumberForDisplay } from "@/utils/math";
import { tauriAvailable, tauriAvailableDiskBytes } from "@/lib/tauri-runtime";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

const STORAGE_HEADROOM_RESERVE_BYTES = 50 * 1024 * 1024;

export interface StorageQuotaStatus {
	quotaBytes: number | null;
	usageBytes: number | null;
	headroomBytes: number | null;
	availableBytes: number | null;
}

export interface StorageCapacityCheckResult {
	canStore: boolean;
	reason: "enough-space" | "insufficient-space" | "estimate-unavailable";
	availableBytes: number | null;
}

function normalizeByteValue({ value }: { value: unknown }): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}

	return value;
}

export function formatStorageBytes({ bytes }: { bytes: number }): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}

	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
	return `${formatNumberForDisplay({ value, fractionDigits: precision })} ${BYTE_UNITS[unitIndex]}`;
}

export async function readStorageQuotaStatus(): Promise<StorageQuotaStatus> {
	// On the desktop build media lives on the real filesystem, so there is no
	// origin quota to run out of — only the disk. `navigator.storage.estimate`
	// would report the WebView's own sandbox quota, which is both much smaller
	// and unrelated to where the files actually go, and would reject imports
	// that fit on disk perfectly well. Ask the OS instead.
	if (tauriAvailable()) {
		try {
			const freeBytes = await tauriAvailableDiskBytes();
			const headroomBytes = normalizeByteValue({ value: freeBytes });
			if (headroomBytes === null) {
				return {
					quotaBytes: null,
					usageBytes: null,
					headroomBytes: null,
					availableBytes: null,
				};
			}
			return {
				quotaBytes: null,
				usageBytes: null,
				headroomBytes,
				availableBytes: Math.max(
					headroomBytes - STORAGE_HEADROOM_RESERVE_BYTES,
					0,
				),
			};
		} catch {
			// Not knowing is better than guessing low: fall through to
			// "unavailable", which lets the write attempt proceed and surface a
			// real disk error if it fails.
			return {
				quotaBytes: null,
				usageBytes: null,
				headroomBytes: null,
				availableBytes: null,
			};
		}
	}

	if (
		typeof navigator === "undefined" ||
		!navigator.storage ||
		typeof navigator.storage.estimate !== "function"
	) {
		return {
			quotaBytes: null,
			usageBytes: null,
			headroomBytes: null,
			availableBytes: null,
		};
	}

	const estimate = await navigator.storage.estimate();
	const quotaBytes = normalizeByteValue({ value: estimate.quota });
	const usageBytes = normalizeByteValue({ value: estimate.usage });

	if (quotaBytes === null || usageBytes === null) {
		return {
			quotaBytes,
			usageBytes,
			headroomBytes: null,
			availableBytes: null,
		};
	}

	const headroomBytes = Math.max(quotaBytes - usageBytes, 0);
	const availableBytes = Math.max(
		headroomBytes - STORAGE_HEADROOM_RESERVE_BYTES,
		0,
	);

	return {
		quotaBytes,
		usageBytes,
		headroomBytes,
		availableBytes,
	};
}

export function evaluateStorageCapacity({
	requiredBytes,
	quotaStatus,
}: {
	requiredBytes: number;
	quotaStatus: StorageQuotaStatus;
}): StorageCapacityCheckResult {
	if (quotaStatus.availableBytes === null) {
		return {
			canStore: true,
			reason: "estimate-unavailable",
			availableBytes: null,
		};
	}

	if (requiredBytes > quotaStatus.availableBytes) {
		return {
			canStore: false,
			reason: "insufficient-space",
			availableBytes: quotaStatus.availableBytes,
		};
	}

	return {
		canStore: true,
		reason: "enough-space",
		availableBytes: quotaStatus.availableBytes,
	};
}

export class StorageQuotaExceededError extends Error {
	requiredBytes: number;

	constructor({ requiredBytes }: { requiredBytes: number }) {
		super(
			`Not enough storage to save a ${formatStorageBytes({ bytes: requiredBytes })} file.`,
		);

		this.name = "StorageQuotaExceededError";
		this.requiredBytes = requiredBytes;
	}
}

export function isStorageQuotaExceededError({
	error,
}: {
	error: unknown;
}): boolean {
	if (error instanceof StorageQuotaExceededError) {
		return true;
	}

	if (!(error instanceof Error)) {
		return false;
	}

	return (
		error.name === "QuotaExceededError" ||
		error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
		error.message.toLowerCase().includes("quota")
	);
}
