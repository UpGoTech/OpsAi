// Copyright (c) 2026, OpsAi and contributors
// For license information, please see license.txt

frappe.ui.form.on("OpsAi Settings", {
  refresh(frm) {
    if (frm.is_new() && !frm.doc.user) {
      frm.set_value("user", frappe.session.user);
    }
  },
});
