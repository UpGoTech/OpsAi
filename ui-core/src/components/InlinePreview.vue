<template>
	<div class="my-2 w-full max-w-[960px]">
		<div
			v-if="failed || !isHtml"
			class="rounded-lg border border-outline-gray-2 bg-surface-white px-3 py-2 text-sm text-ink-gray-6"
		>
			{{ failed ? __("Preview unavailable") : __("Open with Preview on the card below.") }}
		</div>
		<div
			v-else-if="!srcdoc && !frameSrc"
			class="h-[180px] w-full animate-pulse rounded-md bg-surface-gray-2"
		/>
		<iframe
			v-else-if="srcdoc"
			class="w-full rounded-md border border-outline-gray-2 bg-transparent"
			:style="{ height: `${height}px` }"
			sandbox="allow-scripts"
			:srcdoc="srcdoc"
			:title="title"
		/>
		<iframe
			v-else
			class="w-full rounded-md border border-outline-gray-2 bg-surface-white"
			:style="{ height: `${height}px` }"
			sandbox="allow-scripts allow-same-origin"
			:src="frameSrc"
			:title="title"
		/>
	</div>
</template>

<script setup>
import { computed, inject, onMounted, ref, watch } from "vue"

import { extOf, filenameOf, isHtmlExt, previewUrlFor } from "../artifacts.js"
import { __ } from "../translate.js"

const props = defineProps({
	file: { type: String, required: true },
	streaming: { type: Boolean, default: false },
})

const flow = inject("opsai", null)
const srcdoc = ref(null)
const frameSrc = ref(null)
const failed = ref(false)
const height = ref(280)

const isHtml = computed(() => isHtmlExt(extOf(props.file)))
const title = computed(() => filenameOf(props.file) || "Preview")

async function load() {
	srcdoc.value = null
	frameSrc.value = null
	failed.value = false
	if (!props.file || props.streaming || !isHtml.value) return

	const file = props.file
	const isFrappe = file.startsWith("/private/files/") || file.startsWith("/files/")

	try {
		let fileUrl = isFrappe ? file : null
		if (!fileUrl) {
			const importer = flow?.client?.importArtifact
			if (!importer) {
				failed.value = true
				return
			}
			const row = await importer(file, flow.state?.sessionId)
			fileUrl = row?.file_url
			if (!fileUrl) {
				failed.value = true
				return
			}
		}
		const href = previewUrlFor(fileUrl)
		const res = await fetch(href, { credentials: "same-origin" })
		if (!res.ok) throw new Error(String(res.status))
		const text = await res.text()
		// API errors sometimes return HTML/JSON error pages
		if (text.trimStart().startsWith("{") && text.includes('"exc_type"')) {
			throw new Error("api")
		}
		srcdoc.value = text
	} catch {
		if (isFrappe) frameSrc.value = previewUrlFor(file)
		else failed.value = true
	}
}

onMounted(load)
watch(() => [props.file, props.streaming], load)
</script>
