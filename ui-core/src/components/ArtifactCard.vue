<template>
	<div class="my-2">
		<div
			class="flex items-center gap-2 rounded-lg border border-outline-gray-2 bg-surface-white px-3 py-2"
		>
			<span class="shrink-0 text-xs text-ink-gray-5" aria-hidden="true">{{ label }}</span>
			<div class="min-w-0 flex-1 truncate text-sm text-ink-gray-8">{{ artifact.filename }}</div>
			<button
				type="button"
				class="shrink-0 rounded-md bg-surface-gray-2 px-2.5 py-1 text-xs text-ink-gray-9 hover:bg-surface-gray-3 disabled:opacity-50"
				:disabled="!!busy"
				@click="onPreview"
			>
				{{ busy === "preview" ? __("Opening…") : __("Preview") }}
			</button>
			<button
				type="button"
				class="shrink-0 rounded-md bg-surface-gray-2 px-2.5 py-1 text-xs text-ink-gray-9 hover:bg-surface-gray-3 disabled:opacity-50"
				:disabled="!!busy"
				@click="onDownload"
			>
				{{ busy === "download" ? __("Saving…") : __("Download") }}
			</button>
		</div>
		<div v-if="status" class="mt-1 px-1 text-xs text-ink-gray-5">{{ status }}</div>
	</div>
</template>

<script setup>
import { computed, inject, ref } from "vue"

import { downloadUrlFor, labelForExt, previewUrlFor } from "../artifacts.js"
import { __ } from "../translate.js"

const props = defineProps({
	artifact: { type: Object, required: true },
})

const flow = inject("opsai", null)
const busy = ref(null)
const status = ref(null)
const resolvedUrl = ref(props.artifact.file_url || null)
const resolvedFid = ref(props.artifact.fid || props.artifact.id || null)

const label = computed(() => labelForExt(props.artifact.ext))

async function ensureFile() {
	if (resolvedUrl.value || resolvedFid.value) {
		return { file_url: resolvedUrl.value, fid: resolvedFid.value }
	}
	const path = props.artifact.path
	if (!path) throw new Error(__("No file path"))
	const importer = flow?.client?.importArtifact
	if (!importer) throw new Error(__("Import is not available"))
	const row = await importer(path, flow.state?.sessionId)
	resolvedUrl.value = row?.file_url || null
	resolvedFid.value = row?.fid || row?.file_name || null
	if (!resolvedUrl.value && !resolvedFid.value) throw new Error(__("Could not import file"))
	return { file_url: resolvedUrl.value, fid: resolvedFid.value }
}

async function fetchArtifact(href) {
	const res = await fetch(href, { credentials: "same-origin" })
	if (!res.ok) {
		const err = new Error(
			res.status === 403 || res.status === 404
				? __("File missing — send the message again to regenerate it.")
				: __("Could not open file ({0})", [String(res.status)]),
		)
		throw err
	}
	return res
}

async function onPreview() {
	if (busy.value) return
	busy.value = "preview"
	status.value = null
	try {
		const file = await ensureFile()
		const href = previewUrlFor(file.file_url, file.fid)
		if (!href) throw new Error(__("Preview unavailable"))
		// Probe first so we don't open a Forbidden tab for rolled-back files.
		await fetchArtifact(href)
		window.open(href, "_blank", "noopener,noreferrer")
		status.value = __("Opened in browser")
	} catch (err) {
		status.value = err?.message || __("Preview failed")
	} finally {
		busy.value = null
	}
}

async function onDownload() {
	if (busy.value) return
	busy.value = "download"
	status.value = null
	try {
		const file = await ensureFile()
		const href = downloadUrlFor(file.file_url, file.fid)
		if (!href) throw new Error(__("Download unavailable"))
		const res = await fetchArtifact(href)
		const blob = await res.blob()
		const objectUrl = URL.createObjectURL(blob)
		const a = document.createElement("a")
		a.href = objectUrl
		a.download = props.artifact.filename || "download"
		document.body.appendChild(a)
		a.click()
		a.remove()
		URL.revokeObjectURL(objectUrl)
		status.value = __("Download started")
	} catch (err) {
		status.value = err?.message || __("Download failed")
	} finally {
		busy.value = null
	}
}
</script>
