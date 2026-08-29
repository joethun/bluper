import { describe, expect, it, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const { ProjectManager } = await import("@/core/managers/project-manager");
import type { EditorCore } from "@/core";
import type { TProjectMetadata } from "@/project/types";

function metadata({ name }: { name: string }): TProjectMetadata {
	return {
		id: `id-${name}`,
		name,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		duration: 0 as never,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

function managerWith({
	names,
}: {
	names: string[];
}): InstanceType<typeof ProjectManager> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const manager = new ProjectManager({} as EditorCore);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	(manager as unknown as { savedProjects: TProjectMetadata[] }).savedProjects =
		names.map((name) => metadata({ name }));
	return manager;
}

describe("ProjectManager.getNextDefaultProjectName", () => {
	it("starts with the bare name when nothing is taken", () => {
		const manager = managerWith({ names: ["My video", "Other"] });
		expect(manager.getNextDefaultProjectName()).toBe("Untitled Project");
	});

	it("uses the next number when the bare name is taken", () => {
		const manager = managerWith({ names: ["Untitled Project", "My video"] });
		expect(manager.getNextDefaultProjectName()).toBe("Untitled Project 2");
	});

	it("fills gaps left by deleted projects", () => {
		const manager = managerWith({
			names: ["Untitled Project", "Untitled Project 2", "Untitled Project 5"],
		});
		expect(manager.getNextDefaultProjectName()).toBe("Untitled Project 3");
	});

	it("fills gaps in the numbering", () => {
		const manager = managerWith({
			names: ["Untitled Project", "Untitled Project 3"],
		});
		expect(manager.getNextDefaultProjectName()).toBe("Untitled Project 2");
	});

	it("ignores lookalike names that aren't part of the series", () => {
		const manager = managerWith({
			names: [
				"Untitled Project",
				"Untitled Project 2",
				"My Untitled Project",
				"Untitled Project 2 copy",
			],
		});
		expect(manager.getNextDefaultProjectName()).toBe("Untitled Project 3");
	});
});
