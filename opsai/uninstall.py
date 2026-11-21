# Copyright (c) 2026, OpsAi and contributors
# License: MIT. See LICENSE

import frappe

from opsai.permissions import remove_opsai_role


def before_uninstall():
	remove_opsai_role()
	# Drop leftovers from the removed floating-launcher experiment.
	frappe.db.delete("DefaultValue", {"defkey": "hide_opsai_launcher"})
