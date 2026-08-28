import {
	getLinePosFromDbValue as _getLinePosFromDbValue,
	getDbFromLinePosValue as _getDbFromLinePosValue,
	getBarFractionFromOutputAmplitudeValue as _getBarFractionFromOutputAmplitudeValue,
} from "bluper-wasm";

/**
 * Audio waveform display math. Owned by `editor-core::timeline::audio_display`.
 *
 * Volume dB constants (`VOLUME_DB_MIN`, `VOLUME_DB_MAX`) still live in
 * `apps/web/src/timeline/audio-constants.ts`; the Rust module reuses the same
 * values from `editor-core::params::defaults`. Once that TS file is ported the
 * façade will read through it instead of the local constant.
 */

export function getLinePosFromDb({ db }: { db: number }): number {
	return _getLinePosFromDbValue({ db });
}

export function getDbFromLinePos({ percent }: { percent: number }): number {
	return _getDbFromLinePosValue({ percent });
}

export function getBarFractionFromOutputAmplitude({
	outputAmplitude,
}: {
	outputAmplitude: number;
}): number {
	return _getBarFractionFromOutputAmplitudeValue({ outputAmplitude });
}
