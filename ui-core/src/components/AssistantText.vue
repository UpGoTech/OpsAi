<template>
	<div class="flow-assistant-text">
		<template v-for="(seg, i) in segments" :key="i">
			<InlinePreview
				v-if="seg.kind === 'directive' && seg.name === 'preview' && seg.attrs.file"
				:file="seg.attrs.file"
				:streaming="provisional"
			/>
			<MarkdownContent
				v-else-if="seg.kind === 'prose' && scrubbed(seg.text)"
				:text="scrubbed(seg.text)"
				class="flow-prose text-ink-gray-8"
			/>
		</template>

		<ArtifactCard
			v-for="art in artifacts"
			:key="art.file_url || art.path"
			:artifact="art"
		/>
	</div>
</template>

<script setup>
import { computed } from "vue"

import {
	extractArtifacts,
	scrubArtifactPaths,
	segmentTranscriptDirectives,
} from "../artifacts.js"
import ArtifactCard from "./ArtifactCard.vue"
import InlinePreview from "./InlinePreview.vue"
import MarkdownContent from "./MarkdownContent.vue"

const props = defineProps({
	block: { type: Object, required: true },
	/** True while the turn is still streaming this block. */
	provisional: { type: Boolean, default: false },
})

const source = computed(() => props.block?.text || "")

const segments = computed(() => segmentTranscriptDirectives(source.value))

const artifacts = computed(() => extractArtifacts(source.value))

function scrubbed(text) {
	return scrubArtifactPaths(text || "")
}
</script>
