import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";

/**
 * User-uploaded font files, kept in their own IndexedDB store so they survive
 * reloads and are independent of any single project. The picker lists these
 * under "My fonts"; everything else in the picker comes from the Google atlas.
 */
export interface CustomFont {
	id: string;
	family: string;
	fileName: string;
	/** The raw font file. Blobs are structured-cloneable, so IndexedDB takes them as-is. */
	data: Blob;
	createdAt: number;
}

const CUSTOM_FONT_EXTENSIONS = [
	".ttf",
	".otf",
	".woff",
	".woff2",
] as const;

export const CUSTOM_FONT_ACCEPT = CUSTOM_FONT_EXTENSIONS.join(",");

const adapter = new IndexedDBAdapter<CustomFont>({
	dbName: "video-editor-fonts",
	storeName: "custom-fonts",
});

let cache: CustomFont[] | null = null;
/** family -> the installed FontFace, so removal can uninstall it immediately. */
const registered = new Map<string, FontFace>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

export function subscribeToCustomFonts(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Synchronous snapshot for useSyncExternalStore. Empty until loadCustomFonts resolves. */
export function getCustomFontsSnapshot(): CustomFont[] {
	return cache ?? EMPTY;
}

const EMPTY: CustomFont[] = [];

export function isCustomFontFamily({ family }: { family: string }): boolean {
	return registered.has(family);
}

/**
 * Strips the extension and normalizes separators so "My-Cool_Font.woff2"
 * becomes "My Cool Font". Users can't rename after upload, so the derived
 * name is what they'll see in the picker and what gets stored on the element.
 */
function deriveFamilyFromFileName({
	fileName,
}: {
	fileName: string;
}): string {
	const withoutExtension = fileName.replace(/\.[^.]+$/, "");
	const normalized = withoutExtension
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized || fileName;
}

async function registerFontFace({
	font,
}: {
	font: CustomFont;
}): Promise<boolean> {
	if (registered.has(font.family)) return true;
	if (typeof document === "undefined") return false;

	try {
		const buffer = await font.data.arrayBuffer();
		const face = new FontFace(font.family, buffer);
		await face.load();
		document.fonts.add(face);
		registered.set(font.family, face);
		return true;
	} catch {
		return false;
	}
}

/**
 * Reads every stored font and registers it with the document. Called once on
 * editor startup so text elements referencing a custom family render on the
 * first paint rather than after the user reopens the picker.
 */
export async function loadCustomFonts(): Promise<CustomFont[]> {
	if (cache) return cache;

	let stored: CustomFont[];
	try {
		stored = await adapter.getAll();
	} catch {
		cache = [];
		return cache;
	}

	stored.sort((left, right) => left.family.localeCompare(right.family));
	await Promise.all(stored.map((font) => registerFontFace({ font })));
	cache = stored;
	emit();
	return cache;
}

class DuplicateCustomFontError extends Error {
	constructor(family: string) {
		super(`A font named "${family}" has already been added.`);
		this.name = "DuplicateCustomFontError";
	}
}

class InvalidCustomFontError extends Error {
	constructor(fileName: string) {
		super(`"${fileName}" could not be read as a font file.`);
		this.name = "InvalidCustomFontError";
	}
}

export async function addCustomFont({
	file,
}: {
	file: File;
}): Promise<CustomFont> {
	const existing = await loadCustomFonts();
	const family = deriveFamilyFromFileName({ fileName: file.name });

	if (existing.some((font) => font.family === family)) {
		throw new DuplicateCustomFontError(family);
	}

	const font: CustomFont = {
		id: crypto.randomUUID(),
		family,
		fileName: file.name,
		data: file,
		createdAt: Date.now(),
	};

	// Register before persisting so a file the browser can't parse never lands
	// in storage and reappears as a broken entry on the next load.
	const didRegister = await registerFontFace({ font });
	if (!didRegister) {
		throw new InvalidCustomFontError(file.name);
	}

	await adapter.set({ key: font.id, value: font });
	cache = [...existing, font].sort((left, right) =>
		left.family.localeCompare(right.family),
	);
	emit();
	return font;
}

export async function removeCustomFont({ id }: { id: string }): Promise<void> {
	const existing = await loadCustomFonts();
	const font = existing.find((entry) => entry.id === id);
	if (!font) return;

	await adapter.remove(id);

	// Uninstall the face as well as forgetting it. Leaving it in document.fonts
	// would keep already-placed text rendering correctly until the next reload,
	// which reads as "the delete didn't work" and then breaks later anyway.
	const face = registered.get(font.family);
	if (face && typeof document !== "undefined") {
		document.fonts.delete(face);
	}
	registered.delete(font.family);

	cache = existing.filter((entry) => entry.id !== id);
	emit();
}
