import { Editor } from "./editor";

/**
 * No projects are pre-rendered — every editor session is opened by its UUID
 * from the projects list, and the actual page reads `useParams()` on the
 * client. Next requires at least one entry from `generateStaticParams` when
 * `output: "export"` is in effect, so we generate a single placeholder shell
 * that hydrates client-side with the real `project_id` from the URL. Lives in
 * this server component because App Router forbids `generateStaticParams`
 * from a `"use client"` file.
 */
export function generateStaticParams() {
	return [{ project_id: "_" }];
}

export default function EditorPage() {
	return <Editor />;
}