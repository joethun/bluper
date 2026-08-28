import type {
	AnimationChannel,
	ChannelData,
	CompositeChannelData,
} from "@/animation/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isLeafChannelData(
	data: ChannelData | undefined,
): data is AnimationChannel {
	return isRecord(data) && Array.isArray(data.keys);
}

function isCompositeChannelData(
	data: ChannelData | undefined,
): data is CompositeChannelData {
	return isRecord(data) && !Array.isArray(data.keys);
}

export function getChannelEntriesFromData({
	data,
}: {
	data: ChannelData | undefined;
}): Array<[string, AnimationChannel]> {
	if (isLeafChannelData(data)) {
		return [["value", data]];
	}
	if (!isCompositeChannelData(data)) {
		return [];
	}
	return Object.entries(data).flatMap(([componentKey, channel]) =>
		isLeafChannelData(channel) ? [[componentKey, channel]] : [],
	);
}
