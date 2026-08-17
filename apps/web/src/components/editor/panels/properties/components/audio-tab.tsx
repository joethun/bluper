"use client";

import { LinkIcon } from "lucide-react";
import { PanelHeader } from "@/components/editor/panels/panel-header";
import { ElementParamsSection } from "@/components/editor/panels/properties/components/element-params-tab";
import { Section, SectionContent } from "@/components/section";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import {
	canRecoverSourceAudio,
	getSourceAudioActionLabel,
} from "@/timeline/audio-separation";
import type { AudioElement, VideoElement } from "@/timeline";

const AUDIO_PARAM_KEYS = ["volume", "muted"] as const;

/**
 * Volume and mute for a clip that carries sound. A video keeps this tab after
 * its sound has been extracted to an audio track, and the params below go inert
 * while it is gone, so the way back sits at the top of the tab rather than only
 * in the timeline toolbar and context menu.
 */
export function AudioTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	return (
		<div className="flex h-full flex-col">
			<PanelHeader title="Audio" />
			{canRecoverSourceAudio(element) ? (
				<RecoverSourceAudioSection element={element} trackId={trackId} />
			) : null}
			<ElementParamsSection
				element={element}
				trackId={trackId}
				paramKeys={AUDIO_PARAM_KEYS}
				sectionKey="audio"
			/>
		</div>
	);
}

function RecoverSourceAudioSection({
	element,
	trackId,
}: {
	element: VideoElement;
	trackId: string;
}) {
	const editor = useEditor();

	return (
		<Section sectionKey={`${element.id}:source-audio`}>
			<SectionContent className="flex flex-col gap-3 pt-4">
				<p className="text-muted-foreground text-xs text-balance">
					This clip&apos;s sound was extracted to an audio track. Recovering
					turns the clip&apos;s own sound back on. The extracted clip stays
					where it is, so delete it unless you want to hear both.
				</p>
				<Button
					variant="secondary"
					size="sm"
					onClick={() =>
						editor.timeline.toggleSourceAudioSeparation({
							trackId,
							elementId: element.id,
						})
					}
				>
					<LinkIcon />
					{getSourceAudioActionLabel({ element })}
				</Button>
			</SectionContent>
		</Section>
	);
}
