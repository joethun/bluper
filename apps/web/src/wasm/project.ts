import {
	CURRENT_PROJECT_VERSION as _CURRENT_PROJECT_VERSION,
	validateProjectEnvelope as _validateProjectEnvelope,
	type ProjectDefect,
} from "bluper-wasm";


/**
 * Mirrors `CURRENT_PROJECT_VERSION` in `rust/crates/editor-core/src/project.rs`,
 * which is the only place it is defined. `#[export]` on a const emits a getter,
 * so this is a call resolved once at module load rather than a literal to keep
 * in step by hand.
 */
export const CURRENT_PROJECT_VERSION = _CURRENT_PROJECT_VERSION();

/**
 * Three outcomes, not two. "We read the project and it is wrong" and "we could
 * not read the project at all" need different handling — the first can name what
 * to fix, the second only has the boundary's own complaint — and collapsing them
 * loses that. `unreadable` is raised here rather than in Rust: it means the blob
 * did not deserialise into the validator's view, so the validator never ran.
 */
export type ProjectValidationOutcome =
	| { status: "ok"; tolerated: ProjectDefect[] }
	| { status: "defective"; fatal: ProjectDefect[]; tolerated: ProjectDefect[] }
	| { status: "unreadable"; message: string };

/**
 * Check a project read back out of storage before letting it into the editor.
 *
 * The argument is `unknown` on purpose: this exists to be pointed at untrusted
 * data straight off disk, and a caller that already had a well-typed project
 * would have nothing to check.
 */
export function validateProjectEnvelope({
	project,
}: {
	project: unknown;
}): ProjectValidationOutcome {
	let fatal: ProjectDefect[];
	let tolerated: ProjectDefect[];
	try {
		const validation = _validateProjectEnvelope({
			// Crossing from `unknown` into the generated view type is the whole
			// point: every field on it is optional, so a blob that is merely
			// wrong comes back as defects. One that is not an object at all
			// throws, and the catch below turns that into `unreadable`.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			project: project as Parameters<
				typeof _validateProjectEnvelope
			>[0]["project"],
		});
		fatal = validation.fatal;
		tolerated = validation.tolerated;
	} catch (error) {
		return {
			status: "unreadable",
			message: error instanceof Error ? error.message : String(error),
		};
	}

	if (fatal.length === 0) return { status: "ok", tolerated };
	return { status: "defective", fatal, tolerated };
}

/**
 * A one-line description of a defect, for logs and for telling a user why their
 * project would not open. Exhaustive over the union on purpose: adding a variant
 * in Rust regenerates the type and breaks this switch, which is the reminder to
 * write the sentence.
 */
function describeProjectDefect({
	defect,
}: {
	defect: ProjectDefect;
}): string {
	switch (defect.kind) {
		case "unsupportedVersion":
			return `project version ${defect.found ?? "missing"} is not version ${defect.expected}`;
		case "missingMetadata":
			return "project has no metadata";
		case "missingProjectId":
			return "project has no id";
		case "missingSettings":
			return "project has no settings";
		case "missingFrameRate":
			return "project settings have no frame rate";
		case "invalidFrameRate":
			return `frame rate ${defect.numerator}/${defect.denominator} is not a rate`;
		case "unrepresentableFrameRate":
			return `frame rate ${defect.numerator}/${defect.denominator} has no exact frame boundaries`;
		case "missingCanvasSize":
			return "project settings have no canvas size";
		case "invalidCanvasSize":
			return `canvas size ${defect.width}x${defect.height} is not usable`;
		case "missingBackground":
			return "project settings have no background";
		case "negativeDuration":
			return `project duration is negative (${defect.ticks} ticks)`;
		case "noScenes":
			return "project has no scenes";
		case "sceneMissingId":
			return `scene at index ${defect.index} has no id`;
		case "duplicateSceneId":
			return `more than one scene has the id "${defect.id}"`;
		case "noMainScene":
			return "no scene is marked as the main one";
		case "multipleMainScenes":
			return `${defect.count} scenes are marked as the main one`;
		case "currentSceneMissing":
			return `the selected scene "${defect.id}" is not in the project`;
		case "negativeBookmarkTime":
			return `scene "${defect.sceneId}" has a bookmark at a negative time (${defect.ticks} ticks)`;
	}
}

function describeDefects({ defects }: { defects: ProjectDefect[] }): string {
	return defects.map((defect) => describeProjectDefect({ defect })).join("; ");
}

/** All of a project's defects as one line, for a log or a toast. */
export function describeProjectValidation({
	outcome,
}: {
	outcome: ProjectValidationOutcome;
}): string {
	switch (outcome.status) {
		case "unreadable":
			return `project could not be read: ${outcome.message}`;
		case "ok":
			return outcome.tolerated.length === 0
				? "project is loadable"
				: `project is loadable, with: ${describeDefects({
						defects: outcome.tolerated,
					})}`;
		case "defective":
			return describeDefects({
				defects: [...outcome.fatal, ...outcome.tolerated],
			});
	}
}
