import { transitionsRegistry } from "@/transitions/registry";
import { BASIC_TRANSITIONS } from "./basic";
import { CAMERA_TRANSITIONS } from "./camera";
import { MOTION_TRANSITIONS } from "./motion";
import { WIPE_TRANSITIONS } from "./wipe";

export function registerDefaultTransitions(): void {
	for (const definition of [
		...BASIC_TRANSITIONS,
		...WIPE_TRANSITIONS,
		...MOTION_TRANSITIONS,
		...CAMERA_TRANSITIONS,
	]) {
		transitionsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
