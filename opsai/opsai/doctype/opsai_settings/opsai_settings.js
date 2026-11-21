// Copyright (c) 2026, OpsAi and contributors
// For license information, please see license.txt

frappe.ui.form.on("OpsAi Settings", {
	before_save(frm) {
		// Blank Password inputs must not wipe secrets already stored in __Auth.
		["gateway_password", "session_token", "session_cookies"].forEach((name) => {
			const typed = field_input_value(frm, name);
			const raw = frm.doc[name];
			if (typed) {
				frm.doc[name] = typed;
				return;
			}
			if (!raw || raw === "*****" || /^\u2022+$/.test(raw) || /^\*+$/.test(raw)) {
				delete frm.doc[name];
			}
		});
	},

	refresh(frm) {
		frm.clear_custom_buttons();
		frm.$wrapper.addClass("opsai-settings-form");
		inject_opsai_styles();

		if (frm.is_new()) {
			// No defaults on create — User and Gateway URL must be chosen explicitly.
			if (!frm._opsai_new_blanked) {
				frm._opsai_new_blanked = true;
				frm.doc.user = "";
				frm.doc.gateway_url = "";
				frm.doc.auth_mode = "password";
				frm.refresh_field("user");
				frm.refresh_field("gateway_url");
			}
			setup_new_opsai_settings(frm);
			return;
		}

		show_full_opsai_settings(frm);
		setup_auth_cards(frm); // includes URL Test + Gateway/Sign-in side-by-side cards
		setup_hermes_hub(frm);
		refresh_opsai_connection_banner(frm);
	},

	auth_mode(frm) {
		if (frm.is_new()) return;
		// depends_on toggles fields; rebuild cards after Frappe finishes show/hide
		frappe.after_ajax(() => {
			setTimeout(() => setup_auth_cards(frm), 0);
		});
	},

	default_provider(frm) {
		if (frm.is_new()) return;
		// Rebuild model suggestions for the chosen provider.
		if (frm._opsai_model_catalog) {
			apply_model_autocomplete(frm, frm._opsai_model_catalog);
		}
	},
});

const OPSAI_CREATE_ONLY_FIELDS = new Set(["user", "gateway_url"]);
const OPSAI_FULL_HIDE_ALWAYS = new Set([
	"session_cookies",
	"connection_status",
	"default_provider",
	"default_model",
]);

function dismantle_opsai_create_card(frm) {
	// Always move fields out before removing the card — .remove() would destroy controls.
	frm.$wrapper.find(".opsai-create-card").each(function () {
		const $card = $(this);
		const $user = frm.get_field("user")?.$wrapper;
		const $url = frm.get_field("gateway_url")?.$wrapper;
		if ($user?.length) $card.before($user);
		if ($url?.length) $card.before($url);
		$card.find(".frappe-control").each(function () {
			$card.before(this);
		});
		$card.remove();
	});
}

function setup_new_opsai_settings(frm) {
	// Tear down full-form chrome without deleting field controls.
	frm.$wrapper.find(".opsai-hub, .opsai-hub-empty, .opsai-connect-grid").remove();
	dismantle_opsai_create_card(frm);
	refresh_opsai_connection_banner(frm);

	// Keep gateway_section visible — hiding a Section Break also hides gateway_url.
	frm.set_df_property("gateway_section", "hidden", 0);
	frm.set_df_property("gateway_section", "label", __("New assignment"));

	(frm.meta.fields || []).forEach((df) => {
		if (!df.fieldname || df.fieldtype === "Section Break" || df.fieldtype === "Column Break") {
			return;
		}
		const show = OPSAI_CREATE_ONLY_FIELDS.has(df.fieldname);
		frm.set_df_property(df.fieldname, "hidden", show ? 0 : 1);
	});
	frm.set_df_property("user", "hidden", 0);
	frm.set_df_property("user", "read_only", 0);
	frm.set_df_property("gateway_url", "hidden", 0);
	frm.set_df_property("user", "reqd", 1);
	frm.set_df_property("gateway_url", "reqd", 1);
	// Credentials are collected after Save via Connect — never block create.
	["gateway_username", "gateway_password", "session_token", "auth_mode"].forEach((name) => {
		frm.set_df_property(name, "reqd", 0);
		frm.set_df_property(name, "hidden", 1);
	});

	frm.dashboard.set_headline(
		`<span class="indicator-pill blue">${__("New")}</span> <span class="text-muted">${__(
			"Assign a User and a unique Hermes Gateway URL (host + port). Test reachability, then Save — Connect and workspace tools open on the saved record."
		)}</span>`
	);

	// Build create card after Frappe has rendered the visible controls.
	frappe.after_ajax(() => {
		if (!frm.is_new()) return;
		const $user = frm.get_field("user")?.$wrapper;
		const $url = frm.get_field("gateway_url")?.$wrapper;
		if (!$user?.length || !$url?.length) return;

		$user.show();
		$url.show();

		dismantle_opsai_create_card(frm);
		const $card = $(`<div class="opsai-create-card">
			<div class="opsai-auth-card-head">
				<span class="opsai-auth-card-icon">${opsai_icon("server", "sm")}</span>
				<div>
					<div class="opsai-auth-card-title">${__("Create OpsAi Settings")}</div>
					<div class="opsai-auth-card-sub">${__(
						"One Hermes agent per user — same host with different ports is OK (e.g. :32798, :32788)."
					)}</div>
				</div>
			</div>
		</div>`);
		$user.before($card);
		$card.append($user);
		$card.append($url);
		setup_url_test(frm);
	});
}

function show_full_opsai_settings(frm) {
	frm.dashboard.clear_headline();
	dismantle_opsai_create_card(frm);
	frm.set_df_property("gateway_section", "label", __("Connection"));

	(frm.meta.fields || []).forEach((df) => {
		if (!df.fieldname) return;
		if (df.fieldtype === "Section Break" || df.fieldtype === "Column Break") {
			frm.set_df_property(df.fieldname, "hidden", 0);
			return;
		}
		if (OPSAI_FULL_HIDE_ALWAYS.has(df.fieldname)) {
			frm.set_df_property(df.fieldname, "hidden", 1);
			return;
		}
		// User is fixed after create — reassign by deleting and adding a new record.
		if (df.fieldname === "user") {
			frm.set_df_property("user", "hidden", 1);
			frm.set_df_property("user", "read_only", 1);
			return;
		}
		// auth credential visibility stays with depends_on
		if (["gateway_username", "gateway_password", "session_token"].includes(df.fieldname)) {
			frm.set_df_property(df.fieldname, "hidden", 0);
			return;
		}
		frm.set_df_property(df.fieldname, "hidden", 0);
	});
}

