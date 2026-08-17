import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
	addCustomFont,
	type CustomFont,
	getCustomFontsSnapshot,
	loadCustomFonts,
	removeCustomFont,
	subscribeToCustomFonts,
} from "@/fonts/custom-fonts";

export function useCustomFonts() {
	const fonts = useSyncExternalStore(
		subscribeToCustomFonts,
		getCustomFontsSnapshot,
		() => [] as CustomFont[],
	);
	const [error, setError] = useState<string | null>(null);
	const [isUploading, setIsUploading] = useState(false);

	useEffect(() => {
		loadCustomFonts();
	}, []);

	const upload = useCallback(async ({ files }: { files: File[] }) => {
		setIsUploading(true);
		setError(null);
		const failures: string[] = [];

		for (const file of files) {
			try {
				await addCustomFont({ file });
			} catch (cause) {
				failures.push(
					cause instanceof Error ? cause.message : `Could not add ${file.name}.`,
				);
			}
		}

		setIsUploading(false);
		setError(failures.length > 0 ? failures.join(" ") : null);
	}, []);

	const remove = useCallback(async ({ id }: { id: string }) => {
		setError(null);
		await removeCustomFont({ id });
	}, []);

	const dismissError = useCallback(() => setError(null), []);

	return { fonts, upload, remove, error, dismissError, isUploading };
}
