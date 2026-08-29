import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { tauriOpenMediaFiles } from "@/lib/tauri-runtime";
import { MEDIA_FILE_EXTENSIONS } from "@/wasm/file-types";
import {
	type NativeDropPoint,
	registerNativeDropTarget,
} from "@/media/native-drop";

interface UseFileUploadOptions {
	/** Somewhere media can be dropped. Attach `dropRef` to it. */
	onPathsSelected?: (args: { paths: string[] } & Partial<NativeDropPoint>) => void;
}

/**
 * Picking and dropping media, both of which yield paths.
 *
 * There is no `<input type="file">` here any more. The OS dialog reports where
 * the files are, an input reports only their bytes, and the difference decides
 * whether the import can reference the user's footage or has to copy it.
 */
export function useFileUpload({ onPathsSelected }: UseFileUploadOptions = {}) {
	const editor = useEditor();
	const [isDragOver, setIsDragOver] = useState(false);
	const dropRef = useRef<HTMLDivElement>(null);

	// Read through a ref so registering the drop target doesn't depend on the
	// identity of a callback the caller redefines every render.
	const handlerRef = useRef(onPathsSelected);
	useEffect(() => {
		handlerRef.current = onPathsSelected;
	});

	useEffect(() => {
		return registerNativeDropTarget({
			element: () => dropRef.current,
			onOver: ({ isOver }) => {
				// A drag that started on the timeline is carrying a clip, not
				// files, and the panel should not offer to import it.
				if (isOver && editor.timeline.dragSource.isActive()) return;
				setIsDragOver(isOver);
			},
			onPaths: ({ paths, clientX, clientY }) => {
				setIsDragOver(false);
				handlerRef.current?.({ paths, clientX, clientY });
			},
		});
	}, [editor]);

	async function openFilePicker() {
		const paths = await tauriOpenMediaFiles({
			title: "Import media",
			extensions: MEDIA_FILE_EXTENSIONS,
		});
		if (paths.length > 0) handlerRef.current?.({ paths });
	}

	return { isDragOver, openFilePicker, dropRef };
}
