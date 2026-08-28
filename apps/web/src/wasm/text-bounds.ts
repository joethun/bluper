import {
	MAX_FONT_SIZE as _MAX_FONT_SIZE,
	MIN_FONT_SIZE as _MIN_FONT_SIZE,
} from "bluper-wasm";

/**
 * Font-size bounds the panel will accept, now owned by
 * `editor-core::text::layout`.
 *
 * `FONT_SIZE_SCALE_REFERENCE` already lived in Rust (see
 * `wasm/text-layout.ts`); this adds the panel's lower/upper bounds so the
 * mask definitions and the canvas reject the same inputs.
 */
export const MIN_FONT_SIZE = _MIN_FONT_SIZE();
export const MAX_FONT_SIZE = _MAX_FONT_SIZE();
