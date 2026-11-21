# Copyright (c) 2026, OpsAi and contributors
# License: MIT. See LICENSE

"""OpsAi access: the OpsAi User role (plus System Manager) may use the app and launcher."""

from __future__ import annotations

import frappe

OPSAI_USER_ROLE = "OpsAi User"


def ensure_opsai_role() -> None:
	"""Create the OpsAi User role on install and migrate."""
	if frappe.db.exists("Role", OPSAI_USER_ROLE):
		return
	frappe.get_doc(
		{
			"doctype": "Role",
			"role_name": OPSAI_USER_ROLE,
			"desk_access": 1,
			"is_custom": 0,
		}
	).insert(ignore_permissions=True, ignore_if_duplicate=True)


def remove_opsai_role() -> None:
	"""Remove the OpsAi User role and its Has Role links on uninstall."""
	if not frappe.db.exists("Role", OPSAI_USER_ROLE):
		return
	frappe.db.delete("Has Role", {"role": OPSAI_USER_ROLE})
	frappe.delete_doc("Role", OPSAI_USER_ROLE, ignore_permissions=True, force=True)


def has_opsai_access(user: str | None = None) -> bool:
	"""Whether the user may see OpsAi on the apps screen and the floating launcher."""
	user = user or frappe.session.user
	if user == "Administrator":
		return True
	roles = frappe.get_roles(user)
	return "System Manager" in roles or OPSAI_USER_ROLE in roles
