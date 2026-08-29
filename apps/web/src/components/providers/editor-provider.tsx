"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditorActions } from "@/actions/use-editor-actions";
import { loadFontAtlas } from "@/fonts/google-fonts";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";
import {
	editorHref,
	isEditorPathname,
	readEditorProjectIdFromLocation,
} from "@/project/editor-route";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { setLoadingProject } = useKeybindingsStore();

	/**
	 * The id to open, read from the URL rather than from the `projectId` prop.
	 *
	 * `null` until an effect has looked, which is the distinction the loader
	 * below turns on: the prop is computed during render, and the router does not
	 * write the URL the desktop shell keeps the id in until the commit that
	 * mounts this page — so the first render reports no id whether or not the URL
	 * has one. `null` means "not looked yet"; `""` means the URL genuinely has no
	 * project in it.
	 *
	 * Resolving into state also keeps the load from running twice on the way in.
	 * The prop settles a render *after* the URL does, and re-running the loader
	 * for a value it already loaded would put two full loads of the same project
	 * in flight at once, interleaving their writes to the same editor state.
	 */
	const [urlProjectId, setUrlProjectId] = useState<string | null>(null);

	useEffect(() => {
		// The cascading render this rule warns about is the point: the URL is an
		// external system that settles after the render which reads it, and this
		// is the one place allowed to look. `useSearchParams()` would subscribe
		// properly but opts the editor out of static generation — see
		// `editor-route.ts`. Setting the same id twice is a no-op, so this
		// converges after one extra render rather than cascading.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setUrlProjectId(readEditorProjectIdFromLocation());
	}, [projectId]);

	useEffect(() => {
		setLoadingProject(isLoading);
	}, [isLoading, setLoadingProject]);

	useEffect(() => {
		let cancelled = false;
		const editor = EditorCore.getInstance();

		const loadProject = async (id: string) => {
			try {
				setIsLoading(true);
				await initializeGpuRenderer();
				editor.renderer.setDegraded(!isGpuAvailable());
				await editor.project.loadProject({ id });

				if (cancelled) return;

				setIsLoading(false);
				loadFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					try {
						const newProjectId = await editor.project.createNewProject({
							name: editor.project.getNextDefaultProjectName(),
						});
						if (cancelled) return;
						// Point the URL at the replacement, then load it here rather
						// than waiting for the navigation to bring us back around.
						// In the static export the id lives in the query string, and
						// changing only the query doesn't re-run this effect — the
						// editor would sit on its spinner forever.
						router.replace(editorHref({ projectId: newProjectId }));
						await loadProject(newProjectId);
					} catch (_createErr) {
						setError("Failed to create project");
						setIsLoading(false);
					}
				} else {
					const wasmPanic = (window as Window & { __wasmPanic?: string })
						.__wasmPanic;
					if (wasmPanic) {
						delete (window as Window & { __wasmPanic?: string }).__wasmPanic;
						setError(wasmPanic);
					} else {
						setError(
							err instanceof Error ? err.message : "Failed to load project",
						);
					}
					setIsLoading(false);
				}
			}
		};

		// Nothing to do until the URL has been read.
		if (urlProjectId === null) return;

		// An id-less URL is not a project to load, and must never reach the
		// recovery above: `loadProject("")` fails as not-found, which would answer
		// by creating a project. That is where the stray "Untitled Project" came
		// from — entering one left an orphan behind, because the create outlived
		// the effect that started it.
		if (urlProjectId === "") {
			// Still on /editor means the URL itself carries no project — a deep
			// link into the export's shell page, which has nothing to open — as
			// opposed to a navigation that has already left for somewhere else.
			if (isEditorPathname()) router.replace("/");
			return;
		}

		loadProject(urlProjectId);

		return () => {
			cancelled = true;
		};
	}, [urlProjectId, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2Icon className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2Icon className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const rippleEditingEnabled = useTimelineStore(
		(state) => state.rippleEditingEnabled,
	);

	useEffect(() => {
		editor.command.isRippleEnabled = rippleEditingEnabled;
	}, [editor, rippleEditingEnabled]);

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor]);

	useEditorActions();
	useKeybindingsListener();
	return null;
}