function inject_opsai_styles() {
	let css = document.getElementById("opsai-settings-css");
	if (!css) {
		css = document.createElement("style");
		css.id = "opsai-settings-css";
		document.head.appendChild(css);
	}
	css.textContent = `
		.opsai-settings-form .form-section {
			margin-bottom: 8px;
		}
		.opsai-settings-form .form-section .section-head {
			font-size: var(--text-sm, 13px);
			font-weight: var(--weight-medium, 500);
			color: var(--text-color, var(--ink-gray-8));
			letter-spacing: 0.01em;
			padding-bottom: 6px;
			border-bottom: 1px solid var(--border-color, var(--outline-gray-2));
			margin-bottom: 12px;
		}
		.opsai-url-row { display: flex; gap: 8px; align-items: stretch; width: 100%; }
		.opsai-url-row .opsai-url-input { flex: 1 1 auto; min-width: 0; }
		.opsai-url-row .opsai-url-test {
			flex: 0 0 auto; white-space: nowrap; height: var(--input-height, 28px);
		}
		.opsai-connect-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
			margin: 8px 0 16px;
			align-items: stretch;
		}
		.opsai-auth-card {
			border: 1px solid var(--border-color, var(--outline-gray-2));
			border-left: 3px solid var(--ink-blue-4, var(--blue-400, #5aa7ef));
			border-radius: var(--border-radius-lg, 12px);
			padding: 14px 16px 16px;
			margin: 0;
			background: var(--surface-elevation-2, var(--fg-color, #fff));
			box-shadow: var(--shadow-sm, none);
			min-width: 0;
			height: 100%;
			display: flex;
			flex-direction: column;
		}
		.opsai-auth-card.opsai-gateway-card {
			border-left-color: var(--ink-orange-4, var(--orange-400, #edb85c));
		}
		.opsai-auth-card.opsai-gateway-card .opsai-auth-card-icon {
			background: var(--bg-orange, #fff4e5);
			color: var(--text-on-orange, var(--ink-orange-5, #c47a0a));
		}
		.opsai-auth-card .opsai-auth-card-body {
			flex: 1;
		}
		.opsai-field-park {
			display: none !important;
		}
		.opsai-create-card {
			border: 1px solid var(--border-color, var(--outline-gray-2));
			border-left: 3px solid var(--ink-blue-4, var(--blue-400, #5aa7ef));
			border-radius: var(--border-radius-lg, 12px);
			padding: 14px 16px 16px;
			margin: 8px 0 16px;
			background: var(--surface-elevation-2, var(--fg-color, #fff));
			box-shadow: var(--shadow-sm, none);
		}
		.opsai-create-card .frappe-control { margin-bottom: 10px; }
		.opsai-auth-card .opsai-auth-card-head {
			display: flex; align-items: center; gap: 8px; margin: 0 0 12px;
		}
		.opsai-auth-card .opsai-auth-card-icon {
			display: inline-flex; align-items: center; justify-content: center;
			width: 28px; height: 28px; border-radius: 8px;
			background: var(--bg-blue, var(--surface-blue-2, #e6f2ff));
			color: var(--text-on-blue, var(--ink-blue-6, #2490ef));
			flex: 0 0 auto;
		}
		.opsai-auth-card .opsai-auth-card-icon .icon { --icon-stroke: currentColor; }
		.opsai-auth-card .opsai-auth-card-title {
			font-size: var(--text-sm, 12px);
			font-weight: var(--weight-medium, 500);
			color: var(--text-muted, var(--ink-gray-6));
			margin: 0;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}
		.opsai-auth-card .opsai-auth-card-sub {
			font-size: 12px;
			color: var(--text-muted, var(--ink-gray-5));
			font-weight: 400;
			text-transform: none;
			letter-spacing: normal;
			margin-top: 1px;
		}
		.opsai-auth-card .form-column, .opsai-auth-card .frappe-control { margin-bottom: 8px; }
		.opsai-connect-row { display: flex; justify-content: flex-end; margin-top: 12px; gap: 8px; }
		.opsai-url-hint {
			font-size: var(--text-sm, 12px); margin-top: 4px;
		}
		.opsai-url-hint.ok { color: var(--green-600, var(--ink-green-5, #16794c)); }
		.opsai-url-hint.bad { color: var(--red-600, var(--ink-red-5, #e24c4c)); }
		.opsai-model-dialog .opsai-model-actions {
			display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end;
			margin: 8px 0 0;
		}
		.opsai-model-dialog .opsai-model-actions .btn-primary {
			background: var(--bg-blue, #e6f2ff);
			color: var(--text-on-blue, var(--ink-blue-6, #2490ef));
			border-color: transparent;
		}
		/* Model is edited via hub tile dialog — keep DocType fields off the form surface. */
		.opsai-settings-form .frappe-control[data-fieldname="default_provider"],
		.opsai-settings-form .frappe-control[data-fieldname="default_model"] {
			display: none !important;
		}
		.opsai-hub-tile .opsai-hub-tile-label.opsai-model-tile-label {
			font-family: var(--font-mono, ui-monospace, monospace);
			word-break: break-all;
		}

		/* Hermes hub — grouped tiles (Identity / Memory / Config / Manage) */
		.opsai-hub {
			margin: 12px 0 20px;
			padding: 0;
			border: 1px solid var(--border-color, var(--outline-gray-2));
			border-radius: calc(var(--border-radius-lg, 10px) + 2px);
			background: var(--surface-elevation-2, var(--fg-color, #fff));
			box-shadow: var(--shadow-sm, none);
			overflow: hidden;
		}
		.opsai-hub-header {
			display: flex; align-items: flex-start; justify-content: space-between;
			gap: 12px; flex-wrap: wrap;
			padding: 16px 18px;
			background: linear-gradient(
				135deg,
				var(--bg-blue, var(--surface-blue-2, #e8f3ff)) 0%,
				var(--surface-elevation-2, var(--fg-color, #fff)) 62%
			);
			border-bottom: 1px solid var(--border-color, var(--outline-gray-2));
		}
		.opsai-hub-header-text { min-width: 0; }
		.opsai-hub-kicker {
			display: inline-flex; align-items: center; gap: 6px;
			font-size: 11px; font-weight: var(--weight-medium, 500);
			text-transform: uppercase; letter-spacing: 0.06em;
			color: var(--text-on-blue, var(--ink-blue-5, #2490ef));
			margin-bottom: 4px;
		}
		.opsai-hub-kicker .icon { --icon-stroke: currentColor; }
		.opsai-hub-title {
			font-size: var(--text-lg, 16px);
			font-weight: var(--weight-semibold, 600);
			color: var(--heading-color, var(--ink-gray-9));
			margin: 0 0 4px;
			line-height: 1.3;
		}
		.opsai-hub-subtitle {
			font-size: var(--text-sm, 12px);
			color: var(--text-muted, var(--ink-gray-6));
			margin: 0;
			max-width: 46rem;
			line-height: 1.45;
		}
		.opsai-hub-body { padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 12px; }
		.opsai-hub-row {
			display: grid;
			gap: 12px;
			align-items: stretch;
		}
		.opsai-hub-row-triple {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.opsai-hub-group {
			border: 1px solid var(--border-color, var(--outline-gray-2));
			border-radius: var(--border-radius-lg, 10px);
			background: var(--subtle-fg, var(--bg-color, #f8fafc));
			padding: 12px;
			min-width: 0;
			display: flex;
			flex-direction: column;
			height: 100%;
		}
		.opsai-hub-row .opsai-hub-group .opsai-hub-group-desc {
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
		}
		.opsai-hub-row .opsai-hub-tiles {
			grid-template-columns: 1fr;
			flex: 1;
		}
		.opsai-hub-row .opsai-hub-tile {
			height: 100%;
		}
		.opsai-hub-group-head {
			display: flex; align-items: flex-start; gap: 10px;
			margin-bottom: 10px;
		}
		.opsai-hub-group-icon {
			display: inline-flex; align-items: center; justify-content: center;
			width: 32px; height: 32px; border-radius: 9px; flex: 0 0 auto;
		}
		.opsai-hub-group-icon .icon { --icon-stroke: currentColor; width: 16px; height: 16px; }
		.opsai-hub-group-icon.tone-blue {
			background: var(--bg-blue, #e6f2ff); color: var(--text-on-blue, var(--ink-blue-6, #2490ef));
		}
		.opsai-hub-group-icon.tone-cyan {
			background: var(--bg-cyan, #e0f7fa); color: var(--text-on-cyan, var(--ink-cyan-5, #0891b2));
		}
		.opsai-hub-group-icon.tone-orange {
			background: var(--bg-orange, #fff4e5); color: var(--text-on-orange, var(--ink-orange-5, #c47a0a));
		}
		.opsai-hub-group-icon.tone-purple {
			background: var(--bg-purple, #f3e8ff); color: var(--text-on-purple, var(--ink-purple-5, #7c3aed));
		}
		.opsai-hub-group-icon.tone-red {
			background: var(--bg-red, #fde8e8); color: var(--text-on-red, var(--ink-red-5, #e24c4c));
		}
		.opsai-hub-group-title {
			font-size: 13px; font-weight: var(--weight-medium, 500);
			color: var(--heading-color, var(--ink-gray-9));
			margin: 0;
		}
		.opsai-hub-group-desc {
			font-size: 12px; color: var(--text-muted, var(--ink-gray-6));
			margin: 2px 0 0; line-height: 1.4;
		}
		.opsai-hub-tiles {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
			gap: 8px;
		}
		.opsai-hub-tile {
			display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
			text-align: left; width: 100%;
			padding: 12px;
			border: 1px solid var(--border-color, var(--outline-gray-2));
			border-radius: var(--border-radius, 8px);
			background: var(--fg-color, #fff);
			color: var(--text-color, var(--ink-gray-8));
			cursor: pointer;
			transition: border-color 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease;
			box-shadow: none;
		}
		.opsai-hub-tile:hover {
			border-color: var(--primary, var(--ink-blue-4, #5aa7ef));
			box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.04));
			transform: translateY(-1px);
		}
		.opsai-hub-tile:focus-visible {
			outline: 2px solid var(--primary, #2490ef);
			outline-offset: 1px;
		}
		.opsai-hub-tile-icon {
			display: inline-flex; align-items: center; justify-content: center;
			width: 28px; height: 28px; border-radius: 8px;
		}
		.opsai-hub-tile-icon .icon { --icon-stroke: currentColor; }
		.opsai-hub-tile.tone-blue .opsai-hub-tile-icon {
			background: var(--bg-blue, #e6f2ff); color: var(--text-on-blue, var(--ink-blue-6));
		}
		.opsai-hub-tile.tone-cyan .opsai-hub-tile-icon {
			background: var(--bg-cyan, #e0f7fa); color: var(--text-on-cyan, #0891b2);
		}
		.opsai-hub-tile.tone-green .opsai-hub-tile-icon {
			background: var(--bg-green, #e7f5ee); color: var(--text-on-green, var(--ink-green-5, #16794c));
		}
		.opsai-hub-tile.tone-orange .opsai-hub-tile-icon {
			background: var(--bg-orange, #fff4e5); color: var(--text-on-orange, #c47a0a);
		}
		.opsai-hub-tile.tone-yellow .opsai-hub-tile-icon {
			background: var(--bg-yellow, #fff9e0); color: var(--text-on-yellow, #a16207);
		}
		.opsai-hub-tile.tone-purple .opsai-hub-tile-icon {
			background: var(--bg-purple, #f3e8ff); color: var(--text-on-purple, #7c3aed);
		}
		.opsai-hub-tile.tone-gray .opsai-hub-tile-icon {
			background: var(--bg-gray, #f0f2f5); color: var(--text-muted, var(--ink-gray-7));
		}
		.opsai-hub-tile.tone-red .opsai-hub-tile-icon {
			background: var(--bg-red, #fde8e8); color: var(--text-on-red, #e24c4c);
		}
		.opsai-hub-tile-label {
			font-size: 13px; font-weight: var(--weight-medium, 500);
			color: var(--heading-color, var(--ink-gray-9));
			font-family: var(--font-mono, ui-monospace, monospace);
		}
		.opsai-hub-tile-meta {
			font-size: 11px; color: var(--text-muted, var(--ink-gray-6));
			line-height: 1.35;
		}
		.opsai-hub-tile.opsai-hub-tile-danger {
			border-color: var(--red-200, #f5c6c6);
			background: var(--bg-red, #fdf2f2);
		}
		.opsai-hub-tile.opsai-hub-tile-danger:hover {
			border-color: var(--red-400, #e24c4c);
		}
		.opsai-hub-tile .opsai-hub-tile-status {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			margin-top: 2px;
		}
		.opsai-gateway-dialog .opsai-gateway-actions {
			display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 10px;
		}
		.opsai-gateway-dialog .opsai-gateway-platforms {
			margin: 0 0 10px;
			padding: 0;
			list-style: none;
			border: 1px solid var(--border-color, var(--outline-gray-2));
			border-radius: var(--border-radius, 8px);
			overflow: hidden;
			background: var(--fg-color, #fff);
		}
		.opsai-gateway-dialog .opsai-gateway-platforms li {
			display: flex; justify-content: space-between; gap: 8px;
			padding: 8px 10px;
			border-bottom: 1px solid var(--border-color, #e2e6ea);
			font-size: 12px;
		}
		.opsai-gateway-dialog .opsai-gateway-platforms li:last-child { border-bottom: 0; }
		.opsai-gateway-dialog .opsai-gateway-platforms .name {
			font-family: var(--font-mono, ui-monospace, monospace);
			font-weight: var(--weight-medium, 500);
		}
		.opsai-gateway-dialog .opsai-gateway-meta {
			font-size: 12px; color: var(--text-muted); margin: 0 0 8px;
		}
		.opsai-hub-empty {
			margin: 12px 0 20px; padding: 16px 18px;
			border: 1px dashed var(--border-color, var(--outline-gray-2));
			border-radius: var(--border-radius-lg, 10px);
			background: var(--subtle-fg, var(--bg-color, #f8fafc));
			display: flex; gap: 12px; align-items: flex-start;
		}
		.opsai-hub-empty-icon {
			display: inline-flex; align-items: center; justify-content: center;
			width: 36px; height: 36px; border-radius: 10px; flex: 0 0 auto;
			background: var(--bg-orange, #fff4e5); color: var(--text-on-orange, #c47a0a);
		}
		.opsai-hub-empty-icon .icon { --icon-stroke: currentColor; }
		.opsai-hub-empty-title {
			font-size: 13px; font-weight: var(--weight-medium, 500);
			color: var(--heading-color, var(--ink-gray-9)); margin: 0 0 2px;
		}
		.opsai-hub-empty-text {
			font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.45;
		}
		.opsai-env-editor {
			max-height: min(70vh, 640px);
			overflow: auto;
			border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 8px;
			padding: 8px;
			background: var(--bg-color, #f5f7fa);
		}
		.opsai-env-row {
			display: grid;
			grid-template-columns: minmax(140px, 220px) 1fr auto;
			gap: 8px;
			align-items: start;
			padding: 8px;
			margin-bottom: 6px;
			border-radius: 6px;
			background: var(--fg-color, #fff);
			border: 1px solid var(--border-color, #e2e6ea);
		}
		.opsai-env-row .opsai-env-key {
			font-family: var(--font-mono, ui-monospace, monospace);
			font-size: 12px;
			font-weight: 600;
			word-break: break-all;
			padding-top: 6px;
		}
		.opsai-env-row .opsai-env-meta {
			font-size: 11px;
			color: var(--text-muted, #6c7680);
			font-weight: 400;
			margin-top: 2px;
		}
		.opsai-env-row .opsai-env-value {
			width: 100%;
			min-height: 30px;
			font-family: var(--font-mono, ui-monospace, monospace);
			font-size: 12px;
		}
		.opsai-env-row .opsai-env-actions {
			display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end;
		}
		.opsai-env-add {
			display: grid;
			grid-template-columns: minmax(140px, 220px) 1fr auto;
			gap: 8px;
			align-items: center;
			margin-top: 10px;
			padding: 8px;
			border: 1px dashed var(--border-color, #d1d8dd);
			border-radius: 6px;
			background: var(--fg-color, #fff);
		}
		.opsai-env-add input {
			width: 100%;
			font-family: var(--font-mono, ui-monospace, monospace);
			font-size: 12px;
		}
		@media (max-width: 768px) {
			.opsai-env-row, .opsai-env-add {
				grid-template-columns: 1fr;
			}
		}
		/* Plain Desk form-control textarea — force book weight (Inter var can look heavy at 420). */
		.opsai-soul-editor .opsai-soul-label {
			display: block;
			margin-bottom: 6px;
			font-size: var(--text-sm, 13px);
			font-weight: var(--weight-medium, var(--font-weight-medium, 500));
			color: var(--text-muted, var(--ink-gray-7));
		}
		.opsai-soul-editor .opsai-soul-label .reqd {
			color: var(--red-500, #e24c4c);
		}
		.opsai-soul-editor textarea.opsai-soul-textarea.form-control {
			display: block;
			width: 100%;
			min-height: min(60vh, 480px);
			height: min(60vh, 480px);
			resize: vertical;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			word-break: break-word;
			line-height: 1.5;
			letter-spacing: normal;
			font-family: var(--font-stack);
			font-size: var(--text-base, 14px);
			font-weight: 400 !important;
			font-variation-settings: "wght" 400;
			color: var(--text-color, var(--ink-gray-9));
			background-color: var(--control-bg, var(--bg-color, #fff));
			border: 1px solid var(--border-color, var(--outline-gray-2, #d1d8dd));
			border-radius: var(--border-radius, 8px);
			padding: 8px 10px;
			box-shadow: none;
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
		}
		.opsai-soul-editor textarea.opsai-soul-textarea.form-control:focus {
			border-color: var(--primary, var(--blue-500, #2490ef));
			outline: none;
			box-shadow: none;
		}
		.opsai-soul-editor .opsai-char-count {
			display: flex;
			flex-wrap: wrap;
			justify-content: space-between;
			gap: 8px;
			margin-top: 6px;
			font-size: 12px;
			color: var(--text-muted, #6c7680);
		}
		.opsai-soul-editor .opsai-char-count .opsai-char-stats {
			margin-left: auto;
			font-variant-numeric: tabular-nums;
		}
		.opsai-soul-editor .opsai-char-count.near .opsai-char-stats {
			color: var(--orange-600, #c47a0a);
		}
		.opsai-soul-editor .opsai-char-count.full .opsai-char-stats,
		.opsai-soul-editor .opsai-char-count.over .opsai-char-stats {
			color: var(--red-600, #e24c4c);
			font-weight: var(--weight-medium, 500);
		}
		.opsai-manage-toolbar {
			display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
			margin-bottom: 10px;
		}
		.opsai-manage-list {
			max-height: min(65vh, 560px);
			overflow: auto;
			border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 8px;
			background: var(--bg-color, #f5f7fa);
		}
		.opsai-manage-row {
			display: grid;
			grid-template-columns: 1fr auto;
			gap: 8px;
			align-items: start;
			padding: 10px 12px;
			border-bottom: 1px solid var(--border-color, #e2e6ea);
			background: var(--fg-color, #fff);
		}
		.opsai-manage-row:last-child { border-bottom: 0; }
		.opsai-manage-row .opsai-manage-title {
			font-weight: var(--weight-medium, 500);
			font-size: 13px;
		}
		.opsai-manage-row .opsai-manage-meta {
			font-size: 12px;
			color: var(--text-muted, #6c7680);
			margin-top: 2px;
		}
		.opsai-manage-row .opsai-manage-actions {
			display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end;
		}
		.opsai-logs-view {
			max-height: min(65vh, 560px);
			overflow: auto;
			font-family: var(--font-mono, ui-monospace, monospace);
			font-size: 11px;
			font-weight: 400;
			line-height: 1.45;
			white-space: pre-wrap;
			word-break: break-word;
			background: var(--fg-color, #fff);
			border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 8px;
			padding: 10px 12px;
			color: var(--text-color);
		}
		.opsai-restart-status {
			display: flex;
			align-items: center;
			gap: 8px;
			margin: 0 0 10px;
			flex-wrap: wrap;
		}
		.opsai-restart-status .opsai-restart-detail {
			color: var(--text-muted);
			font-size: 12px;
		}
		.opsai-restart-log {
			max-height: min(55vh, 480px);
			min-height: 160px;
		}
		.opsai-memory-editor {
			max-height: min(65vh, 560px);
			overflow: auto;
			border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 8px;
			padding: 8px;
			background: var(--bg-color, #f5f7fa);
		}
		.opsai-memory-row {
			display: grid;
			grid-template-columns: 56px 1fr auto;
			gap: 8px;
			align-items: start;
			padding: 8px;
			margin-bottom: 6px;
			border-radius: 6px;
			background: var(--fg-color, #fff);
			border: 1px solid var(--border-color, #e2e6ea);
		}
		.opsai-memory-row .opsai-memory-index {
			font-size: 12px;
			font-weight: var(--weight-medium, 500);
			color: var(--text-muted, #6c7680);
			padding-top: 8px;
		}
		.opsai-memory-row textarea.opsai-memory-value {
			width: 100%;
			min-height: 72px;
			resize: vertical;
			font-family: var(--font-stack);
			font-size: var(--text-base, 14px);
			font-weight: 400 !important;
			font-variation-settings: "wght" 400;
			line-height: 1.45;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			word-break: break-word;
			letter-spacing: normal;
		}
		.opsai-memory-row .opsai-memory-actions {
			display: flex; flex-direction: column; gap: 4px;
		}
		.opsai-memory-add {
			display: grid;
			grid-template-columns: 1fr auto;
			gap: 8px;
			align-items: start;
			margin-top: 10px;
			padding: 8px;
			border: 1px dashed var(--border-color, #d1d8dd);
			border-radius: 6px;
			background: var(--fg-color, #fff);
		}
		.opsai-memory-add textarea {
			width: 100%;
			min-height: 64px;
			resize: vertical;
			font-weight: 400 !important;
		}
		.opsai-memory-budget {
			display: flex;
			flex-wrap: wrap;
			justify-content: space-between;
			gap: 8px;
			margin: 0 0 10px;
			font-size: 12px;
			color: var(--text-muted, #6c7680);
		}
		.opsai-memory-budget .opsai-char-stats {
			margin-left: auto;
			font-variant-numeric: tabular-nums;
		}
		.opsai-memory-budget.near .opsai-char-stats { color: var(--orange-600, #c47a0a); }
		.opsai-memory-budget.full .opsai-char-stats,
		.opsai-memory-budget.over .opsai-char-stats {
			color: var(--red-600, #e24c4c);
			font-weight: var(--weight-medium, 500);
		}
		@media (max-width: 960px) {
			.opsai-hub-row-triple { grid-template-columns: 1fr; }
			.opsai-connect-grid { grid-template-columns: 1fr; }
		}
		@media (max-width: 768px) {
			.opsai-memory-row, .opsai-memory-add { grid-template-columns: 1fr; }
			.opsai-hub-tiles { grid-template-columns: 1fr 1fr; }
		}
	`;
}

