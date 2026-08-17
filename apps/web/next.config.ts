import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const isStaticExport = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: isStaticExport ? "export" : "standalone",
	// Projects moved to the root, so keep existing /projects links working.
	async redirects() {
		return [
			{
				source: "/projects",
				destination: "/",
				permanent: true,
			},
		];
	},
	images: {
		...(isStaticExport && { unoptimized: true }),
		// Only the platform logos in `guides/definitions/platforms.tsx` load from
		// anywhere but this origin.
		remotePatterns: [
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
	trailingSlash: isStaticExport,
};

export default withBotId(nextConfig);
