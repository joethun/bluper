import type { Metadata } from "next";
import { SITE_INFO } from "@/site/brand";

/**
 * The window's document metadata.
 *
 * Only what the shell itself renders is left. Canonical URLs, Open Graph,
 * Twitter cards, `robots`, and the PWA manifest went with the hosted build:
 * behind a `tauri://` origin there is no crawler to read them and no share
 * preview to generate.
 */
export const baseMetaData: Metadata = {
	title: SITE_INFO.title,
	description: SITE_INFO.description,
	icons: {
		icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
		shortcut: ["/favicon.svg"],
	},
};