function opsai_icon(name, size) {
	try {
		return frappe.utils.icon(name, size || "sm");
	} catch (e) {
		return "";
	}
}

function is_hermes_connected(frm) {
	// Do not use .includes("connected") — "Disconnected" contains that substring.
	const s = (frm.doc.connection_status || "").trim().toLowerCase();
	return s === "connected" || s.startsWith("connected ");
}

function refresh_opsai_connection_banner(frm) {
	// Avoid repeating "Connected" — status lives once on the Hermes Workspace header.
	frm.dashboard.clear_headline();
}

function hermes_hub_tile({ tone, icon, label, meta, attrs, extra_class }) {
	const safe_attrs = { ...(attrs || {}) };
	delete safe_attrs.class;
	const attr_html = Object.entries(safe_attrs)
		.map(([k, v]) => `${k}="${frappe.utils.escape_html(String(v))}"`)
		.join(" ");
	const classes = ["opsai-hub-tile", `tone-${tone || "gray"}`, extra_class || ""]
		.filter(Boolean)
		.join(" ");
	return `<button type="button" class="${frappe.utils.escape_html(classes)}" ${attr_html}>
		<span class="opsai-hub-tile-icon">${opsai_icon(icon, "sm")}</span>
		<span class="opsai-hub-tile-label">${frappe.utils.escape_html(label)}</span>
		<span class="opsai-hub-tile-meta">${frappe.utils.escape_html(meta || "")}</span>
	</button>`;
}

function hermes_hub_group({ tone, icon, title, desc, tiles_html, body_html, extra_class }) {
	const body =
		body_html ||
		(tiles_html ? `<div class="opsai-hub-tiles">${tiles_html}</div>` : "");
	return `<section class="opsai-hub-group ${frappe.utils.escape_html(extra_class || "")}">
		<div class="opsai-hub-group-head">
			<span class="opsai-hub-group-icon tone-${frappe.utils.escape_html(tone)}">${opsai_icon(
		icon,
		"sm"
	)}</span>
			<div>
				<div class="opsai-hub-group-title">${frappe.utils.escape_html(title)}</div>
				<div class="opsai-hub-group-desc">${frappe.utils.escape_html(desc)}</div>
			</div>
		</div>
		${body}
	</section>`;
}

function hermes_model_tile_meta(frm) {
	const model = (frm.doc.default_model || "").trim();
	const provider = (frm.doc.default_provider || "").trim();
	if (model && provider) return provider;
	if (model) return __("Click to change");
	return __("Choose provider & model");
}

function hermes_model_tile_label(frm) {
	return (frm.doc.default_model || "").trim() || __("Default model");
}

function place_opsai_connect_grid(frm, $grid) {
	// Always keep Gateway/Sign-in ABOVE the Hermes Workspace hub.
	const $hub = frm.$wrapper.find(".opsai-hub, .opsai-hub-empty").first();
	if ($hub.length) {
		$hub.before($grid);
		return;
	}
	const $section_body = frm.$wrapper
		.find('.form-section[data-fieldname="gateway_section"] .section-body')
		.first();
	if ($section_body.length) {
		$section_body.prepend($grid);
		return;
	}
	const $user = frm.get_field("user")?.$wrapper;
	if ($user?.length) {
		$user.after($grid);
		return;
	}
	frm.$wrapper.find(".form-layout").first().prepend($grid);
}

function place_opsai_hub(frm, $hub) {
	// Hub sits directly under the connection cards (never after a whole section).
	const $grid = frm.$wrapper.find(".opsai-connect-grid").first();
	if ($grid.length) {
		$grid.after($hub);
		return;
	}
	const $section_body = frm.$wrapper
		.find('.form-section[data-fieldname="gateway_section"] .section-body')
		.first();
	if ($section_body.length) {
		$section_body.append($hub);
		return;
	}
	frm.$wrapper.find(".form-layout").first().append($hub);
}

function setup_hermes_hub(frm) {
	frm.$wrapper.find(".opsai-hub, .opsai-hub-empty, .opsai-hermes-files").remove();

	if (!is_hermes_connected(frm)) {
		const $empty = $(`<div class="opsai-hub-empty">
			<span class="opsai-hub-empty-icon">${opsai_icon("unplug", "md")}</span>
			<div>
				<div class="opsai-hub-empty-title">${__("Hermes workspace locked")}</div>
				<p class="opsai-hub-empty-text">${__(
					"Connect to Hermes above to choose the default model, edit SOUL / memory / config, and manage skills, cron, sessions, and logs."
				)}</p>
			</div>
		</div>`);
		place_opsai_hub(frm, $empty);
		return;
	}

	const identity = hermes_hub_group({
		tone: "blue",
		icon: "sparkles",
		title: __("Identity"),
		desc: __("Who the agent is — personality and voice (SOUL.md)."),
		tiles_html: hermes_hub_tile({
			tone: "blue",
			icon: "user",
			label: "SOUL.md",
			meta: __("Personality & tone"),
			attrs: { "data-kind": "soul" },
		}),
	});

	const model = hermes_hub_group({
		tone: "blue",
		icon: "cpu",
		title: __("Model"),
		desc: __("Default chat model — click to change."),
		extra_class: "opsai-hub-group-model",
		tiles_html: hermes_hub_tile({
			tone: "blue",
			icon: "cpu",
			label: hermes_model_tile_label(frm),
			meta: hermes_model_tile_meta(frm),
			extra_class: "opsai-open-model",
		}),
	});

	const memory = hermes_hub_group({
		tone: "cyan",
		icon: "brain",
		title: __("Memory"),
		desc: __(
			"What the agent learned and who you are — MEMORY.md & USER.md (Hermes memory tool)."
		),
		tiles_html:
			hermes_hub_tile({
				tone: "cyan",
				icon: "notebook",
				label: "MEMORY.md",
				meta: __("Agent notes · 2,200 chars"),
				attrs: { "data-kind": "memory" },
			}) +
			hermes_hub_tile({
				tone: "green",
				icon: "contact",
				label: "USER.md",
				meta: __("Your profile · 1,375 chars"),
				attrs: { "data-kind": "user_md" },
			}),
	});

	const config = hermes_hub_group({
		tone: "orange",
		icon: "settings",
		title: __("Configuration"),
		desc: __("Runtime config and secrets on the Hermes host."),
		tiles_html:
			hermes_hub_tile({
				tone: "orange",
				icon: "file-code",
				label: "config.yaml",
				meta: __("Hermes settings"),
				attrs: { "data-kind": "config" },
			}) +
			hermes_hub_tile({
				tone: "yellow",
				icon: "key",
				label: ".env",
				meta: __("Environment secrets"),
				attrs: { "data-kind": "env" },
			}),
	});

	const manage = hermes_hub_group({
		tone: "purple",
		icon: "layout-dashboard",
		title: __("Manage"),
		desc: __("Skills, scheduled jobs, chat sessions, and live logs."),
		tiles_html:
			hermes_hub_tile({
				tone: "purple",
				icon: "puzzle",
				label: __("Skills"),
				meta: __("Installed capabilities"),
				attrs: { "data-manage": "skills" },
			}) +
			hermes_hub_tile({
				tone: "purple",
				icon: "timer",
				label: __("Cron"),
				meta: __("Scheduled jobs"),
				attrs: { "data-manage": "cron" },
			}) +
			hermes_hub_tile({
				tone: "gray",
				icon: "message-circle",
				label: __("Sessions"),
				meta: __("Chat history"),
				attrs: { "data-manage": "sessions" },
			}) +
			hermes_hub_tile({
				tone: "gray",
				icon: "scroll-text",
				label: __("Logs"),
				meta: __("Gateway · agent · errors"),
				attrs: { "data-manage": "logs" },
			}),
	});

	const gateway = hermes_hub_group({
		tone: "red",
		icon: "refresh-cw",
		title: __("Gateway"),
		desc: __("Status & controls — click for start / stop / restart."),
		extra_class: "opsai-hub-group-gateway",
		tiles_html: hermes_hub_tile({
			tone: "gray",
			icon: "power",
			label: __("Checking…"),
			meta: __("Click for actions"),
			extra_class: "opsai-open-gateway",
		}),
	});

	const $hub = $(`<div class="opsai-hub">
		<div class="opsai-hub-header">
			<div class="opsai-hub-header-text">
				<div class="opsai-hub-kicker">${opsai_icon("orbit", "xs")} ${__("Hermes")}</div>
				<div class="opsai-hub-title">${__("Workspace")}</div>
				<p class="opsai-hub-subtitle">${__(
					"Model, identity, memory, config, and runtime — edit live on Hermes; OpsAi only proxies."
				)}</p>
			</div>
			<span class="indicator-pill green">${__("Connected")}</span>
		</div>
		<div class="opsai-hub-body">
			<div class="opsai-hub-row opsai-hub-row-triple">
				${identity}
				${model}
				${gateway}
			</div>
			${memory}
			${config}
			${manage}
		</div>
	</div>`);

	place_opsai_hub(frm, $hub);

	// Match SOUL.md tile label styling for long model ids.
	$hub.find(".opsai-open-model .opsai-hub-tile-label").addClass("opsai-model-tile-label");

	$hub.find(".opsai-open-model").on("click", () => open_hermes_model_dialog(frm));
	$hub.find(".opsai-open-gateway").on("click", () => open_hermes_gateway_dialog(frm));
	$hub.find("[data-kind]").on("click", function () {
		open_hermes_file_editor(frm, $(this).data("kind"));
	});
	$hub.find("[data-manage]").on("click", function () {
		open_hermes_manage(frm, $(this).data("manage"));
	});

	// Warm model catalog + gateway status for tiles.
	load_hermes_models(frm, false);
	refresh_hermes_gateway_tile(frm);
}

function gateway_status_tone(state, running) {
	const s = (state || "").toLowerCase();
	if (s === "running" || running) return "green";
	if (s === "starting" || s === "restarting" || s === "draining" || s === "stopping") return "orange";
	if (s === "stopped" || s === "exited" || s === "dead") return "red";
	if (s === "error" || s === "failed") return "red";
	return "gray";
}

function gateway_status_label(status) {
	if (!status?.ok) return __("Unknown");
	return status.label || (status.gateway_running ? __("Running") : __("Stopped"));
}

function refresh_hermes_gateway_tile(frm) {
	const $tile = frm.$wrapper.find(".opsai-open-gateway");
	if (!$tile.length) return;
	return frappe
		.call({
			method: "opsai.api.get_hermes_gateway_status",
			args: { user: frm.doc.user || frm.doc.name },
		})
		.then((r) => {
			const status = r.message || {};
			frm._opsai_gateway_status = status;
			const label = gateway_status_label(status);
			const tone = gateway_status_tone(status.gateway_state, status.gateway_running);
			const meta = status.ok
				? status.gateway_busy
					? __("Busy · {0} sessions", [status.active_sessions || 0])
					: __("{0} · click for actions", [status.overall || __("healthy")])
				: status.message || __("Could not read status");
			$tile
				.removeClass("tone-green tone-orange tone-red tone-gray tone-blue")
				.addClass(`tone-${tone}`);
			$tile.find(".opsai-hub-tile-label").text(label);
			$tile.find(".opsai-hub-tile-meta").text(meta);
			return status;
		})
		.catch(() => {
			$tile.removeClass("tone-green tone-orange tone-red tone-blue").addClass("tone-gray");
			$tile.find(".opsai-hub-tile-label").text(__("Unknown"));
			$tile.find(".opsai-hub-tile-meta").text(__("Could not read status"));
		});
}

