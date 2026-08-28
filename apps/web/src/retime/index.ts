/**
 * Speed curves live in `editor-core::retime`; this re-exports them so call
 * sites keep the `@/retime` path they already use.
 *
 * `audio-stretch` stays in TypeScript — it drives `soundtouchjs` over a live
 * `AudioBuffer`, which is a browser object rather than data.
 */
export * from "@/wasm/retime";
export * from "./audio-stretch";
