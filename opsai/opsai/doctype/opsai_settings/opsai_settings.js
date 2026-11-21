// Copyright (c) 2026, OpsAi and contributors
// For license information, please see license.txt

frappe.ui.form.on("OpsAi Settings", {
	refresh(frm) {
		if (frm.is_new() && !frm.doc.user) {
			frm.set_value("user", frappe.session.user);
		}
		if (!frm.doc.auth_mode) {
			frm.set_value("auth_mode", "password");
		}

		frm.clear_custom_buttons();
		inject_opsai_styles();
		setup_url_test(frm);
		setup_auth_cards(frm);
		setup_model_defaults(frm);
	},

	auth_mode(frm) {
		// depends_on toggles fields; rebuild cards after layout settles
		setTimeout(() => setup_auth_cards(frm), 50);
	},

	default_provider(frm) {
		// Rebuild model suggestions for the chosen provider.
		if (frm._opsai_model_catalog) {
			apply_model_autocomplete(frm, frm._opsai_model_catalog);
		}
	},
});

function inject_opsai_styles() {
	if (document.getElementById("opsai-settings-css")) return;
	const css = document.createElement("style");
	css.id = "opsai-settings-css";
	css.textContent = `
		.opsai-url-row { display: flex; gap: 8px; align-items: stretch; width: 100%; }
		.opsai-url-row .opsai-url-input { flex: 1 1 auto; min-width: 0; }
		.opsai-url-row .opsai-url-test {
			flex: 0 0 auto; white-space: nowrap; height: var(--input-height, 28px);
		}
		.opsai-auth-card {
			border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 8px;
			padding: 12px 14px 14px;
			margin: 8px 0 16px;
			background: var(--fg-color, var(--card-bg, #fff));
		}
		.opsai-auth-card .opsai-auth-card-title {
			font-size: var(--text-sm, 12px);
			font-weight: 600;
			color: var(--text-muted, #6c7680);
			margin: 0 0 10px;
			text-transform: uppercase;
			letter-spacing: 0.02em;
		}
		.opsai-auth-card .form-column, .opsai-auth-card .frappe-control { margin-bottom: 8px; }
		.opsai-connect-row { display: flex; justify-content: flex-end; margin-top: 10px; gap: 8px; }
		.opsai-url-hint {
			font-size: var(--text-sm, 12px); margin-top: 4px;
		}
		.opsai-url-hint.ok { color: var(--green-600, #16794c); }
		.opsai-url-hint.bad { color: var(--red-600, #e24c4c); }
		.opsai-model-actions { display: flex; gap: 8px; justify-content: flex-end; margin: 4px 0 12px; }
	`;
	document.head.appendChild(css);
}

function setup_model_defaults(frm) {
	const model_field = frm.get_field("default_model");
	if (!model_field) return;

	const $wrap = model_field.$wrapper;
	$wrap.find(".opsai-model-actions").remove();
	const $actions = $(`<div class="opsai-model-actions">
		<button type="button" class="btn btn-default btn-sm opsai-refresh-models">${__("Refresh models")}</button>
		<button type="button" class="btn btn-primary btn-sm opsai-apply-model">${__("Apply to Hermes")}</button>
	</div>`);
	$wrap.append($actions);
	$actions.find(".opsai-refresh-models").on("click", () => load_hermes_models(frm, true));
	$actions.find(".opsai-apply-model").on("click", () => apply_default_model(frm));

	// Autocomplete once connected (or whenever we already have cookies/status).
	if ((frm.doc.connection_status || "").toLowerCase().includes("connected") || frm.doc.default_model) {
		load_hermes_models(frm, false);
	}
}