function open_hermes_gateway_dialog(frm) {
	const state = {
		alive: true,
		lines: [],
		timer: null,
		attempt: 0,
		max_attempts: 40,
		action_name: "",
	};

	const dialog = new frappe.ui.Dialog({
		title: __("Hermes Gateway"),
		size: "large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<div class="opsai-restart-status">
					<span class="indicator-pill gray opsai-restart-pill">${__("Loading")}</span>
					<span class="opsai-restart-detail">${__("Reading gateway status…")}</span>
				</div>
				<p class="opsai-gateway-meta opsai-gateway-summary"></p>
				<ul class="opsai-gateway-platforms"></ul>
				<div class="opsai-gateway-actions">
					<button type="button" class="btn btn-primary btn-sm" data-gw-action="start">
						${opsai_icon("play", "xs")} ${__("Start")}
					</button>
					<button type="button" class="btn btn-default btn-sm" data-gw-action="stop">
						${opsai_icon("square", "xs")} ${__("Stop")}
					</button>
					<button type="button" class="btn btn-warning btn-sm" data-gw-action="restart">
						${opsai_icon("refresh-cw", "xs")} ${__("Restart")}
					</button>
					<button type="button" class="btn btn-default btn-sm" data-gw-action="drain">
						${opsai_icon("circle-pause", "xs")} ${__("Drain")}
					</button>
					<button type="button" class="btn btn-default btn-sm opsai-gateway-refresh">
						${opsai_icon("refresh-cw", "xs")} ${__("Refresh")}
					</button>
				</div>
				<pre class="opsai-logs-view opsai-restart-log"></pre>`,
			},
		],
		primary_action_label: __("Close"),
		primary_action() {
			dialog.hide();
		},
	});

	dialog.$wrapper.addClass("opsai-gateway-dialog");
	dialog.$wrapper.on("hidden.bs.modal", () => {
		state.alive = false;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		refresh_hermes_gateway_tile(frm);
	});

	dialog.show();
	append_restart_log(dialog, state, __("→ Gateway control panel"));

	const render_status = (status) => {
		if (!status?.ok) {
			set_restart_dialog_status(
				dialog,
				"red",
				__("Error"),
				status?.message || __("Could not read status")
			);
			dialog.$wrapper.find(".opsai-gateway-summary").text("");
			dialog.$wrapper.find(".opsai-gateway-platforms").empty();
			return;
		}
		const tone = gateway_status_tone(status.gateway_state, status.gateway_running);
		set_restart_dialog_status(
			dialog,
			tone,
			gateway_status_label(status),
			status.gateway_busy
				? __("Busy · {0} active sessions · {1} agents", [
						status.active_sessions || 0,
						status.active_agents || 0,
				  ])
				: __("Idle · {0} sessions · overall {1}", [
						status.active_sessions || 0,
						status.overall || "—",
				  ])
		);
		dialog.$wrapper
			.find(".opsai-gateway-summary")
			.text(
				[
					status.version ? `Hermes ${status.version}` : "",
					status.gateway_updated_at
						? __("Updated {0}", [status.gateway_updated_at])
						: "",
					status.gateway_exit_reason
						? __("Exit: {0}", [status.gateway_exit_reason])
						: "",
					status.gateway_drainable ? __("Drainable") : "",
				]
					.filter(Boolean)
					.join(" · ")
			);

		const $list = dialog.$wrapper.find(".opsai-gateway-platforms").empty();
		(status.platforms || []).forEach((p) => {
			const pill = gateway_status_tone(p.state, p.state === "connected");
			$list.append(`<li>
				<span class="name">${frappe.utils.escape_html(p.name)}</span>
				<span class="indicator-pill ${pill}">${frappe.utils.escape_html(
				(p.state || "unknown").replace(/_/g, " ")
			)}</span>
			</li>`);
		});
		if (!(status.platforms || []).length) {
			$list.append(`<li><span class="text-muted">${__("No platforms reported")}</span></li>`);
		}

		const running = !!status.gateway_running;
		dialog.$wrapper.find('[data-gw-action="start"]').prop("disabled", running);
		dialog.$wrapper.find('[data-gw-action="stop"]').prop("disabled", !running);
		dialog.$wrapper
			.find('[data-gw-action="drain"]')
			.prop("disabled", !running || !status.gateway_drainable);
	};

	const load_status = () =>
		frappe
			.call({
				method: "opsai.api.get_hermes_gateway_status",
				args: { user: frm.doc.user || frm.doc.name },
			})
			.then((r) => {
				const status = r.message || {};
				frm._opsai_gateway_status = status;
				render_status(status);
				refresh_hermes_gateway_tile(frm);
				return status;
			})
			.catch((err) => {
				render_status({ ok: false, message: err?.message || __("Could not read status") });
			});

	dialog.$wrapper.find(".opsai-gateway-refresh").on("click", () => {
		append_restart_log(dialog, state, __("→ Refresh status"));
		load_status();
	});

	dialog.$wrapper.find("[data-gw-action]").on("click", function () {
		const action = $(this).data("gw-action");
		const labels = {
			start: __("Start the Hermes gateway now?"),
			stop: __("Stop the Hermes gateway now? Active chats will disconnect."),
			restart: __(
				"Restart the Hermes gateway now? Active chats may disconnect briefly while it comes back."
			),
			drain: __("Drain the Hermes gateway (finish in-flight work, refuse new work)?"),
		};
		frappe.confirm(labels[action] || __("Run gateway action {0}?", [action]), () => {
			run_hermes_gateway_action(frm, dialog, state, action, load_status);
		});
	});

	load_status();
}

function run_hermes_gateway_action(frm, dialog, state, action, on_done) {
	if (!state.alive) return;
	state.attempt = 0;
	state.action_name = "";
	append_restart_log(dialog, state, __("→ {0} requested", [action]));
	set_restart_dialog_status(dialog, "orange", __(action), __("Sending to Hermes…"));

	frappe
		.call({
			method: "opsai.api.hermes_gateway_action",
			args: { action, user: frm.doc.user || frm.doc.name },
		})
		.then((r) => {
			if (!state.alive) return;
			const result = r.message || {};
			if (!result.ok) {
				set_restart_dialog_status(
					dialog,
					"red",
					__("Failed"),
					result.message || __("Action failed")
				);
				append_restart_log(dialog, state, __("✗ {0}", [result.message || __("Failed")]));
				on_done && on_done();
				return;
			}
			state.action_name = result.name || `gateway-${action}`;
			append_restart_log(
				dialog,
				state,
				__("→ {0}{1}", [
					result.message || action,
					result.pid != null ? ` (pid ${result.pid})` : "",
				])
			);
			poll_gateway_action(frm, dialog, state, on_done);
		})
		.catch((err) => {
			if (!state.alive) return;
			const msg = err?.message || __("Action failed");
			set_restart_dialog_status(dialog, "red", __("Failed"), msg);
			append_restart_log(dialog, state, __("✗ {0}", [msg]));
			on_done && on_done();
		});
}

function open_hermes_model_dialog(frm) {
	const dialog = new frappe.ui.Dialog({
		title: __("Change default model"),
		size: "large",
		fields: [
			{
				fieldtype: "HTML",
				fieldname: "hint",
				options: `<p class="text-muted" style="margin:0 0 8px">${__(
					"Pick a Hermes provider and model, then Apply to Hermes. Same idea as editing SOUL.md — change here, write to Hermes."
				)}</p>`,
			},
			{
				fieldname: "default_provider",
				fieldtype: "Autocomplete",
				label: __("Default Provider"),
				default: frm.doc.default_provider || "",
				reqd: 0,
				options: [],
			},
			{
				fieldname: "default_model",
				fieldtype: "Autocomplete",
				label: __("Default Model"),
				default: frm.doc.default_model || "",
				reqd: 1,
				options: [],
			},
			{
				fieldtype: "HTML",
				fieldname: "actions_html",
				options: `<div class="opsai-model-actions">
					<button type="button" class="btn btn-default btn-sm opsai-refresh-models">
						${opsai_icon("refresh-cw", "xs")} ${__("Refresh models")}
					</button>
				</div>`,
			},
		],
		primary_action_label: __("Apply to Hermes"),
		primary_action() {
			const provider = (dialog.get_value("default_provider") || "").trim();
			const model = (dialog.get_value("default_model") || "").trim();
			if (!model) {
				frappe.show_alert({ message: __("Pick a Default Model first"), indicator: "orange" });
				return;
			}
			Promise.resolve()
				.then(() => {
					const updates = {};
					if (provider !== (frm.doc.default_provider || "")) updates.default_provider = provider;
					if (model !== (frm.doc.default_model || "")) updates.default_model = model;
					return Object.keys(updates).length ? frm.set_value(updates) : null;
				})
				.then(() => apply_default_model(frm, false, dialog));
		},
		secondary_action_label: __("Close"),
		secondary_action() {
			dialog.hide();
		},
	});

	dialog.$wrapper.addClass("opsai-model-dialog");
	dialog.show();

	dialog.$wrapper.find(".opsai-refresh-models").on("click", () => {
		load_hermes_models(frm, true, dialog);
	});

	dialog.fields_dict.default_provider.df.onchange = () => {
		apply_model_autocomplete(frm, frm._opsai_model_catalog, dialog);
	};

	load_hermes_models(frm, false, dialog).then(() => {
		dialog.set_values({
			default_provider: frm.doc.default_provider || "",
			default_model: frm.doc.default_model || "",
		});
	});
}

function open_hermes_file_editor(frm, kind) {
	if (kind === "env") {
		open_hermes_env_editor(frm);
		return;
	}
	if (kind === "memory" || kind === "user_md") {
		open_hermes_memory_editor(frm, kind);
		return;
	}
	if (kind === "soul") {
		open_hermes_text_file_editor(frm, kind);
		return;
	}

	const meta = {
		config: {
			title: __("Edit config.yaml"),
			options: "YAML",
			hint: __("Hermes config.yaml — full replace on save"),
		},
	}[kind];
	if (!meta) return;

	const state = { profile: "", path: "" };
	const dialog = new frappe.ui.Dialog({
		title: meta.title,
		size: "extra-large",
		fields: [
			{
				fieldname: "hint",
				fieldtype: "HTML",
				options: `<p class="text-muted" style="margin:0 0 8px">${frappe.utils.escape_html(
					meta.hint
				)}</p><p class="opsai-file-path text-muted" style="margin:0 0 8px;font-size:12px"></p>`,
			},
			{
				fieldname: "content",
				fieldtype: "Code",
				label: __("Content"),
				options: meta.options,
				reqd: 1,
			},
		],
		primary_action_label: __("Save to Hermes"),
		primary_action(values) {
			save_hermes_file_dialog(frm, kind, dialog, state, values.content || "");
		},
		secondary_action_label: __("Reload"),
		secondary_action() {
			load_hermes_file_into_dialog(frm, kind, dialog, state);
		},
	});

	dialog.show();
	load_hermes_file_into_dialog(frm, kind, dialog, state);
}

const HERMES_TEXT_FILES = {
	soul: {
		title: __("Edit SOUL.md"),
		label: "SOUL.md",
		fallback_hint: __("Agent identity (SOUL.md). Word wrap is on — edit freely, then Save to Hermes."),
	},
};

const HERMES_MEMORY_FILES = {
	memory: {
		title: __("Edit MEMORY.md"),
		label: "MEMORY.md",
		hint: __(
			"Hermes Memory Tool actions: Add, Save (patch), Delete (remove). Entries are §-delimited on disk; budget is shared. Applies on next session start."
		),
	},
	user_md: {
		title: __("Edit USER.md"),
		label: "USER.md",
		hint: __(
			"Hermes Memory Tool actions (target=user): Add, Save (patch), Delete (remove). Entries are §-delimited on disk. Applies on next session start."
		),
	},
};

const HERMES_MEMORY_DELIMITER = "\n§\n";

function open_hermes_memory_editor(frm, kind) {
	const meta = HERMES_MEMORY_FILES[kind];
	if (!meta) return;

	const state = {
		profile: "",
		path: "",
		char_limit: kind === "user_md" ? 1375 : 2200,
		entries: [],
		delimiter: HERMES_MEMORY_DELIMITER,
	};

	const dialog = new frappe.ui.Dialog({
		title: meta.title,
		size: "extra-large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<p class="text-muted opsai-memory-hint" style="margin:0 0 8px">${frappe.utils.escape_html(
					meta.hint
				)}</p>
				<p class="opsai-file-path text-muted" style="margin:0 0 8px;font-size:12px"></p>
				<div class="opsai-memory-budget">
					<span class="opsai-char-note">${__("Hermes character budget.")}</span>
					<span class="opsai-char-stats"></span>
				</div>
				<div class="opsai-memory-editor"></div>
				<div class="opsai-memory-add">
					<textarea class="form-control opsai-memory-new" wrap="soft" spellcheck="true"
						placeholder="${__("New entry…")}"></textarea>
					<button type="button" class="btn btn-primary btn-sm opsai-memory-add-btn">${__(
						"Add & Save"
					)}</button>
				</div>`,
			},
		],
		primary_action_label: __("Reload"),
		primary_action() {
			load_hermes_memory_entries(frm, kind, dialog, state);
		},
	});

	dialog.$wrapper.find(".opsai-memory-add-btn").on("click", () => {
		const value = (dialog.$wrapper.find(".opsai-memory-new").val() || "").trim();
		if (!value) {
			frappe.show_alert({ message: __("Enter entry text"), indicator: "orange" });
			return;
		}
		run_hermes_memory_action(frm, kind, dialog, state, {
			action: "add",
			content: value,
		}, () => {
			dialog.$wrapper.find(".opsai-memory-new").val("");
			load_hermes_memory_entries(frm, kind, dialog, state);
		});
	});
	dialog.$wrapper.find(".opsai-memory-new").on("input", () => update_hermes_memory_budget(dialog, state));

	dialog.show();
	load_hermes_memory_entries(frm, kind, dialog, state);
}

function collect_hermes_memory_entries(dialog) {
	const entries = [];
	dialog.$wrapper.find(".opsai-memory-row textarea.opsai-memory-value").each(function () {
		const text = ($(this).val() || "").trim();
		if (text) entries.push(text);
	});
	return entries;
}

function draft_hermes_memory_content(dialog, state) {
	const entries = collect_hermes_memory_entries(dialog);
	const draft_new = (dialog.$wrapper.find(".opsai-memory-new").val() || "").trim();
	if (draft_new) entries.push(draft_new);
	const delim = state.delimiter || HERMES_MEMORY_DELIMITER;
	return entries.length ? entries.join(delim) : "";
}

function update_hermes_memory_budget(dialog, state) {
	const $budget = dialog.$wrapper.find(".opsai-memory-budget");
	const limit = state.char_limit || 0;
	if (!limit) {
		$budget.hide();
		return;
	}
	const used = draft_hermes_memory_content(dialog, state).length;
	const available = Math.max(0, limit - used);
	const pct = used / limit;
	$budget
		.show()
		.removeClass("near full over")
		.addClass(used > limit ? "over" : used >= limit ? "full" : pct >= 0.85 ? "near" : "");
	$budget.find(".opsai-char-note").text(
		used >= limit
			? __("Limit reached — shorten or remove an entry.")
			: pct >= 0.85
				? __("Approaching Hermes limit.")
				: __("Hermes character budget (all entries + § separators).")
	);
	$budget
		.find(".opsai-char-stats")
		.text(__("{0} used · {1} available · {2} limit", [used, available, limit]));
}

