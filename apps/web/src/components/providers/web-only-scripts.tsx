"use client";

import Script from "next/script";
import { useEffect, useState } from "react";
import { tauriAvailable } from "@/lib/tauri-runtime";

/**
 * Renders the bot-detection / analytics / dev tools that only make sense in a
 * real browser. The Tauri desktop shell has no notion of "bot" and the user
 * opted out of analytics by installing a native app, so this returns null in
 * the Tauri runtime.
 *
 * Hydration-gated: tauriAvailable() reads a window global that only exists on
 * the client, so we wait for the first effect tick before deciding.
 */
export function WebOnlyScripts({
	dataBuddyClientId,
	disabled,
}: {
	dataBuddyClientId: string;
	disabled: boolean;
}) {
	const [shouldRender, setShouldRender] = useState(false);

	useEffect(() => {
		setShouldRender(!tauriAvailable());
	}, []);

	if (!shouldRender) return null;

	return (
		<>
			<Script
				src="https://cdn.databuddy.cc/databuddy.js"
				strategy="afterInteractive"
				async
				data-client-id={dataBuddyClientId}
				data-disabled={disabled}
				data-track-attributes={false}
				data-track-errors={true}
				data-track-outgoing-links={false}
				data-track-web-vitals={false}
				data-track-sessions={false}
			/>
			{process.env.NODE_ENV === "development" ? (
				<Script
					src="//unpkg.com/react-scan/dist/auto.global.js"
					crossOrigin="anonymous"
					strategy="beforeInteractive"
				/>
			) : null}
		</>
	);
}
