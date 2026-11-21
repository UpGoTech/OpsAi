<template>
	<!-- OpsAi mark: `line` = outline in currentColor (sidebar / empty chat);
	     otherwise the filled blue logo tile. -->
	<svg
		v-if="line"
		ref="mark"
		:width="size"
		:height="size"
		viewBox="0 0 100 100"
		fill="none"
		role="img"
		aria-label="OpsAi"
		class="opsai-mark block flex-none select-none text-ink-gray-6"
		:class="state && `opsai-mark-${state}`"
		:style="{ width: `${size}px`, height: `${size}px`, '--blink-delay': `${delay}s` }"
	>
		<!-- T-antenna -->
		<path d="M43 15 H57" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" />
		<path d="M50 15 V28" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" />
		<!-- Speech-bubble head -->
		<path
			d="M34 28 H66 C76 28 82 34 82 44 V60 C82 70 76 76 66 76 H48 L36 90 L40 76 H34 C24 76 18 70 18 60 V44 C18 34 24 28 34 28 Z"
			stroke="currentColor"
			stroke-width="5"
			stroke-linejoin="round"
			fill="none"
		/>
		<!-- Ears -->
		<path d="M18 42 V58" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
		<path d="M82 42 V58" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
		<!-- Eyes -->
		<g class="opsai-mark-eyes" :style="gaze">
			<circle cx="40" cy="46" r="4.5" fill="currentColor" />
			<circle cx="60" cy="46" r="4.5" fill="currentColor" />
		</g>
		<!-- Smile -->
		<path
			d="M40 58 C45 65 55 65 60 58"
			stroke="currentColor"
			stroke-width="3.5"
			stroke-linecap="round"
			fill="none"
		/>
	</svg>
	<img
		v-else
		:src="logo"
		:width="size"
		:height="size"
		alt="OpsAi"
		class="block flex-none select-none object-contain"
		:style="{ width: `${size}px`, height: `${size}px` }"
	/>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue"
import logo from "../assets/opsai-logo.svg"

const props = defineProps({
	size: { type: Number, default: 18 },
	line: { type: Boolean, default: false },
	// "idle" blinks; null keeps the mark still
	state: { type: String, default: "idle" },
	look: { type: String, default: null },
})

const delay = -(Math.random() * 6).toFixed(2)

const REACH = 0.9
const FAR = 300
const FIXED = { down: [0, 1], up: [0, -0.7] }
const mark = ref(null)
const eyes = ref([0, 0])
const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
const gaze = computed(() => {
	const [x, y] = props.look === "pointer" ? eyes.value : (FIXED[props.look] ?? [0, 0])
	return still || (!x && !y) ? null : { transform: `translate(${x}px, ${y}px)` }
})

let frame = 0
function follow(event) {
	if (frame) return
	frame = requestAnimationFrame(() => {
		frame = 0
		const box = mark.value?.getBoundingClientRect()
		if (!box) return
		const dx = event.clientX - (box.left + box.width / 2)
		const dy = event.clientY - (box.top + box.height / 2)
		const far = Math.hypot(dx, dy) || 1
		const reach = Math.min(1, far / FAR) * REACH
		eyes.value = [(dx / far) * reach, (dy / far) * reach]
	})
}
const following = computed(() => props.line && props.look === "pointer" && !still)
watch(
	following,
	(on) => {
		if (typeof window === "undefined") return
		if (on) window.addEventListener("pointermove", follow, { passive: true })
		else window.removeEventListener("pointermove", follow)
	},
	{ immediate: true },
)
onBeforeUnmount(() => {
	window.removeEventListener("pointermove", follow)
	cancelAnimationFrame(frame)
})
</script>

<style scoped>
.opsai-mark-eyes circle {
	transform-box: fill-box;
	transform-origin: center;
}
@media (prefers-reduced-motion: no-preference) {
	.opsai-mark-eyes {
		transition: transform 0.25s ease-out;
	}
	.opsai-mark-idle .opsai-mark-eyes circle {
		animation: opsai-mark-blink 6s ease-in-out var(--blink-delay, 0s) infinite;
	}
	.opsai-mark:hover .opsai-mark-eyes circle:last-child,
	button:hover .opsai-mark .opsai-mark-eyes circle:last-child {
		animation: opsai-mark-wink 0.6s ease-in-out;
	}
}
@keyframes opsai-mark-wink {
	0%,
	100% {
		transform: scaleY(1);
	}
	30%,
	60% {
		transform: scaleY(0.12);
	}
}
@keyframes opsai-mark-blink {
	0%,
	94%,
	100% {
		transform: scaleY(1);
	}
	97% {
		transform: scaleY(0.15);
	}
}
</style>