function load_hermes_models(frm, alert_on_error) {
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
			apply_model_autocomplete(frm, catalog);

			// Fill blanks from live Hermes (Connect may already have seeded).
			const updates = {};
			if (!(frm.doc.default_provider || "").trim() && catalog.default_provider) {
				updates.default_provider = catalog.default_provider;
			}
			if (!(frm.doc.default_model || "").trim() && catalog.default_model) {
				updates.default_model = catalog.default_model;
			}
			if (Object.keys(updates).length) {
				frm.set_value(updates);
			}

			// Provider suggestions from catalog.
			const provider_field = frm.get_field("default_provider");
			if (provider_field && catalog.providers?.length) {
				provider_field.set_data(
					catalog.providers.map((p) => ({
						label: p.name || p.slug,
						value: p.slug,
					}))
				);
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

function apply_model_autocomplete(frm, catalog) {
	const field = frm.get_field("default_model");
	if (!field || !catalog) return;
	const provider = (frm.doc.default_provider || catalog.provider || "").trim().toLowerCase();
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
	field.set_data(
		models.map((m) => ({
			label: m.title || m.name,
			value: m.name || m.model_id,
			description: m.provider || "",
		}))
	);
}

function apply_default_model(frm, confirm_expensive_model) {
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
						() => apply_default_model(frm, true)
					);
					return;
				}
				if (!result.ok) {
					frm.dashboard.set_headline_alert(
						`<span class="indicator-pill red">${__("Model")}</span> ${frappe.utils.escape_html(
							result.message || __("Apply failed")
						)}`,
						"red"
					);
					return;
				}
				frm.reload_doc().then(() => {
					setup_url_test(frm);
					setup_auth_cards(frm);
					setup_model_defaults(frm);
					frm.dashboard.set_headline_alert(
						`<span class="indicator-pill green">${__("Model")}</span> ${frappe.utils.escape_html(
							result.message || ""
						)}`,
						"green"
					);
				});
			})
			.catch((err) => {
				frappe.clear_messages?.();
				frm.dashboard.set_headline_alert(
					`<span class="indicator-pill red">${__("Model")}</span> ${frappe.utils.escape_html(
						String(err?.message || err || __("Apply failed")).slice(0, 300)
					)}`,
					"red"
				);
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
	if (!field) return;
	const $control = field.$wrapper.find(".control-input");
	if (!$control.length) return;

	$control.find(".opsai-url-test, .opsai-url-row").remove();
	field.$wrapper.find(".opsai-url-hint").remove();

	const $input = $control.children().first();
	if (!$input.length) return;

	const $row = $('<div class="opsai-url-row">');
	const $inputWrap = $('<div class="opsai-url-input">');
	$input.wrap($inputWrap);
	$input.closest(".opsai-url-input").wrap($row);
	const $btn = $(
		`<button type="button" class="btn btn-default btn-sm opsai-url-test">${__("Test")}</button>`
	);
	$input.closest(".opsai-url-row").append($btn);
	$btn.off("click.opsai").on("click.opsai", () => probe_url(frm));
}

function probe_url(frm) {
	const url = (frm.doc.gateway_url || "").trim();
	if (!url) {
		frappe.msgprint(__("Enter a Gateway URL first"));
		return;
	}
	const field = frm.get_field("gateway_url");
	field.$wrapper.find(".opsai-url-hint").remove();
	const $btn = field.$wrapper.find(".opsai-url-test");
	$btn.prop("disabled", true).text(__("Testing…"));

	frappe
		.call({
			method: "opsai.api.probe_gateway",
			args: { gateway_url: url },
		})
		.then((r) => {
			const result = r.message || {};
			const ok = !!result.ok;
			$(
				`<div class="opsai-url-hint ${ok ? "ok" : "bad"}">${frappe.utils.escape_html(
					result.message || (ok ? __("OK") : __("Failed"))
				)}</div>`
			).insertAfter(
				field.$wrapper.find(".control-input-wrapper").length
					? field.$wrapper.find(".control-input-wrapper")
					: field.$wrapper.find(".opsai-url-row")
			);
		})
		.finally(() => $btn.prop("disabled", false).text(__("Test")));
}

function setup_auth_cards(frm) {
	// Unwrap any previous cards so we can rebuild cleanly
	frm.$wrapper.find(".opsai-auth-card").each(function () {
		$(this).children(".frappe-control, .form-group").each(function () {
			$(this).insertBefore($(this).parent());
		});
		$(this).remove();
	});
	frm.$wrapper.find(".opsai-connect-row").remove();

	const mode = frm.doc.auth_mode || "password";
	if (mode === "password") {
		wrap_auth_card(frm, {
			title: __("Username & password"),
			fields: ["gateway_username", "gateway_password"],
			onConnect: () => connect_password(frm),
		});
	} else if (mode === "token") {
		wrap_auth_card(frm, {
			title: __("API server key"),
			fields: ["session_token"],
			onConnect: () => connect_token(frm),
		});
	}
}

function wrap_auth_card(frm, { title, fields, onConnect }) {
	const controls = fields.map((name) => frm.get_field(name)?.$wrapper).filter(Boolean);
	if (!controls.length) return;
	// Skip if depends_on hid them
	if (controls.every(($w) => !$w.is(":visible"))) return;

	const $first = controls[0];
	const $card = $(
		`<div class="opsai-auth-card"><div class="opsai-auth-card-title">${frappe.utils.escape_html(
			title
		)}</div></div>`
	);
	$first.before($card);
	controls.forEach(($w) => $card.append($w));
	const $row = $(
		`<div class="opsai-connect-row">
			<button type="button" class="btn btn-primary btn-sm opsai-connect-btn">${__("Connect")}</button>
		</div>`
	);
	$card.append($row);
	$row.find("button").on("click", onConnect);
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
		if (!(password || "").trim()) {
			frappe.show_alert({
				message: __(
					"Type the Hermes password in the Password field, then click Connect."
				),
				indicator: "orange",
			});
			frm.get_field("gateway_password")?.$input?.focus?.();
			return;
		}
		call_connect(frm, {
			gateway_url,
			gateway_username: username,
			gateway_password: password,
			auth_mode: "password",
		});
	};

	if (typed_password) {
		if (frm.is_dirty()) {
			frm.save().then(() => run(typed_password));
		} else {
			run(typed_password);
		}
		return;
	}

	// Ask once if the field was cleared by a reload.
	frappe.prompt(
		[
			{
				fieldname: "password",
				fieldtype: "Password",
				label: __("Hermes Password"),
				reqd: 1,
			},
		],
		(values) => run(values.password),
		__("Connect to Hermes"),
		__("Connect")
	);
}

