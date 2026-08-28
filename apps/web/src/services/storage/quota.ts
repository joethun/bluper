import {
	evaluateStorageCapacityValue as _evaluateStorageCapacityValue,
	formatStorageBytesValue as _formatStorageBytesValue,
	isQuotaExceededErrorValue as _isQuotaExceededErrorValue,
	storageQuotaFromDiskBytesValue as _storageQuotaFromDiskBytesValue,
	type StorageQuotaStatus as WasmStorageQuotaStatus,
} from "bluper-wasm";
import { tauriAvailableDiskBytes } from "@/lib/tauri-runtime";

/**
 * Whether there is room for what is about to be written. Owned by
 * `editor-core::storage::quota`.
 *
 * Reading the figure is the shell's job and stays here; what the figure means
 * is Rust's. `StorageQuotaExceededError` also stays: it is an `Error`
 * subclass, which is a JavaScript object with a prototype chain the callers
 * test with `instanceof`.
 *
 * "Unknown" is `null` on this side and `undefined` on the wire, because a Rust
 * `Option` has no null. The two are mapped here rather than at the call sites,
 * where `availableBytes !== null` is what decides whether a write is allowed to
 * proceed and `undefined` would read as a real figure.
 */

export interface StorageQuotaStatus {
	/** Free bytes on the filesystem media is written to. */
	headroomBytes: number | null;
	/** {@link headroomBytes} less the reserve, or null when the OS won't say. */
	availableBytes: number | null;
}

export interface StorageCapacityCheckResult {
	canStore: boolean;
	reason: "enough-space" | "insufficient-space" | "estimate-unavailable";
	availableBytes: number | null;
}

function toQuotaStatus(status: WasmStorageQuotaStatus): StorageQuotaStatus {
	return {
		headroomBytes: status.headroomBytes ?? null,
		availableBytes: status.availableBytes ?? null,
	};
}

export function formatStorageBytes({ bytes }: { bytes: number }): string {
	return _formatStorageBytesValue({ bytes });
}

/**
 * How much room is left where media actually goes.
 *
 * Media lives on the real filesystem, so there is no origin quota to run out
 * of — only the disk. `navigator.storage.estimate()` would report the
 * WebView's own sandbox quota, which is both much smaller and unrelated to
 * where the files go, and would reject imports that fit on disk perfectly
 * well. Ask the OS instead.
 */
export async function readStorageQuotaStatus(): Promise<StorageQuotaStatus> {
	try {
		return toQuotaStatus(
			_storageQuotaFromDiskBytesValue({
				diskBytes: (await tauriAvailableDiskBytes()) ?? undefined,
			}),
		);
	} catch {
		// Not knowing is better than guessing low: "unavailable" lets the write
		// attempt proceed and surface a real disk error if it fails.
		return toQuotaStatus(_storageQuotaFromDiskBytesValue({ diskBytes: undefined }));
	}
}

export function evaluateStorageCapacity({
	requiredBytes,
	quotaStatus,
}: {
	requiredBytes: number;
	quotaStatus: StorageQuotaStatus;
}): StorageCapacityCheckResult {
	const result = _evaluateStorageCapacityValue({
		requiredBytes,
		quotaStatus: {
			headroomBytes: quotaStatus.headroomBytes ?? undefined,
			availableBytes: quotaStatus.availableBytes ?? undefined,
		},
	});

	return {
		canStore: result.canStore,
		reason: result.reason,
		availableBytes: result.availableBytes ?? null,
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

	return _isQuotaExceededErrorValue({
		name: error.name,
		message: error.message,
	});
}
