export interface FontAtlasEntry {
	x: number;
	y: number;
	w: number;
	ch: number;
	s: string[];
}

export interface FontAtlas {
	fonts: Record<string, FontAtlasEntry>;
}
