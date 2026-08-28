export function formatDate({ date }: { date: Date }): string {
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function formatDateTime({ date }: { date: Date }): string {
	return date.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Recent timestamps read better as elapsed time ("2 days ago") than as a
 * calendar date, but the payoff fades fast: past a week the date itself is the
 * more useful label, so that is where this hands off to `formatDate`.
 */
export function formatRelativeDate({ date }: { date: Date }): string {
	const elapsedMs = Date.now() - date.getTime();

	if (elapsedMs < 0 || elapsedMs >= 7 * DAY_MS) {
		return formatDate({ date });
	}

	if (elapsedMs < MINUTE_MS) {
		return "Just now";
	}

	if (elapsedMs < HOUR_MS) {
		const minutes = Math.floor(elapsedMs / MINUTE_MS);
		return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	}

	if (elapsedMs < DAY_MS) {
		const hours = Math.floor(elapsedMs / HOUR_MS);
		return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	}

	const days = Math.floor(elapsedMs / DAY_MS);
	return days === 1 ? "Yesterday" : `${days} days ago`;
}
