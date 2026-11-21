# Copyright (c) 2026, OpsAi and contributors
# License: MIT. See LICENSE

from opsai.permissions import has_opsai_access


def extend_bootinfo(bootinfo):
	"""Expose OpsAi access so the dock/sidebar can show the utility icon."""
	bootinfo["has_opsai_access"] = has_opsai_access()