function load_hermes_memory_entries(frm, kind, dialog, state) {
	frappe
		.call({
			method: "opsai.api.get_hermes_file",
			args: { kind, user: frm.doc.user || frm.doc.name },
			freeze: true,
			freeze_message: __("Loading from Hermes…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({
					message: result.message || __("Could not load file"),
					indicator: "red",
				});
				return;
			}
			state.profile = result.profile || "";
			state.path = result.path || "";
			state.char_limit = result.char_limit || state.char_limit;
			state.delimiter = result.delimiter || HERMES_MEMORY_DELIMITER;
			state.entries = result.entries || [];
			if (result.hint) {
				dialog.$wrapper.find(".opsai-memory-hint").text(result.hint);
			}
			dialog.$wrapper
				.find(".opsai-file-path")
				.text(
					[result.path, result.profile ? `profile: ${result.profile}` : ""]
						.filter(Boolean)
						.join(" · ")
				);
			render_hermes_memory_rows(frm, kind, dialog, state);
			update_hermes_memory_budget(dialog, state);
			frappe.show_alert({
				message: __("Loaded {0} entries from Hermes", [state.entries.length]),
				indicator: "green",
			});
		})
		.catch((err) => {
			frappe.show_alert({
				message: err?.message || __("Could not load file"),
				indicator: "red",
			});
		});
}

function render_hermes_memory_rows(frm, kind, dialog, state) {
	const $list = dialog.$wrapper.find(".opsai-memory-editor").empty();
	if (!state.entries.length) {
		$list.append(
			`<p class="text-muted" style="margin:8px">${__("No entries yet — add one below.")}</p>`
		);
		return;
	}

	state.entries.forEach((entry, index) => {
		const original = entry || "";
		const $row = $(`<div class="opsai-memory-row" data-index="${index}">
			<div class="opsai-memory-index">#${index + 1}</div>
			<textarea class="form-control opsai-memory-value" wrap="soft" spellcheck="true"></textarea>
			<div class="opsai-memory-actions">
				<button type="button" class="btn btn-primary btn-xs opsai-memory-save">${__("Save")}</button>
				<button type="button" class="btn btn-danger btn-xs opsai-memory-delete">${__("Delete")}</button>
			</div>
		</div>`);
		$row.data("original", original);
		$row.find("textarea").val(original);
		$row.find("textarea").on("input", () => update_hermes_memory_budget(dialog, state));

		$row.find(".opsai-memory-save").on("click", () => {
			const value = ($row.find("textarea").val() || "").trim();
			const prev = $row.data("original") || "";
			if (!value) {
				frappe.show_alert({
					message: __("Entry cannot be empty — use Delete to remove it."),
					indicator: "orange",
				});
				return;
			}
			if (value === prev) {
				frappe.show_alert({ message: __("No changes"), indicator: "blue" });
				return;
			}
			// Hermes Memory Tool: whole-entry rewrite via patch(old_text=entry, content=new).
			run_hermes_memory_action(frm, kind, dialog, state, {
				action: "patch",
				old_text: prev,
				content: value,
			}, () => load_hermes_memory_entries(frm, kind, dialog, state));
		});

		$row.find(".opsai-memory-delete").on("click", () => {
			frappe.confirm(__("Delete entry #{0}?", [index + 1]), () => {
				run_hermes_memory_action(frm, kind, dialog, state, {
					action: "remove",
					old_text: $row.data("original") || "",
				}, () => load_hermes_memory_entries(frm, kind, dialog, state));
			});
		});

		$list.append($row);
	});
}

function run_hermes_memory_action(frm, kind, dialog, state, payload, on_ok) {
	const action = (payload && payload.action) || "";
	frappe
		.call({
			method: "opsai.api.hermes_memory_action",
			args: {
				kind,
				action,
				content: payload.content,
				old_text: payload.old_text,
				user: frm.doc.user || frm.doc.name,
				profile: state.profile || undefined,
			},
			freeze: true,
			freeze_message:
				action === "remove"
					? __("Removing entry…")
					: action === "add"
						? __("Adding entry…")
						: __("Patching entry…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({
					message: result.message || __("Memory action failed"),
					indicator: "red",
				});
				if (typeof result.chars === "number") {
					state.char_limit = result.char_limit || state.char_limit;
					update_hermes_memory_budget(dialog, state);
				}
				return;
			}
			frappe.show_alert({
				message: result.message || __("Saved to Hermes"),
				indicator: "green",
			});
			on_ok && on_ok(result);
		})
		.catch((err) => {
			frappe.show_alert({
				message: err?.message || __("Memory action failed"),
				indicator: "red",
			});
		});
}

function open_hermes_text_file_editor(frm, kind) {
	const meta = HERMES_TEXT_FILES[kind];
	if (!meta) return;

	const state = { profile: "", path: "", char_limit: null, enforce_limit: false };
	const ta_id = `opsai-text-${kind}`;
	const dialog = new frappe.ui.Dialog({
		title: meta.title,
		size: "extra-large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<p class="opsai-text-hint text-muted" style="margin:0 0 8px">${frappe.utils.escape_html(
					meta.fallback_hint
				)}</p>
				<p class="opsai-file-path text-muted" style="margin:0 0 12px;font-size:12px"></p>
				<label class="opsai-soul-label" for="${ta_id}">${frappe.utils.escape_html(
					meta.label
				)} <span class="reqd">*</span></label>
				<textarea id="${ta_id}" class="form-control opsai-soul-textarea" wrap="soft"
					spellcheck="true" autocomplete="off"></textarea>
				<div class="opsai-char-count" style="display:none">
					<span class="opsai-char-note"></span>
					<span class="opsai-char-stats"></span>
				</div>`,
			},
		],
		primary_action_label: __("Save to Hermes"),
		primary_action() {
			enforce_hermes_char_limit(dialog, state, true);
			const content = dialog.$wrapper.find(".opsai-soul-textarea").val() || "";
			const limit = state.char_limit;
			if (limit && content.length > limit) {
				frappe.show_alert({
					message: __("Over the Hermes limit ({0}/{1}). Shorten the text before saving.", [
						content.length,
						limit,
					]),
					indicator: "orange",
				});
				return;
			}
			save_hermes_file_dialog(frm, kind, dialog, state, content, () =>
				load_hermes_text_file_into_dialog(frm, kind, dialog, state)
			);
		},
		secondary_action_label: __("Reload"),
		secondary_action() {
			load_hermes_text_file_into_dialog(frm, kind, dialog, state);
		},
	});

	dialog.$wrapper.addClass("opsai-soul-editor");
	dialog.show();

	const $ta = dialog.$wrapper.find(".opsai-soul-textarea");
	$ta.on("input", () => {
		enforce_hermes_char_limit(dialog, state, true);
		update_hermes_char_count(dialog, state);
	});
	$ta.on("paste", () => {
		// After the paste lands, trim to the Hermes cap.
		setTimeout(() => {
			enforce_hermes_char_limit(dialog, state, true);
			update_hermes_char_count(dialog, state);
		}, 0);
	});

	load_hermes_text_file_into_dialog(frm, kind, dialog, state);
}

function enforce_hermes_char_limit(dialog, state, truncate) {
	const limit = state.char_limit;
	if (!limit || !state.enforce_limit) return false;
	const $ta = dialog.$wrapper.find(".opsai-soul-textarea");
	const value = $ta.val() || "";
	if (value.length <= limit) return false;
	if (!truncate) return true;
	const start = $ta[0]?.selectionStart;
	$ta.val(value.slice(0, limit));
	if (typeof start === "number" && $ta[0]) {
		const pos = Math.min(start, limit);
		$ta[0].setSelectionRange(pos, pos);
	}
	frappe.show_alert({
		message: __("Hermes limit is {0} characters — extra text was trimmed.", [limit]),
		indicator: "orange",
	});
	return true;
}

function update_hermes_char_count(dialog, state) {
	const $count = dialog.$wrapper.find(".opsai-char-count");
	const limit = state.char_limit;
	if (!limit) {
		$count.hide();
		return;
	}
	const used = (dialog.$wrapper.find(".opsai-soul-textarea").val() || "").length;
	const available = Math.max(0, limit - used);
	const pct = limit ? used / limit : 0;
	$count
		.show()
		.removeClass("near full over")
		.addClass(used > limit ? "over" : used >= limit ? "full" : pct >= 0.85 ? "near" : "");
	$count.find(".opsai-char-note").text(
		used >= limit
			? __("Limit reached — remove text to free space.")
			: pct >= 0.85
				? __("Approaching Hermes limit.")
				: __("Hermes character budget.")
	);
	$count
		.find(".opsai-char-stats")
		.text(
			__("{0} used · {1} available · {2} limit", [used, available, limit])
		);
}

function load_hermes_text_file_into_dialog(frm, kind, dialog, state) {
	frappe
		.call({
			method: "opsai.api.get_hermes_file",
			args: {
				kind,
				user: frm.doc.user || frm.doc.name,
			},
			freeze: true,
			freeze_message: __("Loading from Hermes…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({
					message: result.message || __("Could not load file"),
					indicator: "red",
				});
				return;
			}
			state.profile = result.profile || "";
			state.path = result.path || "";
			state.char_limit = result.char_limit || null;
			state.enforce_limit = Boolean(result.char_limit);
			if (result.hint) {
				dialog.$wrapper.find(".opsai-text-hint").text(result.hint);
			}
			const $ta = dialog.$wrapper.find(".opsai-soul-textarea");
			let content = result.content || "";
			if (state.char_limit && content.length > state.char_limit) {
				// Keep load visible, but clamp for editing so Save stays within Hermes rules.
				frappe.show_alert({
					message: __(
						"File is already over the Hermes limit ({0}/{1}). Editor is capped — trim before saving.",
						[content.length, state.char_limit]
					),
					indicator: "orange",
				});
				content = content.slice(0, state.char_limit);
			}
			$ta.val(content);
			if (state.char_limit) {
				$ta.attr("maxlength", state.char_limit);
			} else {
				$ta.removeAttr("maxlength");
			}
			dialog.$wrapper
				.find(".opsai-file-path")
				.text(
					[result.path, result.profile ? `profile: ${result.profile}` : ""]
						.filter(Boolean)
						.join(" · ")
				);
			update_hermes_char_count(dialog, state);
			if (!(state.char_limit && (result.content || "").length > state.char_limit)) {
				frappe.show_alert({ message: __("Loaded from Hermes"), indicator: "green" });
			}
		})
		.catch((err) => {
			frappe.show_alert({
				message: err?.message || __("Could not load file"),
				indicator: "red",
			});
		});
}

function open_hermes_manage(frm, which) {
	if (which === "skills") return open_hermes_skills_manager(frm);
	if (which === "cron") return open_hermes_cron_manager(frm);
	if (which === "sessions") return open_hermes_sessions_manager(frm);
	if (which === "logs") return open_hermes_logs_viewer(frm);
}

function open_hermes_env_editor(frm) {
	const state = { profile: "", rows: [] };
	const dialog = new frappe.ui.Dialog({
		title: __("Edit .env"),
		size: "extra-large",
		fields: [
			{
				fieldname: "hint",
				fieldtype: "HTML",
				options: `<p class="text-muted" style="margin:0 0 8px">${__(
					"Each key has its own Reveal and Save. Values stay in the browser and are not stored in Frappe."
				)}</p><p class="opsai-file-path text-muted" style="margin:0 0 8px;font-size:12px"></p>
				<div class="opsai-env-editor"></div>
				<div class="opsai-env-add">
					<input type="text" class="form-control opsai-env-new-key" placeholder="${__(
						"NEW_KEY"
					)}" spellcheck="false" />
					<input type="text" class="form-control opsai-env-new-value" placeholder="${__(
						"value"
					)}" spellcheck="false" />
					<button type="button" class="btn btn-primary btn-sm opsai-env-add-btn">${__("Add & Save")}</button>
				</div>`,
			},
		],
		primary_action_label: __("Reload"),
		primary_action() {
			load_hermes_env_rows(frm, dialog, state);
		},
	});

	dialog.$wrapper.find(".opsai-env-add-btn").on("click", () => {
		const key = (dialog.$wrapper.find(".opsai-env-new-key").val() || "").trim();
		const value = dialog.$wrapper.find(".opsai-env-new-value").val() || "";
		if (!key) {
			frappe.show_alert({ message: __("Enter a key name"), indicator: "orange" });
			return;
		}
		save_hermes_env_row(frm, dialog, state, key, value, () => {
			dialog.$wrapper.find(".opsai-env-new-key, .opsai-env-new-value").val("");
			load_hermes_env_rows(frm, dialog, state);
		});
	});

	dialog.show();
	load_hermes_env_rows(frm, dialog, state);
}

function load_hermes_env_rows(frm, dialog, state) {
	frappe
		.call({
			method: "opsai.api.get_hermes_file",
			args: { kind: "env", user: frm.doc.user || frm.doc.name },
			freeze: true,
			freeze_message: __("Loading .env from Hermes…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({
					message: result.message || __("Could not load .env"),
					indicator: "red",
				});
				return;
			}
			state.profile = result.profile || "";
			state.rows = result.rows || [];
			dialog.$wrapper
				.find(".opsai-file-path")
				.text(
					[result.path || ".env", state.profile ? `profile: ${state.profile}` : ""]
						.filter(Boolean)
						.join(" · ")
				);
			render_hermes_env_rows(frm, dialog, state);
			frappe.show_alert({
				message: __("Loaded {0} keys from Hermes", [state.rows.length]),
				indicator: "green",
			});
		})
		.catch((err) => {
			frappe.show_alert({
				message: err?.message || __("Could not load .env"),
				indicator: "red",
			});
		});
}

function render_hermes_env_rows(frm, dialog, state) {
	const $list = dialog.$wrapper.find(".opsai-env-editor").empty();
	if (!state.rows.length) {
		$list.append(
			`<p class="text-muted" style="margin:8px">${__("No set keys in Hermes .env yet.")}</p>`
		);
		return;
	}

	state.rows.forEach((row) => {
		const key = row.key;
		const meta = [row.category, row.description].filter(Boolean).join(" — ");
		const $row = $(`<div class="opsai-env-row" data-key="${frappe.utils.escape_html(key)}">
			<div>
				<div class="opsai-env-key">${frappe.utils.escape_html(key)}</div>
				${meta ? `<div class="opsai-env-meta">${frappe.utils.escape_html(meta)}</div>` : ""}
			</div>
			<input type="text" class="form-control opsai-env-value" spellcheck="false"
				value="${frappe.utils.escape_html(row.preview || "")}"
				placeholder="${row.is_password ? __("Redacted — Reveal or paste a new value") : ""}" />
			<div class="opsai-env-actions">
				<button type="button" class="btn btn-default btn-xs opsai-env-reveal">${__("Reveal")}</button>
				<button type="button" class="btn btn-primary btn-xs opsai-env-save">${__("Save")}</button>
				<button type="button" class="btn btn-danger btn-xs opsai-env-delete">${__("Delete")}</button>
			</div>
		</div>`);

		$row.data("preview", row.preview || "");
		$row.data("revealed", false);

		$row.find(".opsai-env-reveal").on("click", () => {
			const $btn = $row.find(".opsai-env-reveal").prop("disabled", true).text(__("…"));
			frappe
				.call({
					method: "opsai.api.reveal_hermes_env_var",
					args: {
						key,
						user: frm.doc.user || frm.doc.name,
						profile: state.profile || undefined,
					},
				})
				.then((r) => {
					const result = r.message || {};
					if (!result.ok) {
						frappe.show_alert({
							message: result.message || __("Reveal failed"),
							indicator: "orange",
						});
						return;
					}
					$row.find(".opsai-env-value").val(result.value || "");
					$row.data("preview", result.value || "");
					$row.data("revealed", true);
					frappe.show_alert({
						message: result.message || __("Revealed"),
						indicator: "green",
					});
				})
				.catch((err) => {
					frappe.show_alert({
						message: err?.message || __("Reveal failed"),
						indicator: "red",
					});
				})
				.finally(() => $btn.prop("disabled", false).text(__("Reveal")));
		});

		$row.find(".opsai-env-save").on("click", () => {
			const value = $row.find(".opsai-env-value").val() || "";
			const preview = $row.data("preview") || "";
			if (value === preview && !$row.data("revealed")) {
				// Still the redacted preview — refuse silent no-op that Hermes would reject.
				frappe.show_alert({
					message: __(
						"Reveal first, or paste a new value, then Save. Redacted previews cannot be written back."
					),
					indicator: "orange",
				});
				return;
			}
			save_hermes_env_row(frm, dialog, state, key, value, (savedPreview) => {
				$row.data("preview", savedPreview != null ? savedPreview : value);
				$row.data("revealed", true);
			});
		});

		$row.find(".opsai-env-delete").on("click", () => {
			frappe.confirm(__("Delete {0} from Hermes .env?", [key]), () => {
				frappe
					.call({
						method: "opsai.api.delete_hermes_env_var",
						args: {
							key,
							user: frm.doc.user || frm.doc.name,
							profile: state.profile || undefined,
						},
						freeze: true,
						freeze_message: __("Deleting…"),
					})
					.then((r) => {
						const result = r.message || {};
						if (!result.ok) {
							frappe.show_alert({
								message: result.message || __("Delete failed"),
								indicator: "red",
							});
							return;
						}
						frappe.show_alert({
							message: result.message || __("Deleted"),
							indicator: "green",
						});
						load_hermes_env_rows(frm, dialog, state);
					})
					.catch((err) => {
						frappe.show_alert({
							message: err?.message || __("Delete failed"),
							indicator: "red",
						});
					});
			});
		});

		$list.append($row);
	});
}

function save_hermes_env_row(frm, dialog, state, key, value, on_ok) {
	frappe
		.call({
			method: "opsai.api.save_hermes_env_var",
			args: {
				key,
				value,
				user: frm.doc.user || frm.doc.name,
				profile: state.profile || undefined,
			},
			freeze: true,
			freeze_message: __("Saving {0}…", [key]),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({
					message: result.message || __("Save failed"),
					indicator: "red",
				});
				return;
			}
			frappe.show_alert({
				message: result.message || __("Saved"),
				indicator: "green",
			});
			on_ok && on_ok(value);
		})
		.catch((err) => {
			frappe.show_alert({
				message: err?.message || __("Save failed"),
				indicator: "red",
			});
		});
}

function load_hermes_file_into_dialog(frm, kind, dialog, state) {
	frappe
		.call({
			method: "opsai.api.get_hermes_file",
			args: {
				kind,
				user: frm.doc.user || frm.doc.name,
			},
			freeze: true,
			freeze_message: __("Loading from Hermes…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({
					message: result.message || __("Could not load file"),
					indicator: "red",
				});
				return;
			}
			state.profile = result.profile || "";
			state.path = result.path || "";
			dialog.set_value("content", result.content || "");
			dialog.$wrapper
				.find(".opsai-file-path")
				.text(
					[result.path, result.profile ? `profile: ${result.profile}` : ""]
						.filter(Boolean)
						.join(" · ")
				);
			frappe.show_alert({ message: __("Loaded from Hermes"), indicator: "green" });
		})
		.catch((err) => {
			frappe.show_alert({
				message: err?.message || __("Could not load file"),
				indicator: "red",
			});
		});
}

function save_hermes_file_dialog(frm, kind, dialog, state, content, on_ok) {
	frappe
		.call({
			method: "opsai.api.save_hermes_file",
			args: {
				kind,
				content,
				user: frm.doc.user || frm.doc.name,
				profile: state.profile || undefined,
			},
			freeze: true,
			freeze_message: __("Saving to Hermes…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({
					message: result.message || __("Save failed"),
					indicator: "red",
				});
				return;
			}
			frappe.show_alert({
				message: result.message || __("Saved to Hermes"),
				indicator: "green",
			});
			if (typeof on_ok === "function") {
				on_ok(result);
			} else {
				load_hermes_file_into_dialog(frm, kind, dialog, state);
			}
		})
		.catch((err) => {
			frappe.show_alert({
				message: err?.message || __("Save failed"),
				indicator: "red",
			});
		});
}

function open_hermes_skills_manager(frm) {
	const state = { profile: "", skills: [] };
	const dialog = new frappe.ui.Dialog({
		title: __("Hermes skills"),
		size: "extra-large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<p class="text-muted" style="margin:0 0 8px">${__(
					"Enable or disable installed Hermes skills. Nothing is stored in Frappe."
				)}</p>
				<div class="opsai-manage-toolbar">
					<input type="search" class="form-control input-sm opsai-skills-filter" style="max-width:260px"
						placeholder="${__("Filter skills…")}" />
					<span class="text-muted opsai-skills-count" style="font-size:12px"></span>
				</div>
				<div class="opsai-manage-list opsai-skills-list"></div>`,
			},
		],
		primary_action_label: __("Reload"),
		primary_action() {
			load_hermes_skills(frm, dialog, state);
		},
	});
	dialog.show();
	dialog.$wrapper.find(".opsai-skills-filter").on("input", () => render_hermes_skills(frm, dialog, state));
	load_hermes_skills(frm, dialog, state);
}

