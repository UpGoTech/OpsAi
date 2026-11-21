__version__ = "0.0.1"

import frappe
from frappe.utils.user import is_website_user

from opsai.permissions import has_opsai_access


def check_app_permission():
	"""Gate OpsAi on the desk apps screen (OpsAi User / System Manager)."""
	if frappe.session.user == "Administrator":
		return True
	if is_website_user():
		return False
	return has_opsai_access()
