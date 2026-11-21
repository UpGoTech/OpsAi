# Copyright (c) 2026, OpsAi and contributors
# License: MIT. See LICENSE

"""The /opsai page: OpsAi chat island (Hermes-backed), full page."""

from __future__ import annotations

from urllib.parse import urlencode

import frappe
from frappe import _

from opsai.permissions import has_opsai_access

no_cache = 1

ISLAND = "opsai.chat"


def get_context(context):
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = f"/login?{urlencode({'redirect-to': frappe.request.path})}"
		raise frappe.Redirect

	if not has_opsai_access():
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	from frappe.translate import get_messages_for_boot
	from frappe.utils import get_assets_json

	assets = get_assets_json()
	context.island_js = assets.get(f"{ISLAND}.island.js")
	context.island_css = assets.get(f"{ISLAND}.island.css")
	if not context.island_js:
		frappe.throw(
			_("OpsAi chat is not built. Run: bench build --app opsai"),
			frappe.ValidationError,
		)

	context.boot = get_boot()
	context.messages = get_messages_for_boot()
	context.no_cache = 1
	return context


def get_boot() -> dict:
	from frappe.sessions import get_csrf_token
	from opsai.api import boot as opsai_boot_fn

	csrf_token = get_csrf_token()
	opsai_boot = opsai_boot_fn()
	frappe.db.commit()  # nosemgrep: frappe-manual-commit
	return {
		"csrf_token": csrf_token,
		"site_name": frappe.local.site,
		"socketio_port": frappe.conf.socketio_port,
		"lang": frappe.local.lang,
		"opsai_boot": opsai_boot,
	}