function load_hermes_skills(frm, dialog, state) {
	frappe
		.call({
			method: "opsai.api.list_hermes_skills",
			args: { user: frm.doc.user || frm.doc.name },
			freeze: true,
			freeze_message: __("Loading skills…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({ message: result.message || __("Failed"), indicator: "red" });
				return;
			}
			state.profile = result.profile || "";
			state.skills = result.skills || [];
			render_hermes_skills(frm, dialog, state);
		});
}

function render_hermes_skills(frm, dialog, state) {
	const q = (dialog.$wrapper.find(".opsai-skills-filter").val() || "").trim().toLowerCase();
	const rows = (state.skills || []).filter((s) => {
		if (!q) return true;
		return (
			s.name.toLowerCase().includes(q) ||
			(s.category || "").toLowerCase().includes(q) ||
			(s.description || "").toLowerCase().includes(q)
		);
	});
	dialog.$wrapper.find(".opsai-skills-count").text(__("{0} shown", [rows.length]));
	const $list = dialog.$wrapper.find(".opsai-skills-list").empty();
	if (!rows.length) {
		$list.append(`<p class="text-muted" style="padding:12px">${__("No skills match.")}</p>`);
		return;
	}
	rows.forEach((skill) => {
		const $row = $(`<div class="opsai-manage-row">
			<div>
				<div class="opsai-manage-title">${frappe.utils.escape_html(skill.name)}</div>
				<div class="opsai-manage-meta">${frappe.utils.escape_html(
					[skill.category, skill.description].filter(Boolean).join(" — ")
				)}</div>
			</div>
			<div class="opsai-manage-actions">
				<button type="button" class="btn btn-xs ${
					skill.enabled ? "btn-default" : "btn-primary"
				} opsai-skill-toggle">
					${skill.enabled ? __("Disable") : __("Enable")}
				</button>
			</div>
		</div>`);
		$row.find(".opsai-skill-toggle").on("click", () => {
			frappe
				.call({
					method: "opsai.api.toggle_hermes_skill",
					args: {
						name: skill.name,
						enabled: skill.enabled ? 0 : 1,
						user: frm.doc.user || frm.doc.name,
						profile: state.profile || undefined,
					},
					freeze: true,
				})
				.then((r) => {
					const result = r.message || {};
					frappe.show_alert({
						message: result.message || (result.ok ? __("Updated") : __("Failed")),
						indicator: result.ok ? "green" : "red",
					});
					if (result.ok) load_hermes_skills(frm, dialog, state);
				});
		});
		$list.append($row);
	});
}

function open_hermes_cron_manager(frm) {
	const state = { profile: "all", jobs: [] };
	const dialog = new frappe.ui.Dialog({
		title: __("Hermes cron"),
		size: "extra-large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<p class="text-muted" style="margin:0 0 8px">${__(
					"Pause, resume, trigger, or delete cron jobs on Hermes."
				)}</p>
				<div class="opsai-manage-list opsai-cron-list"></div>`,
			},
		],
		primary_action_label: __("Reload"),
		primary_action() {
			load_hermes_cron(frm, dialog, state);
		},
	});
	dialog.show();
	load_hermes_cron(frm, dialog, state);
}

function load_hermes_cron(frm, dialog, state) {
	frappe
		.call({
			method: "opsai.api.list_hermes_cron_jobs",
			args: { user: frm.doc.user || frm.doc.name, profile: "all" },
			freeze: true,
			freeze_message: __("Loading cron jobs…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({ message: result.message || __("Failed"), indicator: "red" });
				return;
			}
			state.jobs = result.jobs || [];
			const $list = dialog.$wrapper.find(".opsai-cron-list").empty();
			if (!state.jobs.length) {
				$list.append(`<p class="text-muted" style="padding:12px">${__("No cron jobs.")}</p>`);
				return;
			}
			state.jobs.forEach((job) => {
				const $row = $(`<div class="opsai-manage-row">
					<div>
						<div class="opsai-manage-title">${frappe.utils.escape_html(job.name)}</div>
						<div class="opsai-manage-meta">${frappe.utils.escape_html(
							[
								job.schedule,
								job.state || (job.enabled ? __("enabled") : __("paused")),
								job.model,
							]
								.filter(Boolean)
								.join(" · ")
						)}</div>
						<div class="opsai-manage-meta">${frappe.utils.escape_html(job.prompt || "")}</div>
					</div>
					<div class="opsai-manage-actions">
						<button type="button" class="btn btn-default btn-xs" data-act="pause">${__("Pause")}</button>
						<button type="button" class="btn btn-default btn-xs" data-act="resume">${__("Resume")}</button>
						<button type="button" class="btn btn-primary btn-xs" data-act="trigger">${__("Run now")}</button>
						<button type="button" class="btn btn-danger btn-xs" data-act="delete">${__("Delete")}</button>
					</div>
				</div>`);
				$row.find("[data-act]").on("click", function () {
					const action = $(this).data("act");
					const go = () =>
						frappe
							.call({
								method: "opsai.api.hermes_cron_action",
								args: {
									job_id: job.id,
									action,
									user: frm.doc.user || frm.doc.name,
								},
								freeze: true,
							})
							.then((res) => {
								const out = res.message || {};
								frappe.show_alert({
									message: out.message || (out.ok ? __("Done") : __("Failed")),
									indicator: out.ok ? "green" : "red",
								});
								if (out.ok) load_hermes_cron(frm, dialog, state);
							});
					if (action === "delete") {
						frappe.confirm(__("Delete cron job {0}?", [job.name]), go);
					} else {
						go();
					}
				});
				$list.append($row);
			});
		});
}

function open_hermes_sessions_manager(frm) {
	const state = { sessions: [] };
	const dialog = new frappe.ui.Dialog({
		title: __("Hermes sessions"),
		size: "extra-large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<p class="text-muted" style="margin:0 0 8px">${__(
					"Recent Hermes gateway sessions. Delete may be refused while the gateway holds the store."
				)}</p>
				<div class="opsai-manage-list opsai-sessions-list"></div>`,
			},
		],
		primary_action_label: __("Reload"),
		primary_action() {
			load_hermes_manage_sessions(frm, dialog, state);
		},
	});
	dialog.show();
	load_hermes_manage_sessions(frm, dialog, state);
}

