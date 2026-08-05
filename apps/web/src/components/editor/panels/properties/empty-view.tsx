import { Settings2Icon } from "lucide-react";
import { PanelEmptyState } from "@/components/editor/panels/panel-empty-state";

export function EmptyView() {
	return (
		<PanelEmptyState
			className="bg-background"
			icon={Settings2Icon}
			title="It's empty here"
			description="Click an element on the timeline to edit its properties"
		/>
	);
}