function connect_token(frm) {
	const gateway_url = (frm.doc.gateway_url || "").trim();
	const typed = field_input_value(frm, "session_token");

	if (!gateway_url) {
		frappe.show_alert({ message: __("Gateway URL is required"), indicator: "orange" });
		return;
	}

	const run = (token) => {
		if (!(token || "").trim()) {
			frappe.show_alert({
				message: __("Type the API Server Key, then click Connect."),
				indicator: "orange",
			});
			frm.get_field("session_token")?.$input?.focus?.();
			return;
		}
		call_connect(frm, {
			gateway_url,
			session_token: token,
			auth_mode: "token",
		});
	};

	if (typed) {
		if (frm.is_dirty()) {
			frm.save().then(() => run(typed));
		} else {
			run(typed);
		}
		return;
	}

	frappe.prompt(
		[
			{
				fieldname: "session_token",
				fieldtype: "Password",
				label: __("API Server Key"),
				reqd: 1,
			},
		],
		(values) => run(values.session_token),
		__("Connect with API key"),
		__("Connect")
	);
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
				setup_url_test(frm);
				setup_auth_cards(frm);
				setup_model_defaults(frm);
				// One place only — form headline (no modal + toast pair).
				if (result.ok) {
					frm.dashboard.set_headline_alert(
						`<span class="indicator-pill green">${__("Connected")}</span> ${frappe.utils.escape_html(
							result.message || ""
						)}`,
						"green"
					);
					load_hermes_models(frm, false);
				} else {
					frm.dashboard.set_headline_alert(
						`<span class="indicator-pill red">${__("Disconnected")}</span> ${frappe.utils.escape_html(
							result.message || __("Connect failed")
						)}`,
						"red"
					);
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
