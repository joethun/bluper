export const MANAGER_KEYS = [
	"playback",
	"timeline",
	"scenes",
	"project",
	"media",
	"renderer",
	"selection",
	"clipboard",
	"diagnostics",
] as const;

export type ManagerKey = (typeof MANAGER_KEYS)[number];
