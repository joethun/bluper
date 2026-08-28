import type { NextConfig } from "next";

/**
 * The app has one build: a static export the Tauri shell loads from its own
 * origin (`apps/desktop/src-tauri/tauri.conf.json` points `frontendDist` at
 * `out/`). There is no server behind it, so nothing here may rely on one —
 * no rewrites, no redirects, no image optimizer, no route handlers.
 *
 * `next dev` serves the same routes for the shell's `devUrl`.
 */
const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "export",
	images: {
		// No optimizer without a server. `next/image` then passes `src` straight
		// through, which is also why the remote platform logos in
		// `guides/definitions/platforms.tsx` need no `remotePatterns` entry.
		unoptimized: true,
	},
	// Every page is a directory with an `index.html`, so a path has to keep its
	// trailing slash to resolve off the filesystem.
	trailingSlash: true,
};

export default nextConfig;
