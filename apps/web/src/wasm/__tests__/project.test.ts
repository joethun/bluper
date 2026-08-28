import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

// The façade under test reaches the raw package; point it at the nodejs-target
// build of the same crate so the real validator runs. See AGENTS.md.
mock.module("bluper-wasm", () => wasmNative);

const {
	CURRENT_PROJECT_VERSION,
	describeProjectValidation,
	validateProjectEnvelope,
} = await import("@/wasm/project");

const { CURRENT_PROJECT_VERSION: STORAGE_VERSION } =
	await import("@/services/storage/version");

/**
 * These are the cross-boundary agreement tests. The Rust validator names the
 * fields it reads (`canvasSize`, `isMain`, `currentSceneId`, …) through serde's
 * `rename_all`, and TypeScript names them in `SerializedProject`. Nothing forces
 * those two lists to match — that exact mismatch is the bug recorded in
 * `rust/crates/compositor/src/frame.rs`, where a renamed variant kept
 * snake_case fields and took every effect layer down.
 *
 * `buildStoredProject` is typed as the storage layer's own shape, so `tsc`
 * pins the TypeScript half and the assertions pin the Rust half.
 */

type StoredProject = ReturnType<typeof buildStoredProject>;

function buildStoredProject() {
	return {
		metadata: {
			id: "project-1",
			name: "Untitled",
			duration: 120_000,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
		scenes: [
			{
				id: "scene-1",
				name: "Main",
				isMain: true,
				tracks: {
					overlay: [],
					main: {
						id: "track-1",
						name: "Main",
						type: "video",
						elements: [],
						muted: false,
						hidden: false,
					},
					audio: [],
				},
				bookmarks: [{ time: 60_000 }],
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		],
		currentSceneId: "scene-1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: CURRENT_PROJECT_VERSION,
	};
}

/** A stored project with one thing wrong with it. */
function corrupt(mutate: (project: StoredProject) => void): unknown {
	const project = buildStoredProject();
	mutate(project);
	return project;
}

test("the version constant is Rust's, and storage re-exports the same one", () => {
	expect(CURRENT_PROJECT_VERSION).toBe(1);
	expect(STORAGE_VERSION).toBe(CURRENT_PROJECT_VERSION);
});

test("a project shaped the way storage writes it is accepted", () => {
	// If Rust and TypeScript disagreed on any field name, this would come back
	// `defective` naming the field Rust could not find.
	const outcome = validateProjectEnvelope({ project: buildStoredProject() });
	expect(outcome).toEqual({ status: "ok", tolerated: [] });
});

test("the element tree is passed over, not parsed", () => {
	// `tracks` is not typed in Rust yet. A shape it knows nothing about must not
	// make an otherwise-valid project unloadable.
	const outcome = validateProjectEnvelope({
		project: corrupt((project) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			(project.scenes[0] as unknown as Record<string, unknown>).tracks = {
				somethingRustHasNeverHeardOf: [1, 2, { nested: true }],
			};
		}),
	});
	expect(outcome).toEqual({ status: "ok", tolerated: [] });
});

test("a version from another build is rejected with what was found", () => {
	const outcome = validateProjectEnvelope({
		project: corrupt((project) => {
			project.version = 7;
		}),
	});
	expect(outcome).toEqual({
		status: "defective",
		fatal: [{ kind: "unsupportedVersion", found: 7, expected: 1 }],
		tolerated: [],
	});
});

test("settings that would break the renderer are caught at load", () => {
	const missingSettings = validateProjectEnvelope({
		project: corrupt((project) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			delete (project as unknown as Record<string, unknown>).settings;
		}),
	});
	expect(missingSettings).toEqual({
		status: "defective",
		fatal: [{ kind: "missingSettings" }],
		tolerated: [],
	});

	const zeroRate = validateProjectEnvelope({
		project: corrupt((project) => {
			project.settings.fps = { numerator: 0, denominator: 1 };
		}),
	});
	expect(zeroRate).toEqual({
		status: "defective",
		fatal: [{ kind: "invalidFrameRate", numerator: 0, denominator: 1 }],
		tolerated: [],
	});

	const oddCanvas = validateProjectEnvelope({
		project: corrupt((project) => {
			project.settings.canvasSize = { width: 0, height: 1080 };
		}),
	});
	expect(oddCanvas).toEqual({
		status: "defective",
		fatal: [{ kind: "invalidCanvasSize", width: 0, height: 1080 }],
		tolerated: [],
	});
});

test("scene problems the editor repairs are reported but not fatal", () => {
	// `ScenesManager.initializeScenes` falls back to the main scene when
	// `currentSceneId` names nothing, and `ensureMainScene` prepends one when no
	// scene is marked. Refusing the project here would lose one the editor fixes.
	const dangling = validateProjectEnvelope({
		project: corrupt((project) => {
			project.currentSceneId = "scene-that-was-deleted";
		}),
	});
	expect(dangling).toEqual({
		status: "ok",
		tolerated: [{ kind: "currentSceneMissing", id: "scene-that-was-deleted" }],
	});

	const noMain = validateProjectEnvelope({
		project: corrupt((project) => {
			project.scenes[0].isMain = false;
		}),
	});
	expect(noMain.status).toBe("ok");
});

test("something that is not a project at all is unreadable, not defective", () => {
	const outcome = validateProjectEnvelope({ project: "not a project" });
	expect(outcome.status).toBe("unreadable");
});

test("every outcome renders to a line worth logging", () => {
	expect(
		describeProjectValidation({ outcome: { status: "ok", tolerated: [] } }),
	).toBe("project is loadable");

	expect(
		describeProjectValidation({
			outcome: validateProjectEnvelope({
				project: corrupt((project) => {
					project.currentSceneId = "gone";
				}),
			}),
		}),
	).toBe(
		'project is loadable, with: the selected scene "gone" is not in the project',
	);

	expect(
		describeProjectValidation({
			outcome: validateProjectEnvelope({
				project: corrupt((project) => {
					project.version = 7;
					project.currentSceneId = "gone";
				}),
			}),
		}),
	).toBe(
		'project version 7 is not version 1; the selected scene "gone" is not in the project',
	);
});
