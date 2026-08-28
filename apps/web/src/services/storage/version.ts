/**
 * Every project is stamped with this when it is saved. There is only ever one
 * storage version: Bluper has no users, so the migration history that Opencut
 * carried across the fork is gone.
 *
 * Defined in `rust/crates/editor-core/src/project.rs` and re-exported here so
 * the writer and the validator cannot disagree about what they stamp and check.
 */
export { CURRENT_PROJECT_VERSION } from "@/wasm";
