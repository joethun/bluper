import { MANAGER_KEYS, type ManagerKey } from "./manager-tracking";

export function isShallowEqual({ a, b }: { a: unknown; b: unknown }): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		return a.every((item, i) => Object.is(item, b[i]));
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const aRecord = a as Record<PropertyKey, unknown>;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const bRecord = b as Record<PropertyKey, unknown>;
	const aKeys = Object.keys(aRecord);
	const bKeys = Object.keys(bRecord);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.is(aRecord[key], bRecord[key])) return false;
	}
	return true;
}

export function trackManagerAccess<U>({
	editor,
	selector,
	accessed,
}: {
	editor: unknown;
	selector: (editor: unknown) => U;
	accessed: Set<ManagerKey>;
}): U {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const proxy = new Proxy(editor as object, {
		get(target, prop, receiver) {
			if (
				typeof prop === "string" &&
				(MANAGER_KEYS as readonly string[]).includes(prop)
			) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				accessed.add(prop as ManagerKey);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return selector(proxy);
}
