/**
 * Subscription list with coalesced notifications.
 *
 * Managers hold one of these instead of a bare `Set` of listeners so a run of
 * mutations can fire listeners once at the end instead of once per mutation:
 * a `BatchCommand` of N sub-commands otherwise replays N `updateTracks()` calls
 * → N notifies, which thrashes every subscribed React component.
 */
export class ChangeNotifier {
	private listeners = new Set<() => void>();
	private batchDepth = 0;
	private pendingNotify = false;

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Open a notification batch. Notifications raised inside the batch are
	 * coalesced into a single one when the matching `endChange()` returns the
	 * depth to zero; a batch that raises none is a no-op.
	 *
	 * Pairing must be balanced — use try/finally so an exception inside the
	 * batch still drains the pending notification.
	 */
	beginChange(): void {
		this.batchDepth += 1;
	}

	endChange(): void {
		if (this.batchDepth === 0) return;
		this.batchDepth -= 1;
		if (this.batchDepth === 0 && this.pendingNotify) {
			this.pendingNotify = false;
			this.flush();
		}
	}

	notify(): void {
		if (this.batchDepth > 0) {
			this.pendingNotify = true;
			return;
		}
		this.flush();
	}

	private flush(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
