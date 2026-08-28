"use client";

/**
 * Desktop storage self-check.
 *
 * Verifies the parts of the app that only exist in the Tauri shell — streaming
 * writes over binary IPC, the media store on the real filesystem, exports that
 * never enter memory, and disk-backed capacity. Open it in the desktop app, or
 * launch the shell with `BLUPER_SELFTEST=1` to run it on startup and print the
 * results to stdout.
 *
 * Without that runtime there is nothing here to test, so the page says so
 * instead of running.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { tauriAvailable, tauriDiagnosticLog } from "@/lib/tauri-runtime";
import { runDesktopChecks, type CheckResult } from "./checks";

/**
 * Whether the Tauri runtime is present. Read through
 * `useSyncExternalStore` because the answer is a property of the environment,
 * not of React state: the statically exported HTML is built with no runtime at
 * all, so the server snapshot has to say "unknown" and let hydration correct it.
 */
const noopSubscribe = () => () => {};

function useIsDesktop(): boolean | null {
	return useSyncExternalStore(
		noopSubscribe,
		() => tauriAvailable(),
		() => null,
	);
}

function report({ line }: { line: string }) {
	console.log(`[desktop-check] ${line}`);
	void tauriDiagnosticLog({ line }).catch(() => {
		// The window is still the primary output; a missing log command is not
		// a reason to fail the run.
	});
}

export default function DesktopCheckPage() {
	const isDesktop = useIsDesktop();
	const [results, setResults] = useState<CheckResult[]>([]);
	const [isRunning, setIsRunning] = useState(false);

	const run = useCallback(async () => {
		setIsRunning(true);
		setResults([]);
		report({ line: "START" });
		try {
			const all = await runDesktopChecks({
				onResult: (result) => {
					setResults((previous) => [...previous, result]);
					report({
						line: `${result.passed ? "PASS" : "FAIL"} ${result.name} — ${result.detail}`,
					});
				},
			});
			const failed = all.filter((result) => !result.passed).length;
			report({
				line: `DONE ${all.length - failed}/${all.length} passed`,
			});
		} catch (error) {
			report({
				line: `FAIL harness — ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			setIsRunning(false);
		}
	}, []);

	// The shell navigates here with `?autorun=1` when BLUPER_SELFTEST is set.
	// The run is started after the commit rather than inside it, so the first
	// paint shows the page instead of an empty frame, and the ref keeps a
	// re-render from starting a second run over the top of the first.
	const hasAutorun = useRef(false);
	useEffect(() => {
		if (isDesktop !== true || hasAutorun.current) return;
		if (!new URLSearchParams(window.location.search).has("autorun")) return;
		hasAutorun.current = true;
		const timer = setTimeout(() => void run(), 0);
		return () => clearTimeout(timer);
	}, [isDesktop, run]);

	if (isDesktop === null) return null;

	if (!isDesktop) {
		return (
			<main className="mx-auto max-w-2xl p-8">
				<h1 className="text-xl font-semibold">Desktop storage self-check</h1>
				<p className="text-muted-foreground mt-2 text-sm">
					These checks drive the shell&apos;s native filesystem storage, which
					needs the Tauri runtime. Nothing is answering here, so there is
					nothing to run — open this page in the desktop app.
				</p>
			</main>
		);
	}

	const failed = results.filter((result) => !result.passed).length;

	return (
		<main className="mx-auto max-w-3xl p-8">
			<h1 className="text-xl font-semibold">Desktop storage self-check</h1>
			<p className="text-muted-foreground mt-2 text-sm">
				Exercises streaming writes, the filesystem media store, exports that
				stream to disk, and disk-backed capacity.
			</p>

			<div className="mt-4 flex items-center gap-3">
				<Button onClick={() => void run()} disabled={isRunning} size="sm">
					{isRunning ? "Running…" : "Run checks"}
				</Button>
				{results.length > 0 && (
					<span className="text-sm tabular-nums">
						{results.length - failed}/{results.length} passed
					</span>
				)}
			</div>

			<ul className="mt-6 space-y-3">
				{results.map((result) => (
					<li key={result.name} className="rounded-md border p-3 text-sm">
						<div className="flex items-center gap-2 font-medium">
							<span
								aria-hidden
								className={
									result.passed
										? "size-2 rounded-full bg-emerald-500"
										: "size-2 rounded-full bg-red-500"
								}
							/>
							{result.name}
						</div>
						<p className="text-muted-foreground mt-1 break-words">
							{result.detail}
						</p>
					</li>
				))}
			</ul>
		</main>
	);
}
