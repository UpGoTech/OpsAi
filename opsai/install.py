# Copyright (c) 2026, OpsAi and contributors
# License: MIT. See LICENSE

import frappe

from opsai.permissions import ensure_opsai_role


def after_install():
	ensure_opsai_role()
