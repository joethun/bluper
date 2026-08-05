// The stickers browser panel was removed. What remains is the resolution path
// needed to render sticker elements that already exist in a project: the
// renderer's StickerNode and the timeline element both resolve a sticker id to
// a URL through here.
export { resolveStickerId } from "./resolver";
