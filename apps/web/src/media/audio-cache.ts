/**
 * Adds an entry, evicting the least recently added once the cache is full. A Map
 * iterates in insertion order, so its first key is the oldest one.
 *
 * The bound is a count rather than a byte budget because these caches hold
 * promises: how much audio an entry is worth is not known until it resolves.
 * A count is a blunt instrument, but a small one is still a tighter bound than
 * a cache that only empties when something else happens to clear it.
 */
export function rememberInCache<TValue>({
	cache,
	key,
	value,
	limit,
}: {
	cache: Map<string, TValue>;
	key: string;
	value: TValue;
	limit: number;
}): void {
	cache.set(key, value);

	while (cache.size > limit) {
		const oldestKey = cache.keys().next().value;
		// Never evict the entry that prompted this: it is the one about to be used.
		if (oldestKey === undefined || oldestKey === key) break;
		cache.delete(oldestKey);
	}
}
