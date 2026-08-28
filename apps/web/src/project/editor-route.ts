/**
 * Where the editor lives, and how it finds out which project it's editing.
 *
 * `/editor/<uuid>` is what the URL should look like, and the static export
 * can't have it: a project id is a runtime UUID, and `output: "export"` only
 * emits pages for the params `generateStaticParams` knows at build time. That's
 * not just a deep-link problem — the App Router fetches an RSC payload for
 * *every* navigation, including a click from the projects list, so a route with
 * no prerendered page can't be reached at all.
 *
 * So the app ships one shell page and carries the id in the query string.
 * Everything routes through {@link editorHref} and {@link readEditorProjectId}.
 */

/**
 * The single `project_id` the export prerenders. Seeing it as the route param
 * means the real id is in the query string.
 */
const EDITOR_SHELL_SEGMENT = "_";

const PROJECT_QUERY_PARAM = "project";

const EDITOR_PATH_PREFIX = "/editor";

export function editorHref({ projectId }: { projectId: string }): string {
	return `${EDITOR_PATH_PREFIX}/${EDITOR_SHELL_SEGMENT}/?${PROJECT_QUERY_PARAM}=${encodeURIComponent(projectId)}`;
}

/**
 * Whether the URL points at the editor.
 *
 * Matches on a path boundary, so `/editorial` is not the editor.
 */
export function isEditorPathname(): boolean {
	if (typeof window === "undefined") return false;
	const { pathname } = window.location;
	return (
		pathname === EDITOR_PATH_PREFIX ||
		pathname.startsWith(`${EDITOR_PATH_PREFIX}/`)
	);
}

/**
 * Resolves the project being edited from the URL alone — for callers that run
 * *after* a navigation has settled rather than during a render.
 *
 * Next writes the browser URL from a `useInsertionEffect`, which flushes during
 * the commit that mounts this page — after the render that reads props. So a
 * render on the way into the editor still sees the *previous* page's URL, and
 * {@link readEditorProjectId} reports no id for it: the shell's query string is
 * not there yet. An effect runs later in that same commit, by which point the
 * URL is authoritative, which makes it the only safe place to conclude that a
 * URL carries no project at all.
 *
 * Reads `window.location` rather than `useSearchParams()` for the reason given
 * on {@link readEditorProjectId}.
 */
export function readEditorProjectIdFromLocation(): string {
	if (!isEditorPathname()) return "";

	const { pathname, search } = window.location;
	// "/editor/abc/" -> "abc", "/editor/_/" -> "_", "/editor" -> ""
	const segment =
		pathname.slice(EDITOR_PATH_PREFIX.length + 1).split("/")[0] ?? "";
	if (segment && segment !== EDITOR_SHELL_SEGMENT) return segment;

	return new URLSearchParams(search).get(PROJECT_QUERY_PARAM) ?? "";
}

/**
 * Resolves the project being edited from the route param, falling back to the
 * query string when the param is the export's placeholder.
 *
 * Reads `window.location` rather than `useSearchParams()` on purpose: that hook
 * forces a Suspense boundary during prerendering and would opt the whole editor
 * out of static generation, and this only ever runs on the client anyway.
 */
export function readEditorProjectId({
	routeParam,
}: {
	routeParam: string | undefined;
}): string {
	if (routeParam && routeParam !== EDITOR_SHELL_SEGMENT) return routeParam;
	if (typeof window === "undefined") return "";
	return (
		new URLSearchParams(window.location.search).get(PROJECT_QUERY_PARAM) ?? ""
	);
}
