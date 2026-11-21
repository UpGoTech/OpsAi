// OpsAi utility icon in the left dock / sidebar — same tray as Search, Notifications, Flow.
// Uses the OpsAi logo asset (not Lucide) so dock matches chat + apps branding.
(() => {
	const OPSAI_ICON = "/assets/opsai/images/opsai-logo.svg";

	function can_use_opsai() {
		return Boolean(frappe.boot?.has_opsai_access);
	}

	function open_opsai() {
		$(document).trigger("opsai:ensure");
		if (window.opsai?.toggle) {
			window.opsai.toggle();
			return;
		}
		frappe.msgprint({
			title: __("OpsAi"),
			message: __(
				"OpsAi chat is not available. Build the opsai.chat island (bench build --app opsai) and reload."
			),
			indicator: "orange",
		});
	}

	function opsai_icon_html() {
		return `<img src="${OPSAI_ICON}" alt="" class="opsai-dock-icon" width="16" height="16" style="width:16px;height:16px;display:block;border-radius:4px;object-fit:contain;">`;
	}

	function make_opsai_item() {
		return {
			label: __("OpsAi"),
			icon: "bot",
			standard: true,
			type: "Button",
			class: "sidebar-opsai",
			onClick: open_opsai,
		};
	}

	function patch_dock() {
		if (!frappe.ui?.Dock?.prototype || frappe.ui.Dock.prototype.__opsai_patched) return;
		const original = frappe.ui.Dock.prototype.render_utilities;
		frappe.ui.Dock.prototype.render_utilities = function () {
			original.call(this);
			append_dock_opsai(this);
		};
		frappe.ui.Dock.prototype.__opsai_patched = true;
	}

	function append_dock_opsai(dock) {
		if (!can_use_opsai() || !dock?.$dock) return;
		const $utilities = dock.$dock.find(".dock-utilities");
		if (!$utilities.length || $utilities.find(".sidebar-opsai").length) return;
		const $opsai = dock.make_utility({
			label: __("OpsAi"),
			icon: "bot",
			css_class: "sidebar-opsai",
		});
		$opsai.find(".dock-item-icon").html(opsai_icon_html());
		$opsai.on("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			open_opsai();
		});
		$utilities.append($opsai);
	}

	function patch_sidebar() {
		if (!frappe.ui?.Sidebar?.prototype || frappe.ui.Sidebar.prototype.__opsai_patched) return;
		const original = frappe.ui.Sidebar.prototype.add_standard_items;
		frappe.ui.Sidebar.prototype.add_standard_items = function (...args) {
			original.apply(this, args);
			append_sidebar_opsai(this);
		};
		frappe.ui.Sidebar.prototype.__opsai_patched = true;
	}

	function append_sidebar_opsai(sidebar) {
		if (!can_use_opsai() || !sidebar?.$standard_items_band) return;
		if (sidebar.$standard_items_band.find(".sidebar-opsai").length) return;
		sidebar.add_item(sidebar.$standard_items_band, make_opsai_item());
		const $item = sidebar.$standard_items_band.find(".sidebar-opsai");
		$item.find(".sidebar-item-icon, .icon, svg").first().replaceWith(opsai_icon_html());
		// Sidebar items often nest the icon; replace whatever icon slot exists.
		const $icon_slot = $item.find(".item-icon, .standard-sidebar-item .icon").first();
		if ($icon_slot.length) $icon_slot.replaceWith(opsai_icon_html());
		else $item.find("svg").first().replaceWith(opsai_icon_html());
	}

	function ensure_mounted() {
		patch_dock();
		patch_sidebar();
		const sidebar = frappe.app?.sidebar;
		if (!sidebar) return;
		if (sidebar.dock) append_dock_opsai(sidebar.dock);
		append_sidebar_opsai(sidebar);
	}

	patch_dock();
	patch_sidebar();
	$(document).on("app_ready", ensure_mounted);
	if (window.frappe?.boot) {
		frappe.after_ajax?.(() => ensure_mounted());
		$(ensure_mounted);
	}
})();
