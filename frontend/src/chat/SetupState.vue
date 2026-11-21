<template>
	<!-- Empty state until Hermes is configured in OpsAi Settings. -->
	<div
		class="flex w-full flex-1 flex-col items-center gap-8 self-stretch justify-center pb-10"
	>
		<div class="flex flex-col items-center gap-4 text-center">
			<BrandMark line :size="28" />
			<div class="flex flex-col gap-1.5">
				<h1 class="text-2xl-semibold text-ink-gray-9">{{ greeting }}</h1>
				<p class="max-w-sm text-pretty text-p-base text-ink-gray-5">{{ subline }}</p>
			</div>
		</div>
		<Button
			v-if="canConfigure"
			variant="solid"
			:label="__('Open OpsAi Settings')"
			@click="openSettings"
		/>
	</div>
</template>

<script setup>
import { computed, inject } from "vue";
import { Button } from "frappe-ui";
import BrandMark from "@opsai/ui-core/components/BrandMark.vue";
import { __ } from "@opsai/ui-core/translate.js";

const flow = inject("opsai");
const page = inject("opsaiPage");
const hasModels = computed(() => page.state.boot.models.length > 0);
const canConfigure = computed(() => page.can("OpsAi Settings", "write") || page.can("OpsAi Settings", "create"));

const greeting = computed(() => {
	const hour = new Date().getHours();
	const name = page.state.boot.user?.full_name?.split(" ")[0];
	if (hour < 5) return name ? __("Hello, {0}", [name]) : __("Hello");
	if (hour < 12) return name ? __("Good morning, {0}", [name]) : __("Good morning");
	if (hour < 17) return name ? __("Good afternoon, {0}", [name]) : __("Good afternoon");
	return name ? __("Good evening, {0}", [name]) : __("Good evening");
});

const subline = computed(() => {
	if (!hasModels.value) {
		return canConfigure.value
			? __("Set your Hermes gateway URL in OpsAi Settings to get started.")
			: __("Ask an administrator to configure OpsAi Settings.");
	}
	return __("Ask an administrator to enable an agent.");
});

function openSettings() {
	page.state.settingsTab = null;
	flow.setSettingsOpen(true);
}
</script>
