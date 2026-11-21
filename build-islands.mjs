// Builds OpsAi chat as the opsai.chat island (Flow fork) for the docked panel and /opsai page.
import { fileURLToPath } from "node:url";

import { buildIslands } from "@framework/ui/vite/island";

import containerQueries from "./container-queries.mjs";

const frappeUISource = fileURLToPath(new URL("./node_modules/frappe-ui/src", import.meta.url));
const sourceImports = {
	name: "frappe-ui-source",
	enforce: "pre",
	resolveId(source, importer) {
		if (source.startsWith("frappe-ui/src/"))
			return this.resolve(frappeUISource + source.slice("frappe-ui/src".length), importer, {
				skipSelf: true,
			});
	},
};

const wholeEntry = {
	name: "island-whole-entry",
	config: () => ({ build: { rollupOptions: { preserveEntrySignatures: "allow-extension" } } }),
};

await buildIslands({
	app: "opsai",
	root: import.meta.dirname,
	subdir: "chat",
	entries: { "opsai.chat": "frontend/src/island.js" },
	budget: 1.5 * 1024 * 1024,
	plugins: [sourceImports, containerQueries, wholeEntry],
	production: process.argv.includes("--production"),
	watch: process.argv.includes("--watch"),
});