function load_hermes_manage_sessions(frm, dialog, state) {
	frappe
		.call({
			method: "opsai.api.list_hermes_manage_sessions",
			args: { user: frm.doc.user || frm.doc.name, limit: 40 },
			freeze: true,
			freeze_message: __("Loading sessions…"),
		})
		.then((r) => {
			const result = r.message || {};
			if (!result.ok) {
				frappe.show_alert({ message: result.message || __("Failed"), indicator: "red" });
				return;
			}
			state.sessions = result.sessions || [];
			const $list = dialog.$wrapper.find(".opsai-sessions-list").empty();
			if (!state.sessions.length) {
				$list.append(`<p class="text-muted" style="padding:12px">${__("No sessions.")}</p>`);
				return;
			}
			state.sessions.forEach((sess) => {
				const $row = $(`<div class="opsai-manage-row">
					<div>
						<div class="opsai-manage-title">${frappe.utils.escape_html(sess.title)}</div>
						<div class="opsai-manage-meta">${frappe.utils.escape_html(
							[
								sess.id,
								sess.model,
								sess.message_count != null ? `${sess.message_count} msgs` : "",
								sess.last_active || sess.started_at,
								sess.is_active ? __("active") : "",
							]
								.filter(Boolean)
								.join(" · ")
						)}</div>
						<div class="opsai-manage-meta">${frappe.utils.escape_html(sess.preview || "")}</div>
					</div>
					<div class="opsai-manage-actions">
						<button type="button" class="btn btn-danger btn-xs opsai-sess-del">${__("Delete")}</button>
					</div>
				</div>`);
				$row.find(".opsai-sess-del").on("click", () => {
					frappe.confirm(__("Delete Hermes session {0}?", [sess.title]), () => {
						frappe
							.call({
								method: "opsai.api.delete_hermes_manage_session",
								args: {
									session: sess.id,
									user: frm.doc.user || frm.doc.name,
								},
								freeze: true,
							})
							.then((res) => {
								const out = res.message || {};
								frappe.show_alert({
									message: out.message || (out.ok ? __("Deleted") : __("Failed")),
									indicator: out.ok ? "green" : "red",
								});
								if (out.ok) load_hermes_manage_sessions(frm, dialog, state);
							});
					});
				});
				$list.append($row);
			});
		});
}

function open_hermes_logs_viewer(frm) {
	const state = { file: "gateway", lines: 100 };
	const dialog = new frappe.ui.Dialog({
		title: __("Hermes logs"),
		size: "extra-large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<p class="text-muted" style="margin:0 0 8px">${__(
					"Tail Hermes log files from the gateway host."
				)}</p>
				<div class="opsai-manage-toolbar">
					<select class="form-control input-sm opsai-logs-file" style="max-width:140px">
						<option value="gateway">gateway</option>
						<option value="agent">agent</option>
						<option value="errors">errors</option>
					</select>
					<select class="form-control input-sm opsai-logs-lines" style="max-width:120px">
						<option value="50">50</option>
						<option value="100" selected>100</option>
						<option value="200">200</option>
						<option value="500">500</option>
					</select>
					<button type="button" class="btn btn-default btn-sm opsai-logs-refresh">${__("Refresh")}</button>
				</div>
				<pre class="opsai-logs-view"></pre>`,
			},
		],
		primary_action_label: __("Refresh"),
		primary_action() {
			load_hermes_logs(frm, dialog, state);
		},
	});
	dialog.show();
	dialog.$wrapper.find(".opsai-logs-file, .opsai-logs-lines").on("change", () => {
		state.file = dialog.$wrapper.find(".opsai-logs-file").val();
		state.lines = cint(dialog.$wrapper.find(".opsai-logs-lines").val()) || 100;
		load_hermes_logs(frm, dialog, state);
	});
	dialog.$wrapper.find(".opsai-logs-refresh").on("click", () => load_hermes_logs(frm, dialog, state));
	load_hermes_logs(frm, dialog, state);
}

function load_hermes_logs(frm, dialog, state) {
	state.file = dialog.$wrapper.find(".opsai-logs-file").val() || state.file;
	state.lines = cint(dialog.$wrapper.find(".opsai-logs-lines").val()) || state.lines;
	frappe
		.call({
			method: "opsai.api.get_hermes_logs",
			args: {
				file: state.file,
				lines: state.lines,
				user: frm.doc.user || frm.doc.name,
			},
			freeze: true,
			freeze_message: __("Loading logs…"),
		})
		.then((r) => {
			const result = r.message || {};
			const $view = dialog.$wrapper.find(".opsai-logs-view");
			if (!result.ok) {
				$view.text(result.message || __("Could not load logs"));
				frappe.show_alert({ message: result.message || __("Failed"), indicator: "red" });
				return;
			}
			$view.text((result.lines || []).join("\n") || __("(empty)"));
		});
}

function restart_hermes_gateway(frm) {
	frappe.confirm(
		__(
			"Restart the Hermes gateway now? Active chats may disconnect briefly while it comes back."
		),
		() => open_hermes_gateway_restart_dialog(frm)
	);
}

function open_hermes_gateway_restart_dialog(frm) {
	const state = {
		alive: true,
		lines: [],
		timer: null,
		attempt: 0,
		max_attempts: 40,
	};

	const dialog = new frappe.ui.Dialog({
		title: __("Restart Hermes Gateway"),
		size: "large",
		fields: [
			{
				fieldname: "body",
				fieldtype: "HTML",
				options: `<div class="opsai-restart-status">
					<span class="indicator-pill orange opsai-restart-pill">${__("Starting")}</span>
					<span class="opsai-restart-detail">${__("Requesting gateway restart…")}</span>
				</div>
				<pre class="opsai-logs-view opsai-restart-log"></pre>`,
			},
		],
		primary_action_label: __("Close"),
		primary_action() {
			dialog.hide();
		},
	});

	const stop_polling = () => {
		state.alive = false;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
	};
	dialog.$wrapper.on("hidden.bs.modal", stop_polling);

	dialog.show();
	append_restart_log(dialog, state, __("→ Restart requested"));

	frappe
		.call({
			method: "opsai.api.restart_hermes_gateway",
			args: { user: frm.doc.user || frm.doc.name },
		})
		.then((r) => {
			if (!state.alive) return;
			const result = r.message || {};
			if (!result.ok) {
				set_restart_dialog_status(
					dialog,
					"red",
					__("Failed"),
					result.message || __("Restart failed")
				);
				append_restart_log(
					dialog,
					state,
					__("✗ {0}", [result.message || __("Restart failed")])
				);
				return;
			}
			const pid = result.pid != null ? `pid ${result.pid}` : "";
			state.action_name = result.name || "gateway-restart";
			set_restart_dialog_status(
				dialog,
				"orange",
				__("Restarting"),
				result.message || __("Hermes gateway restart started")
			);
			append_restart_log(
				dialog,
				state,
				__("→ {0}{1}", [result.message || __("Restart started"), pid ? ` (${pid})` : ""])
			);
			poll_gateway_restart(frm, dialog, state);
		})
		.catch((err) => {
			if (!state.alive) return;
			const msg = err?.message || __("Restart failed");
			set_restart_dialog_status(dialog, "red", __("Failed"), msg);
			append_restart_log(dialog, state, __("✗ {0}", [msg]));
		});
}

function set_restart_dialog_status(dialog, color, label, detail) {
	const $status = dialog.$wrapper.find(".opsai-restart-status");
	$status
		.find(".opsai-restart-pill")
		.attr("class", `indicator-pill ${color} opsai-restart-pill`)
		.text(label);
	$status.find(".opsai-restart-detail").text(detail || "");
}

function append_restart_log(dialog, state, line) {
	const text = String(line || "").trimEnd();
	if (!text) return;
	state.lines.push(text);
	const $view = dialog.$wrapper.find(".opsai-restart-log");
	$view.text(state.lines.join("\n"));
	$view.get(0).scrollTop = $view.get(0).scrollHeight;
}

function merge_restart_status_lines(dialog, state, lines) {
	const incoming = (lines || []).map((l) => String(l || "").trimEnd()).filter(Boolean);
	if (!incoming.length) return;
	const marker = `── ${state.action_name || "gateway-action"} ──`;
	const cut = state.lines.findIndex((l) => String(l).startsWith("── "));
	if (cut >= 0) {
		state.lines = state.lines.slice(0, cut);
	}
	state.lines.push(marker);
	state.lines.push(...incoming);
	const $view = dialog.$wrapper.find(".opsai-restart-log");
	$view.text(state.lines.join("\n"));
	$view.get(0).scrollTop = $view.get(0).scrollHeight;
}

function poll_gateway_restart(frm, dialog, state, on_done) {
	poll_gateway_action(frm, dialog, state, on_done);
}

function poll_gateway_action(frm, dialog, state, on_done) {
	if (!state.alive) return;
	if (state.attempt >= state.max_attempts) {
		set_restart_dialog_status(
			dialog,
			"orange",
			__("Timed out"),
			__("Still waiting — check Hermes if chat does not recover. You can close this dialog.")
		);
		append_restart_log(
			dialog,
			state,
			__("⚠ Poll timed out after {0} checks — action may still be finishing.", [
				state.max_attempts,
			])
		);
		on_done && on_done();
		return;
	}

	state.timer = setTimeout(() => {
		if (!state.alive) return;
		state.attempt += 1;
		frappe
			.call({
				method: "opsai.api.hermes_gateway_restart_status",
				args: {
					user: frm.doc.user || frm.doc.name,
					lines: 120,
					name: state.action_name || "gateway-restart",
				},
			})
			.then((r) => {
				if (!state.alive) return;
				const status = r.message || {};
				if (!status.ok) {
					append_restart_log(
						dialog,
						state,
						__("… status check {0}: {1}", [
							state.attempt,
							status.message || __("waiting for Hermes…"),
						])
					);
					// Some start/stop calls finish without a durable action log — fall back to live status.
					if (state.attempt >= 4) {
						append_restart_log(
							dialog,
							state,
							__("→ No action log yet — checking live gateway status")
						);
						on_done && on_done();
						return;
					}
					set_restart_dialog_status(
						dialog,
						"orange",
						__("Working"),
						status.message || __("Waiting for Hermes…")
					);
					poll_gateway_action(frm, dialog, state, on_done);
					return;
				}

				merge_restart_status_lines(dialog, state, status.lines);

				if (status.running) {
					set_restart_dialog_status(
						dialog,
						"orange",
						__("Working"),
						status.pid != null
							? __("Gateway action in progress (pid {0})…", [status.pid])
							: __("Gateway action in progress…")
					);
					poll_gateway_action(frm, dialog, state, on_done);
					return;
				}

				const code = status.exit_code;
				const ok = code === 0 || code === null || code === undefined;
				if (ok) {
					set_restart_dialog_status(
						dialog,
						"green",
						__("Done"),
						__("Gateway action finished.")
					);
					append_restart_log(dialog, state, __("✓ Action finished successfully"));
				} else {
					set_restart_dialog_status(
						dialog,
						"red",
						__("Error"),
						__("Action finished with exit code {0}", [code])
					);
					append_restart_log(
						dialog,
						state,
						__("✗ Action finished with exit code {0}", [code])
					);
				}
				on_done && on_done();
			})
			.catch((err) => {
				if (!state.alive) return;
				append_restart_log(
					dialog,
					state,
					__("… status check {0}: {1}", [
						state.attempt,
						err?.message || __("network error — retrying…"),
					])
				);
				poll_gateway_action(frm, dialog, state, on_done);
			});
	}, 1500);
}

function set_autocomplete_options(field, options) {
	if (!field) return;
	if (typeof field.set_data === "function") {
		field.set_data(options);
	} else if (field.df) {
		field.df.options = options;
		field.refresh?.();
	}
}

function load_hermes_models(frm, alert_on_error, dialog) {
	return frappe
		.call({
			method: "opsai.api.list_hermes_models",
			args: { user: frm.doc.user || frm.doc.name },
		})
		.then((r) => {
			const catalog = r.message || {};
			frm._opsai_model_catalog = catalog;
			if (!catalog.ok && alert_on_error) {
				frappe.show_alert({
					message: catalog.message || catalog.error || __("Could not load Hermes models"),
					indicator: "orange",
				});
			}
			apply_model_autocomplete(frm, catalog, dialog);

			// Fill blanks from live Hermes (Connect may already have seeded).
			const updates = {};
			if (!(frm.doc.default_provider || "").trim() && catalog.default_provider) {
				updates.default_provider = catalog.default_provider;
			}
			if (!(frm.doc.default_model || "").trim() && catalog.default_model) {
				updates.default_model = catalog.default_model;
			}
			if (Object.keys(updates).length) {
				frm.set_value(updates).then(() => {
					if (dialog) {
						dialog.set_values({
							default_provider: frm.doc.default_provider || "",
							default_model: frm.doc.default_model || "",
						});
					}
					refresh_hermes_model_tile(frm);
				});
			}

			const provider_options = (catalog.providers || []).map((p) => ({
				label: p.name || p.slug,
				value: p.slug,
			}));
			set_autocomplete_options(frm.get_field("default_provider"), provider_options);
			if (dialog?.fields_dict?.default_provider) {
				set_autocomplete_options(dialog.fields_dict.default_provider, provider_options);
			}
			return catalog;
		})
		.catch((err) => {
			if (alert_on_error) {
				frappe.show_alert({
					message: err?.message || __("Could not load Hermes models"),
					indicator: "red",
				});
			}
		});
}

function apply_model_autocomplete(frm, catalog, dialog) {
	if (!catalog) return;
	const provider = (
		(dialog ? dialog.get_value("default_provider") : null) ||
		frm.doc.default_provider ||
		catalog.provider ||
		""
	)
		.trim()
		.toLowerCase();
	let models = catalog.models || [];
	if (provider && catalog.providers?.length) {
		const match = catalog.providers.find((p) => (p.slug || "").toLowerCase() === provider);
		if (match?.models?.length) {
			models = match.models.map((mid) => ({
				name: mid,
				title: mid,
				provider: match.slug,
			}));
		}
	}
	const options = models.map((m) => ({
		label: m.title || m.name,
		value: m.name || m.model_id,
		description: m.provider || "",
	}));
	set_autocomplete_options(frm.get_field("default_model"), options);
	if (dialog?.fields_dict?.default_model) {
		set_autocomplete_options(dialog.fields_dict.default_model, options);
	}
}

function refresh_hermes_model_tile(frm) {
	const $tile = frm.$wrapper.find(".opsai-open-model");
	if (!$tile.length) return;
	$tile.find(".opsai-hub-tile-label").text(hermes_model_tile_label(frm));
	$tile.find(".opsai-hub-tile-meta").text(hermes_model_tile_meta(frm));
}

function apply_default_model(frm, confirm_expensive_model, dialog) {
	const provider = (frm.doc.default_provider || "").trim();
	const model = (frm.doc.default_model || "").trim();
	if (!model) {
		frappe.show_alert({ message: __("Pick a Default Model first"), indicator: "orange" });
		return;
	}

	const run = () => {
		frappe
			.call({
				method: "opsai.api.apply_hermes_model",
				args: {
					user: frm.doc.user || frm.doc.name,
					provider,
					model,
					confirm_expensive_model: confirm_expensive_model ? 1 : 0,
				},
				freeze: true,
				freeze_message: __("Applying model to Hermes…"),
			})
			.then((r) => {
				const result = r.message || {};
				if (result.confirm_required) {
					frappe.confirm(
						result.confirm_message || __("Confirm this model choice on Hermes?"),
						() => apply_default_model(frm, true, dialog)
					);
					return;
				}
				if (!result.ok) {
					frappe.show_alert({
						message: result.message || __("Apply failed"),
						indicator: "red",
					});
					return;
				}
				dialog?.hide();
				frm.reload_doc().then(() => {
					setup_auth_cards(frm);
					setup_hermes_hub(frm);
					frappe.show_alert({
						message: result.message || __("Model applied to Hermes"),
						indicator: "green",
					});
				});
			})
			.catch((err) => {
				frappe.clear_messages?.();
				frappe.show_alert({
					message: String(err?.message || err || __("Apply failed")).slice(0, 300),
					indicator: "red",
				});
			});
	};

	if (frm.is_dirty()) {
		frm.save().then(run);
	} else {
		run();
	}
}

function setup_url_test(frm) {
	const field = frm.get_field("gateway_url");
	if (!field?.$wrapper?.length) return;
	const $control = field.$wrapper.find(".control-input").first();
	if (!$control.length) return;

	// Don't rebuild chrome while a probe is in flight — that orphans "Testing…" state.
	if (frm._opsai_url_probing) {
		const $existing = $control.find(".opsai-url-test");
		if ($existing.length) {
			$existing.off("click.opsai").on("click.opsai", () => probe_url(frm));
			return;
		}
	}

	// Keep the latest probe result hint; only strip chrome wrappers.
	$control.find(".opsai-url-test").remove();
	$control.find(".opsai-url-input").each(function () {
		$(this).children().unwrap();
	});
	$control.find(".opsai-url-row").each(function () {
		const $row = $(this);
		$row.children().unwrap();
		$row.remove();
	});

	const $input =
		field.$input?.length ? field.$input : $control.find("input, textarea").first();
	if (!$input?.length) return;

	// Keep the live input under .control-input before re-wrapping
	if (!$input.parent().is($control)) {
		$control.prepend($input);
	}

	const $row = $('<div class="opsai-url-row">');
	const $inputWrap = $('<div class="opsai-url-input">');
	$input.wrap($inputWrap);
	$input.closest(".opsai-url-input").wrap($row);
	const busy = !!frm._opsai_url_probing;
	const $btn = $(
		`<button type="button" class="btn btn-default btn-sm opsai-url-test">${
			busy ? __("Testing…") : __("Test")
		}</button>`
	);
	$btn.prop("disabled", busy);
	$input.closest(".opsai-url-row").append($btn);
	$btn.off("click.opsai").on("click.opsai", () => probe_url(frm));
}

function set_url_test_button(frm, { busy, label } = {}) {
	const field = frm.get_field("gateway_url");
	const $btn = field?.$wrapper?.find(".opsai-url-test");
	if (!$btn?.length) return;
	$btn.prop("disabled", !!busy).text(label || (busy ? __("Testing…") : __("Test")));
}

function show_url_test_hint(frm, message, ok) {
	const field = frm.get_field("gateway_url");
	if (!field?.$wrapper?.length) return;
	field.$wrapper.find(".opsai-url-hint").remove();
	const $anchor =
		field.$wrapper.find(".control-input-wrapper").first().length
			? field.$wrapper.find(".control-input-wrapper").first()
			: field.$wrapper.find(".opsai-url-row").first().length
				? field.$wrapper.find(".opsai-url-row").first()
				: field.$wrapper.find(".control-input").first();
	if (!$anchor?.length) return;
	$(
		`<div class="opsai-url-hint ${ok ? "ok" : "bad"}">${frappe.utils.escape_html(
			message || (ok ? __("OK") : __("Failed"))
		)}</div>`
	).insertAfter($anchor);
}

function finish_url_probe(frm) {
	frm._opsai_url_probing = false;
	set_url_test_button(frm, { busy: false, label: __("Test") });
}

function probe_url(frm) {
	const url = (frm.doc.gateway_url || frm.get_field("gateway_url")?.get_value?.() || "").trim();
	if (!url) {
		frappe.msgprint(__("Enter a Gateway URL first"));
		return;
	}
	const field = frm.get_field("gateway_url");
	if (!field?.$wrapper?.length) return;
	if (frm._opsai_url_probing) return;

	frm._opsai_url_probing = true;
	field.$wrapper.find(".opsai-url-hint").remove();
	set_url_test_button(frm, { busy: true, label: __("Testing…") });

	// Use callback/error — Desk's frappe.call promise often skips .finally().
	frappe.call({
		method: "opsai.api.probe_gateway",
		args: { gateway_url: url },
		callback(r) {
			const result = r.message || {};
			const ok = !!result.ok;
			show_url_test_hint(
				frm,
				result.message || (ok ? __("OK") : __("Failed")),
				ok
			);
			finish_url_probe(frm);
		},
		error(err) {
			show_url_test_hint(
				frm,
				err?.message || err?._server_messages || __("Test failed"),
				false
			);
			finish_url_probe(frm);
		},
	});
}

function opsai_field_park(frm) {
	let $park = frm.$wrapper.find(".opsai-field-park");
	if (!$park.length) {
		$park = $('<div class="opsai-field-park" aria-hidden="true"></div>');
		frm.$wrapper.find(".form-layout").first().append($park);
	}
	return $park;
}

function setup_auth_cards(frm) {
	if (frm._opsai_building_auth_cards) return;
	frm._opsai_building_auth_cards = true;

	try {
		const $park = opsai_field_park(frm);
		const field_names = [
			"gateway_url",
			"auth_mode",
			"gateway_username",
			"gateway_password",
			"session_token",
		];

		// Pull every connection field out of old cards into a stable park first.
		frm.$wrapper.find(".opsai-connect-grid, .opsai-auth-card").each(function () {
			const $host = $(this);
			$host.find(".frappe-control").each(function () {
				$park.append(this);
			});
		});
		frm.$wrapper.find(".opsai-connect-grid, .opsai-auth-card, .opsai-connect-row").remove();

		field_names.forEach((name) => {
			const $w = frm.get_field(name)?.$wrapper;
			if ($w?.length) $park.append($w);
		});

		const $url = frm.get_field("gateway_url")?.$wrapper;
		const $mode = frm.get_field("auth_mode")?.$wrapper;
		if (!$url?.length) return;

		const $grid = $(`<div class="opsai-connect-grid"></div>`);
		// Never use section.$wrapper.after() — that wraps the whole section (including hub).
		place_opsai_connect_grid(frm, $grid);

		const $gateway = build_opsai_card({
			title: __("Hermes Gateway"),
			subtitle: __("Base URL and how you authenticate"),
			icon: "server",
			extra_class: "opsai-gateway-card",
		});
		const $gateway_body = $('<div class="opsai-auth-card-body"></div>');
		$gateway_body.append($url);
		if ($mode?.length) $gateway_body.append($mode);
		$gateway.append($gateway_body);
		$grid.append($gateway);

		const mode = (frm.doc.auth_mode || "password").toLowerCase();
		const auth_opts =
			mode === "token"
				? {
						title: __("API server key"),
						subtitle: __("Advanced Bearer token (API_SERVER_KEY)"),
						icon: "shield",
						fields: ["session_token"],
						onConnect: () => connect_token(frm),
				  }
				: {
						title: __("Sign in"),
						subtitle: __("Hermes username & password"),
						icon: "key-round",
						fields: ["gateway_username", "gateway_password"],
						onConnect: () => connect_password(frm),
				  };

		const $auth = build_opsai_card({
			title: auth_opts.title,
			subtitle: auth_opts.subtitle,
			icon: auth_opts.icon,
		});
		const $auth_body = $('<div class="opsai-auth-card-body"></div>');
		auth_opts.fields.forEach((name) => {
			const $w = frm.get_field(name)?.$wrapper;
			if ($w?.length) {
				$w.removeClass("hide-control");
				$w.show();
				$auth_body.append($w);
			}
		});
		$auth.append($auth_body);
		const connected = is_hermes_connected(frm);
		const $row = $(
			`<div class="opsai-connect-row">
				<button type="button" class="btn ${
					connected ? "btn-primary" : "btn-default"
				} btn-sm opsai-disconnect-btn" ${connected ? "" : "disabled"}>
					${opsai_icon("unplug", "xs")} ${__("Disconnect")}
				</button>
				<button type="button" class="btn ${
					connected ? "btn-default" : "btn-primary"
				} btn-sm opsai-connect-btn" ${connected ? "disabled" : ""}>
					${opsai_icon("plug", "xs")} ${__("Connect")}
				</button>
			</div>`
		);
		$auth.append($row);
		$row.find(".opsai-connect-btn").on("click", function () {
			if ($(this).prop("disabled")) return;
			auth_opts.onConnect();
		});
		$row.find(".opsai-disconnect-btn").on("click", function () {
			if ($(this).prop("disabled")) return;
			disconnect_hermes(frm);
		});
		$grid.append($auth);

		// Inactive credential fields stay parked (hidden) so they don't spill under the cards.
		["gateway_username", "gateway_password", "session_token"].forEach((name) => {
			if (auth_opts.fields.includes(name)) return;
			const $w = frm.get_field(name)?.$wrapper;
			if ($w?.length) $park.append($w);
		});

		setup_url_test(frm);
	} finally {
		frm._opsai_building_auth_cards = false;
	}
}

function build_opsai_card({ title, subtitle, icon, extra_class }) {
	return $(`<div class="opsai-auth-card ${frappe.utils.escape_html(extra_class || "")}">
		<div class="opsai-auth-card-head">
			<span class="opsai-auth-card-icon">${opsai_icon(icon || "lock", "sm")}</span>
			<div>
				<div class="opsai-auth-card-title">${frappe.utils.escape_html(title)}</div>
				${
					subtitle
						? `<div class="opsai-auth-card-sub">${frappe.utils.escape_html(subtitle)}</div>`
						: ""
				}
			</div>
		</div>
	</div>`);
}

function field_input_value(frm, fieldname) {
	// Password fields are blank on frm.doc after reload; the typed value lives on the input.
	const field = frm.get_field(fieldname);
	const from_input = field?.$input?.val?.() || field?.$wrapper?.find("input")?.val?.() || "";
	const from_doc = frm.doc[fieldname] || "";
	const value = from_input || from_doc || "";
	if (!value || value === "*****" || /^\u2022+$/.test(value) || /^\*+$/.test(value)) {
		return "";
	}
	return value;
}

function connect_password(frm) {
	const username = (frm.doc.gateway_username || "").trim();
	const gateway_url = (frm.doc.gateway_url || "").trim();
	const typed_password = field_input_value(frm, "gateway_password");

	if (!gateway_url) {
		frappe.show_alert({ message: __("Gateway URL is required"), indicator: "orange" });
		return;
	}
	if (!username) {
		frappe.show_alert({ message: __("Username is required"), indicator: "orange" });
		return;
	}

	const run = (password) => {
		const args = {
			gateway_url,
			gateway_username: username,
			auth_mode: "password",
		};
		// Only send a newly typed password; otherwise the server uses the saved Password field.
		if ((password || "").trim()) {
			args.gateway_password = password;
		}
		call_connect(frm, args);
	};

	const go = () => run(typed_password);
	if (frm.is_dirty()) {
		frm.save().then(go);
	} else {
		go();
	}
}

function connect_token(frm) {
	const gateway_url = (frm.doc.gateway_url || "").trim();
	const typed = field_input_value(frm, "session_token");

	if (!gateway_url) {
		frappe.show_alert({ message: __("Gateway URL is required"), indicator: "orange" });
		return;
	}

	const run = (token) => {
		const args = {
			gateway_url,
			auth_mode: "token",
		};
		// Only send a newly typed key; otherwise the server uses the saved API Server Key.
		if ((token || "").trim()) {
			args.session_token = token;
		}
		call_connect(frm, args);
	};

	const go = () => run(typed);
	if (frm.is_dirty()) {
		frm.save().then(go);
	} else {
		go();
	}
}

function call_connect(frm, args) {
	frm.dashboard.set_headline_alert(__("Connecting to Hermes…"));
	frappe
		.call({
			method: "opsai.api.connect_hermes",
			args: {
				user: frm.doc.user || frm.doc.name,
				...args,
			},
			freeze: true,
			freeze_message: __("Connecting to Hermes…"),
		})
		.then((r) => {
			const result = r.message || {};
			frm.reload_doc().then(() => {
				setup_auth_cards(frm);
				setup_hermes_hub(frm);
				refresh_opsai_connection_banner(frm);
				frappe.show_alert({
					message: result.message || (result.ok ? __("Connected") : __("Connect failed")),
					indicator: result.ok ? "green" : "red",
				});
				if (result.ok) load_hermes_models(frm, false);
				if (result.need_password) {
					frm.get_field("gateway_password")?.$input?.focus?.();
				}
			});
		})
		.catch((err) => {
			frappe.clear_messages?.();
			const msg =
				err?.message ||
				err?.exc ||
				__("Connect failed");
			frm.dashboard.set_headline_alert(
				`<span class="indicator-pill red">${__("Disconnected")}</span> ${frappe.utils.escape_html(
					String(msg).slice(0, 300)
				)}`,
				"red"
			);
		});
}

function disconnect_hermes(frm) {
	frappe.confirm(__("Disconnect from Hermes? You can Connect again with the same credentials."), () => {
		frappe
			.call({
				method: "opsai.api.disconnect_hermes",
				args: { user: frm.doc.user || frm.doc.name },
				freeze: true,
				freeze_message: __("Disconnecting…"),
			})
			.then((r) => {
				const result = r.message || {};
				frm.reload_doc().then(() => {
					setup_auth_cards(frm);
					setup_hermes_hub(frm);
					refresh_opsai_connection_banner(frm);
					frappe.show_alert({
						message: result.message || __("Disconnected"),
						indicator: result.ok ? "orange" : "red",
					});
				});
			})
			.catch((err) => {
				frappe.clear_messages?.();
				frappe.show_alert({
					message: err?.message || err?.exc || __("Disconnect failed"),
					indicator: "red",
				});
			});
	});
}
