"""Whitelisted OpsAi API — Desk chat island talks here; this proxies Hermes."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from typing import Any

import frappe
from frappe import _

from opsai.artifacts import import_hermes_path, ingest_assistant_artifacts
from opsai.hermes import HermesError, get_user_settings, request as hermes_request, session_key, try_request
from opsai.hermes_gateway import create_gateway_session, run_gateway_turn
from opsai.permissions import has_opsai_access

LIST_LIMIT = 100
HERMES_MODEL = "hermes-agent"


def _require_access():
	if not has_opsai_access():
		frappe.throw(_("Not permitted"), frappe.PermissionError)


def _pretty_model_title(model_id: str) -> str:
	"""deepseek/deepseek-v4.1-flash → DeepSeek V4.1 Flash."""
	leaf = (model_id or "").split("/")[-1] or model_id or HERMES_MODEL
	parts = re.split(r"[-_]", leaf)
	out = []
	for part in parts:
		if not part:
			continue
		if part.lower() == "deepseek":
			out.append("DeepSeek")
		elif re.fullmatch(r"v?\d+(?:\.\d+)*", part, flags=re.I):
			out.append(part.upper() if part[0] in "vV" else part)
		else:
			out.append(part[:1].upper() + part[1:])
	return " ".join(out) or model_id


def _can_manage_settings_user(target: str) -> bool:
	if target == frappe.session.user:
		return True
	if frappe.session.user == "Administrator":
		return True
	return "System Manager" in frappe.get_roles()


def _model_row(model_id: str, provider: str | None = None, context_window=None) -> dict:
	mid = (model_id or "").strip() or HERMES_MODEL
	return {
		"name": mid,
		"title": _pretty_model_title(mid),
		"model_id": mid,
		"provider": (provider or "hermes").strip() or "hermes",
		"context_window": context_window,
	}


def _read_hermes_model_info(settings: dict) -> tuple[str, str, Any]:
	"""Return (model, provider, context_window) from Hermes /api/model/info."""
	ok, info, _err = try_request("GET", "/api/model/info", settings=settings, timeout=20)
	if not ok or not isinstance(info, dict):
		return "", "", None
	caps = info.get("capabilities") if isinstance(info.get("capabilities"), dict) else {}
	ctx = (
		info.get("effective_context_length")
		or caps.get("context_window")
		or info.get("auto_context_length")
	)
	return (
		(info.get("model") or "").strip(),
		(info.get("provider") or "").strip(),
		ctx,
	)


def _hermes_models_catalog(settings: dict | None) -> list[dict]:
	"""Models the UI may show — prefer OpsAi Settings default, else Hermes current."""
	if not settings:
		return []

	saved_model = (settings.get("default_model") or "").strip()
	saved_provider = (settings.get("default_provider") or "").strip()
	live_model, live_provider, ctx = _read_hermes_model_info(settings)

	chosen = saved_model or live_model
	provider = saved_provider or live_provider or "hermes"
	if chosen:
		return [_model_row(chosen, provider, ctx if chosen == live_model else None)]

	return [_model_row(HERMES_MODEL, "hermes")]


def _persist_default_model(user: str, provider: str | None, model: str | None) -> None:
	if not user or not frappe.db.exists("OpsAi Settings", user):
		return
	updates = {}
	if provider is not None:
		updates["default_provider"] = (provider or "").strip()
	if model is not None:
		updates["default_model"] = (model or "").strip()
	if not updates:
		return
	for field, value in updates.items():
		frappe.db.set_value("OpsAi Settings", user, field, value, update_modified=False)
	frappe.db.commit()  # nosemgrep: frappe-manual-commit


def _seed_default_model_from_hermes(user: str, settings: dict) -> dict:
	"""Desktop keep-current: fill blank defaults from Hermes /api/model/info."""
	doc_provider = (settings.get("default_provider") or "").strip()
	doc_model = (settings.get("default_model") or "").strip()
	if doc_provider and doc_model:
		return {"provider": doc_provider, "model": doc_model, "seeded": False}

	live_model, live_provider, _ctx = _read_hermes_model_info(settings)
	provider = doc_provider or live_provider
	model = doc_model or live_model

	# If still missing model, try recommended-default for the provider (Desktop).
	if provider and not model:
		ok, rec, _err = try_request(
			"GET",
			"/api/model/recommended-default",
			settings=settings,
			params={"provider": provider},
			timeout=20,
		)
		if ok and isinstance(rec, dict):
			model = (rec.get("model") or "").strip()

	if (not doc_provider and provider) or (not doc_model and model):
		_persist_default_model(user, provider or None, model or None)
		settings["default_provider"] = provider or ""
		settings["default_model"] = model or ""
		return {"provider": provider or "", "model": model or "", "seeded": True}

	return {"provider": provider or "", "model": model or "", "seeded": False}


def _prefs_key() -> str:
	return f"opsai_prefs::{frappe.session.user}"


def _user_prefs() -> dict:
	raw = frappe.cache().get_value(_prefs_key()) or {}
	return raw if isinstance(raw, dict) else {}


# --- settings / desktop -------------------------------------------------------


@frappe.whitelist()
def ping():
	"""Cheap probe so OpsAi can confirm this site has the OpsAi app."""
	return {"ok": True, "app": "opsai"}


@frappe.whitelist()
def probe_gateway(gateway_url: str | None = None):
	"""Check that the Gateway URL reaches a Hermes Agent (no credentials required)."""
	_require_access()
	url = (gateway_url or "").strip().rstrip("/")
	if not url:
		return {"ok": False, "message": _("Gateway URL is required")}
	if not re.match(r"^https?://", url, re.I):
		return {"ok": False, "message": _("Gateway URL must start with http:// or https://")}

	from urllib.error import HTTPError, URLError
	from urllib.request import Request

	from opsai.hermes import _NoRedirect, _opener, is_login_redirect

	signals = ("Hermes Agent", "Sign in — Hermes", "hermes-agent", "/auth/password-login")
	tried = []
	for path in ("/login", "/", "/v1/models"):
		target = f"{url}{path}"
		tried.append(target)
		req = Request(target, headers={"Accept": "text/html, application/json"}, method="GET")
		try:
			with _opener().open(req, timeout=12) as resp:
				raw = resp.read().decode("utf-8", errors="replace")
				code = getattr(resp, "status", 200)
				headers = resp.headers
		except HTTPError as err:
			raw = err.read().decode("utf-8", errors="replace") if err.fp else ""
			code = err.code
			headers = err.headers
		except URLError as err:
			return {
				"ok": False,
				"message": _("Could not reach {0}: {1}").format(url, err.reason or err),
			}
		except Exception as err:
			return {"ok": False, "message": str(err)}

		blob = f"{raw}\n{headers}"
		server = ""
		try:
			server = headers.get("Server") or headers.get("server") or ""
		except Exception:
			pass
		hermes_like = any(s.lower() in blob.lower() for s in signals) or "uvicorn" in server.lower()
		# Hermes often 302s /v1/models → /login when unauthenticated — that still counts.
		if hermes_like or is_login_redirect(code, headers, raw):
			return {
				"ok": True,
				"message": _("Hermes Agent is available at {0}").format(url),
				"gateway_url": url,
				"checked": path,
			}

	return {
		"ok": False,
		"message": _(
			"No Hermes Agent detected at {0}. Open the URL in a browser — you should see the Hermes Sign in page."
		).format(url),
		"tried": tried,
	}


@frappe.whitelist(methods=["POST"])
def connect_hermes(
	user: str | None = None,
	gateway_url: str | None = None,
	gateway_username: str | None = None,
	gateway_password: str | None = None,
	session_token: str | None = None,
	auth_mode: str | None = None,
):
	"""Connect with password (dashboard login) or token (API_SERVER_KEY Bearer)."""
	_require_access()
	target = user or frappe.session.user
	if (
		target != frappe.session.user
		and "System Manager" not in frappe.get_roles()
		and frappe.session.user != "Administrator"
	):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	try:
		settings = get_user_settings(target)
	except Exception as err:
		return {"ok": False, "connected": False, "message": str(err)}

	mode = (auth_mode or settings.get("auth_mode") or "password").strip()
	settings["auth_mode"] = mode

	if gateway_url is not None and str(gateway_url).strip():
		settings["gateway_url"] = str(gateway_url).strip()
	if gateway_username is not None and str(gateway_username).strip():
		settings["gateway_username"] = str(gateway_username).strip()
	if gateway_password is not None and str(gateway_password).strip():
		settings["gateway_password"] = str(gateway_password).strip()
	if session_token is not None and str(session_token).strip():
		settings["session_token"] = str(session_token).strip()
		settings["session_cookies"] = {}

	_persist_connect_credentials(
		target,
		gateway_url=settings.get("gateway_url"),
		gateway_username=settings.get("gateway_username"),
		gateway_password=settings.get("gateway_password")
		if gateway_password and str(gateway_password).strip()
		else None,
		session_token=settings.get("session_token")
		if session_token and str(session_token).strip()
		else None,
		auth_mode=mode,
	)

	gateway = (settings.get("gateway_url") or "").strip()
	if not gateway:
		return {"ok": False, "connected": False, "message": _("Gateway URL is required")}

	cookies = {}
	if mode == "token":
		if not (settings.get("session_token") or "").strip():
			return {
				"ok": False,
				"connected": False,
				"message": _("API Server Key is required. Paste Hermes API_SERVER_KEY and click Connect."),
			}
	else:
		if not (settings.get("gateway_username") or "").strip() or not (
			settings.get("gateway_password") or ""
		).strip():
			return {
				"ok": False,
				"connected": False,
				"message": _(
					"Username and Password are required. Re-enter the Hermes password and click Connect "
					"(saved passwords are not visible to the browser after reload)."
				),
			}
		from opsai.hermes import HermesError, password_login

		try:
			cookies = password_login(settings, persist=True)
		except HermesError as err:
			frappe.clear_messages()
			_set_connection_status(target, _("Disconnected"))
			return {"ok": False, "connected": False, "message": str(err)}
		except Exception as err:
			frappe.clear_messages()
			_set_connection_status(target, _("Disconnected"))
			return {"ok": False, "connected": False, "message": str(err)}

	# Verify chat path (gateway WS) + optional history REST — same as OpsPilot.
	sessions_ok, _sessions_body, sessions_err = try_request(
		"GET", "/api/sessions", settings=settings, params={"limit": 1}, timeout=20
	)
	ws_ok = False
	ws_err = None
	try:
		from opsai.hermes_gateway import GatewayClient

		with GatewayClient(settings, timeout=15) as gw:
			gw.rpc("gateway.ping", {}, timeout=10)
		ws_ok = True
	except Exception as err:
		ws_err = str(err)

	if ws_ok:
		seed = _seed_default_model_from_hermes(target, settings)
		msg = _("Connected to Hermes as {0} — chat ready.").format(
			settings.get("gateway_username") or target
		)
		if sessions_ok:
			msg += _(" Session history available.")
		if seed.get("model"):
			msg += _(" Default model: {0}.").format(seed["model"])
		_set_connection_status(target, _("Connected"))
		return {
			"ok": True,
			"connected": True,
			"gateway_ws": True,
			"sessions_api": sessions_ok,
			"message": msg,
			"cookies": list(cookies.keys()),
			"gateway_url": gateway,
			"default_provider": seed.get("provider") or "",
			"default_model": seed.get("model") or "",
			"model_seeded": bool(seed.get("seeded")),
		}

	_set_connection_status(target, _("Disconnected"))
	return {
		"ok": False,
		"connected": False,
		"gateway_ws": False,
		"message": ws_err or sessions_err or _("Signed in but Hermes gateway is unreachable"),
		"gateway_url": gateway,
	}


def _set_connection_status(user: str, status: str):
	if frappe.db.exists("OpsAi Settings", user):
		frappe.db.set_value("OpsAi Settings", user, "connection_status", status, update_modified=False)


def _persist_connect_credentials(
	user: str,
	*,
	gateway_url: str | None = None,
	gateway_username: str | None = None,
	gateway_password: str | None = None,
	session_token: str | None = None,
	auth_mode: str | None = None,
):
	"""Write Connect form values onto OpsAi Settings before login."""
	if not user or not frappe.db.exists("OpsAi Settings", user):
		return
	doc = frappe.get_doc("OpsAi Settings", user)
	changed = False
	if gateway_url and doc.gateway_url != gateway_url:
		doc.gateway_url = gateway_url
		changed = True
	if gateway_username is not None and doc.gateway_username != gateway_username:
		doc.gateway_username = gateway_username
		changed = True
	if gateway_password:
		doc.gateway_password = gateway_password
		changed = True
	if session_token:
		doc.session_token = session_token
		changed = True
	if auth_mode and doc.auth_mode != auth_mode:
		doc.auth_mode = auth_mode
		changed = True
	if changed:
		doc.save(ignore_permissions=True)
		frappe.db.commit()  # nosemgrep: frappe-manual-commit


@frappe.whitelist()
def test_connection(user: str | None = None):
	"""Probe Hermes the same way chat does: gateway WS + /api/sessions history."""
	_require_access()
	target = user or frappe.session.user
	if (
		target != frappe.session.user
		and "System Manager" not in frappe.get_roles()
		and frappe.session.user != "Administrator"
	):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	try:
		settings = get_user_settings(target)
	except Exception as err:
		return {"ok": False, "connected": False, "message": str(err)}

	gateway = (settings.get("gateway_url") or "").strip()
	if not gateway:
		return {"ok": False, "connected": False, "message": _("Gateway URL is required")}

	# Password mode with credentials but no cookies yet — sign in first.
	auth_mode = (settings.get("auth_mode") or "password").strip()
	if (
		auth_mode == "password"
		and not (settings.get("session_cookies") or {})
		and (settings.get("gateway_username") or "").strip()
		and (settings.get("gateway_password") or "").strip()
	):
		from opsai.hermes import password_login

		try:
			password_login(settings, persist=True)
		except Exception as err:
			frappe.clear_messages()
			_set_connection_status(target, _("Disconnected"))
			return {"ok": False, "connected": False, "message": str(err), "gateway_url": gateway}

	sessions_ok, _sessions_body, sessions_err = try_request(
		"GET", "/api/sessions", settings=settings, params={"limit": 1}, timeout=20
	)

	# Chat uses gateway WebSocket JSON-RPC (OpsPilot), not /v1 on the dashboard port.
	ws_ok = False
	ws_err = None
	try:
		from opsai.hermes_gateway import GatewayClient

		with GatewayClient(settings, timeout=15) as gw:
			gw.rpc("gateway.ping", {}, timeout=10)
		ws_ok = True
	except Exception as err:
		ws_err = str(err)

	if ws_ok:
		_set_connection_status(target, _("Connected"))
		msg = _("Connected to Hermes gateway at {0} — chat ready.").format(gateway.rstrip("/"))
		if sessions_ok:
			msg += _(" Session history available.")
		elif sessions_err:
			msg += _(" History: {0}").format(sessions_err)
		return {
			"ok": True,
			"connected": True,
			"gateway_ws": True,
			"sessions_api": sessions_ok,
			"message": msg,
			"gateway_url": gateway,
		}

	if sessions_ok:
		_set_connection_status(target, _("Disconnected"))
		return {
			"ok": False,
			"connected": False,
			"gateway_ws": False,
			"sessions_api": True,
			"message": _("History works, but chat gateway failed: {0}").format(ws_err or _("unknown")),
			"gateway_url": gateway,
		}

	_set_connection_status(target, _("Disconnected"))
	hint = ws_err or sessions_err or _("Connection failed")
	low = hint.lower()
	if "login" in low or "no_cookie" in low or "unauthenticated" in low or "not connected" in low:
		hint = _(
			"{0} — Enter Hermes Username and Password, then click Connect."
		).format(hint)
	return {
		"ok": False,
		"connected": False,
		"gateway_ws": False,
		"sessions_api": False,
		"message": hint,
		"gateway_url": gateway,
	}


@frappe.whitelist()
def get_my_opsai_settings():
	"""Return the signed-in user's OpsAi Settings, including Password fields."""
	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw(_("Not logged in"), frappe.AuthenticationError)

	if not frappe.db.exists("OpsAi Settings", user):
		return None

	from opsai.hermes import get_user_settings as load_settings

	return load_settings(user)


@frappe.whitelist()
def list_hermes_models(user: str | None = None):
	"""Hermes Desktop–style model catalog from /api/model/options + /api/model/info."""
	_require_access()
	target = user or frappe.session.user
	if not _can_manage_settings_user(target):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	try:
		settings = get_user_settings(target)
	except Exception as err:
		return {"ok": False, "message": str(err), "providers": [], "models": []}

	live_model, live_provider, _ctx = _read_hermes_model_info(settings)
	ok, options, err = try_request("GET", "/api/model/options", settings=settings, timeout=30)
	providers_out = []
	models_out = []
	if ok and isinstance(options, dict):
		live_model = (options.get("model") or live_model or "").strip() or live_model
		live_provider = (options.get("provider") or live_provider or "").strip() or live_provider
		for row in options.get("providers") or []:
			if not isinstance(row, dict):
				continue
			slug = (row.get("slug") or row.get("name") or "").strip()
			if not slug:
				continue
			model_ids = [str(m) for m in (row.get("models") or []) if m]
			providers_out.append(
				{
					"slug": slug,
					"name": row.get("name") or slug,
					"is_current": bool(row.get("is_current"))
					or slug.lower() == (live_provider or "").lower(),
					"models": model_ids,
				}
			)
			for mid in model_ids:
				models_out.append(_model_row(mid, slug))

	# Always include the live / saved default so Autocomplete has a value.
	saved = (settings.get("default_model") or "").strip()
	for mid, prov in (
		(live_model, live_provider),
		(saved, settings.get("default_provider") or live_provider),
	):
		if mid and not any(m["name"] == mid for m in models_out):
			models_out.insert(0, _model_row(mid, prov or "hermes"))

	return {
		"ok": True,
		"provider": live_provider or settings.get("default_provider") or "",
		"model": live_model or saved or "",
		"default_provider": settings.get("default_provider") or live_provider or "",
		"default_model": saved or live_model or "",
		"providers": providers_out,
		"models": models_out,
		"error": None if ok else err,
	}


@frappe.whitelist(methods=["POST"])
def apply_hermes_model(
	provider: str | None = None,
	model: str | None = None,
	user: str | None = None,
	confirm_expensive_model: int | None = None,
):
	"""Persist default on OpsAi Settings and POST /api/model/set (Desktop scope=main)."""
	_require_access()
	target = user or frappe.session.user
	if not _can_manage_settings_user(target):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	provider = (provider or "").strip()
	model = (model or "").strip()
	if not model:
		frappe.throw(_("Model is required"))

	try:
		settings = get_user_settings(target)
	except Exception as err:
		return {"ok": False, "message": str(err)}

	if not provider:
		_live_model, live_provider, _ctx = _read_hermes_model_info(settings)
		provider = (settings.get("default_provider") or live_provider or "").strip()
	if not provider:
		frappe.throw(_("Provider is required"))

	body = {"scope": "main", "provider": provider, "model": model}
	if confirm_expensive_model:
		body["confirm_expensive_model"] = True

	ok, payload, err = try_request(
		"POST", "/api/model/set", settings=settings, body=body, timeout=60
	)
	if not ok:
		# Retry once with confirm flag when Hermes asks (Desktop selection guard).
		detail = err or ""
		if isinstance(payload, dict) and payload.get("confirm_required"):
			return {
				"ok": False,
				"confirm_required": True,
				"confirm_message": payload.get("confirm_message") or detail,
				"provider": provider,
				"model": model,
			}
		return {"ok": False, "message": detail or _("Failed to set Hermes model")}

	if isinstance(payload, dict) and payload.get("confirm_required") and not confirm_expensive_model:
		return {
			"ok": False,
			"confirm_required": True,
			"confirm_message": payload.get("confirm_message") or _("Confirm this model choice"),
			"provider": provider,
			"model": model,
		}

	if isinstance(payload, dict) and payload.get("ok") is False:
		return {
			"ok": False,
			"message": payload.get("confirm_message") or payload.get("detail") or _("Hermes refused the model"),
		}

	applied_provider = provider
	applied_model = model
	if isinstance(payload, dict):
		applied_provider = (payload.get("provider") or provider).strip()
		applied_model = (payload.get("model") or model).strip()

	_persist_default_model(target, applied_provider, applied_model)
	return {
		"ok": True,
		"provider": applied_provider,
		"model": applied_model,
		"message": _("Default model set to {0} ({1})").format(applied_model, applied_provider),
		"gateway_tools": (payload or {}).get("gateway_tools") if isinstance(payload, dict) else None,
	}


# --- chat boot / catalog ------------------------------------------------------


@frappe.whitelist()
def boot() -> dict[str, Any]:
	"""What the OpsAi island needs before its first call (Hermes-backed)."""
	_require_access()
	settings = None
	try:
		settings = get_user_settings()
	except Exception:
		settings = None

	configured = bool(settings and (settings.get("gateway_url") or "").strip())
	models = _hermes_models_catalog(settings) if configured else []
	default_model = (settings or {}).get("default_model") or (models[0]["name"] if models else None)
	default_provider = (settings or {}).get("default_provider") or (
		models[0].get("provider") if models else None
	)

	user = frappe.db.get_value(
		"User", frappe.session.user, ["name", "full_name", "email", "user_image"], as_dict=True
	)
	return {
		"agents": (
			[{"name": "hermes", "title": "OpsAi", "model": models[0]["name"]}] if models else []
		),
		"default_agent": "hermes" if models else None,
		"models": models,
		"default_model": default_model,
		"default_provider": default_provider,
		"providers": ["hermes"] if configured else [],
		"file_types": [],
		"prefs": _user_prefs(),
		"unavailable_tools": [],
		"user": user,
		"permissions": {
			"OpsAi Settings": [
				ptype
				for ptype in ("read", "write", "create", "delete")
				if frappe.has_permission("OpsAi Settings", ptype)
			]
		},
		"hermes_configured": configured,
		"hermes_session_key": session_key() if configured else None,
	}


@frappe.whitelist()
def set_prefs(prefs: dict | str | None = None):
	_require_access()
	if isinstance(prefs, str):
		prefs = json.loads(prefs or "{}")
	prefs = prefs or {}
	allowed = {"mode", "separateToolCalls"}
	current = _user_prefs()
	current.update({k: v for k, v in prefs.items() if k in allowed})
	frappe.cache().set_value(_prefs_key(), current)
	return {"ok": True, "prefs": current}


# --- sessions (Hermes /api/sessions) ------------------------------------------

# OpsAi approval labels ↔ Hermes per-session `yolo` (PATCH /api/sessions/{id}).
# Auto-approve → yolo=true (skip dangerous-command prompts). Ask/Auto → yolo=false.
# Hermes smart vs manual is gateway config (`approvals.mode`); REST only toggles yolo.
APPROVAL_LABELS = ("Ask", "Auto", "Auto-approve")


def _approval_cache_key(session: str) -> str:
	return f"opsai_approval::{frappe.session.user}::{session}"


def _store_approval_mode(session: str, mode: str | None):
	if not session or not mode:
		return
	if mode not in APPROVAL_LABELS:
		return
	frappe.cache().set_value(_approval_cache_key(session), mode)


def _cached_approval_mode(session: str) -> str | None:
	raw = frappe.cache().get_value(_approval_cache_key(session))
	return raw if raw in APPROVAL_LABELS else None


def _approval_from_hermes(row: dict, session: str | None = None) -> str:
	"""Map Hermes session fields (+ our cache) to a Flow approval label."""
	sid = session or _session_id(row)
	cached = _cached_approval_mode(sid) if sid else None
	yolo = row.get("yolo")
	if yolo is True or str(yolo).lower() in ("1", "true", "yes"):
		return "Auto-approve"
	if cached in ("Ask", "Auto"):
		return cached
	if cached == "Auto-approve" and not yolo:
		# Cache said YOLO but Hermes says off — trust Hermes.
		return "Ask"
	return cached or "Ask"


def _hermes_yolo(mode: str | None) -> bool:
	return (mode or "").strip() == "Auto-approve"


def _apply_hermes_yolo(session: str, mode: str | None):
	"""Push approval preference to Hermes as session yolo (no-op if sessions API blocked)."""
	if not session:
		return
	ok, _body, _err = try_request(
		"PATCH",
		f"/api/sessions/{session}",
		body={"yolo": _hermes_yolo(mode)},
		timeout=30,
	)
	if not ok:
		# /v1 chat still honors X-Hermes-Session-Id; yolo may need gateway config.
		return


def _local_sessions_key() -> str:
	return f"opsai_local_sessions::{frappe.session.user}"


def _transcript_key(session: str) -> str:
	return f"opsai_transcript::{frappe.session.user}::{session}"


def _event_log_key(session: str) -> str:
	return f"opsai_event_log::{frappe.session.user}::{session}"


def _preview_key(session: str) -> str:
	return f"opsai_preview::{frappe.session.user}::{session}"


def _defaults_sessions_key() -> str:
	return "opsai_chat_sessions"


def _defaults_transcript_key(session: str) -> str:
	return f"opsai_chat_transcript::{session}"


def _load_local_sessions() -> list[dict]:
	raw = frappe.cache().get_value(_local_sessions_key())
	if isinstance(raw, list):
		return raw
	# Durable fallback (survives cache flush / multi-worker).
	stored = frappe.defaults.get_user_default(_defaults_sessions_key()) or "[]"
	try:
		parsed = json.loads(stored)
		return parsed if isinstance(parsed, list) else []
	except (TypeError, ValueError):
		return []


def _save_local_sessions(rows: list[dict]):
	frappe.cache().set_value(_local_sessions_key(), rows)
	frappe.defaults.set_user_default(_defaults_sessions_key(), json.dumps(rows[:LIST_LIMIT]))


def _upsert_local_session(row: dict):
	sid = _session_id(row)
	if not sid:
		return
	rows = [r for r in _load_local_sessions() if _session_id(r) != sid]
	rows.insert(0, row)
	_save_local_sessions(rows[:LIST_LIMIT])


def _load_transcript(session: str) -> list[dict]:
	raw = frappe.cache().get_value(_transcript_key(session))
	if isinstance(raw, list):
		return raw
	stored = frappe.defaults.get_user_default(_defaults_transcript_key(session)) or "[]"
	try:
		parsed = json.loads(stored)
		return parsed if isinstance(parsed, list) else []
	except (TypeError, ValueError):
		return []


def _save_transcript(session: str, messages: list[dict]):
	# Keep last ~200 messages per chat to bound defaults size.
	trimmed = messages[-200:]
	frappe.cache().set_value(_transcript_key(session), trimmed)
	frappe.defaults.set_user_default(_defaults_transcript_key(session), json.dumps(trimmed))


def _append_transcript(session: str, role: str, text: str):
	messages = _load_transcript(session)
	messages.append({"role": role, "content": text})
	_save_transcript(session, messages)


def _session_id(row: dict) -> str:
	# Prefer durable stored id (OpsPilot) — live/runtime ids go stale after gateway restart.
	return str(
		row.get("stored_session_id")
		or row.get("id")
		or row.get("session_id")
		or row.get("name")
		or ""
	)


def _session_row(row: dict) -> dict:
	sid = _session_id(row)
	live = str(row.get("live_id") or row.get("session_id") or "")
	out = {
		"name": sid,
		"title": row.get("title") or row.get("name") or "Chat",
		"agent": "hermes",
		"model": row.get("model") or row.get("model_override") or HERMES_MODEL,
		"modified": row.get("updated_at") or row.get("modified") or row.get("created_at") or "",
		"approval_mode": _approval_from_hermes(row, sid),
		"owner": frappe.session.user,
		"owner_name": frappe.db.get_value("User", frappe.session.user, "full_name"),
		"read_only": False,
		"general_access": "Restricted",
		"runs": [],
	}
	if live and live != sid:
		out["live_id"] = live
	return out


@frappe.whitelist()
def list_sessions(limit: int = LIST_LIMIT, query: str | None = None, before: str | None = None):
	_require_access()
	ok, payload, _err = try_request(
		"GET",
		"/api/sessions",
		params={"limit": int(limit or LIST_LIMIT), "offset": 0},
		timeout=30,
	)
	if ok:
		rows = (
			payload
			if isinstance(payload, list)
			else (payload or {}).get("sessions") or (payload or {}).get("data") or []
		)
		out = [_session_row(r) for r in rows if _session_id(r)]
	else:
		# /api/sessions blocked (often Frappe catching /api/*) — use local /v1-backed chats.
		out = [_session_row(r) for r in _load_local_sessions() if _session_id(r)]
	if query:
		q = query.lower()
		out = [r for r in out if q in (r.get("title") or "").lower()]
	if before:
		idx = next((i for i, r in enumerate(out) if r.get("modified") == before), -1)
		out = out[idx + 1 :] if idx >= 0 else out
	return out[: int(limit or LIST_LIMIT)]


@frappe.whitelist(methods=["POST"])
def create_session(
	agent: str | None = None,
	model: str | None = None,
	title: str | None = None,
	approval_mode: str | None = None,
):
	"""Create a Hermes session via gateway WS (OpsPilot session.create) — not REST POST /api/sessions."""
	_require_access()
	try:
		data = create_gateway_session(title=title, approval_mode=approval_mode)
	except HermesError as err:
		frappe.throw(str(err))

	sid = _session_id(data)
	if model:
		data["model"] = model
	if approval_mode and sid:
		_store_approval_mode(sid, approval_mode)
		_apply_hermes_yolo(sid, approval_mode)
		data["yolo"] = _hermes_yolo(approval_mode)
	data.setdefault("created_at", frappe.utils.now_datetime().isoformat())
	row = _session_row(data)
	_upsert_local_session({**data, **row})
	return row


@frappe.whitelist()
def session(session: str):
	_require_access()
	ok, data, _err = try_request("GET", f"/api/sessions/{session}", timeout=30)
	if not ok or not isinstance(data, dict):
		local = next((r for r in _load_local_sessions() if _session_id(r) == session), None)
		data = local or {"id": session}
	data.setdefault("id", session)
	return _session_row(data)


@frappe.whitelist(methods=["POST"])
def set_title(session: str, title: str):
	_require_access()
	ok, data, _err = try_request(
		"PATCH", f"/api/sessions/{session}", body={"title": title}, timeout=30
	)
	if not ok or not isinstance(data, dict):
		data = {"id": session, "title": title}
	data.setdefault("id", session)
	data["title"] = title
	row = _session_row(data)
	_upsert_local_session({**data, **row})
	return row


@frappe.whitelist(methods=["POST"])
def set_model(session: str, model: str):
	_require_access()
	# Hermes routes model per request; persist preference on the UI row.
	return {"model": model}


@frappe.whitelist(methods=["POST"])
def set_approval_mode(session: str, mode: str):
	"""Map OpsAi approval mode onto Hermes session yolo and remember Ask vs Auto."""
	_require_access()
	mode = (mode or "Ask").strip()
	if mode not in APPROVAL_LABELS:
		frappe.throw(_("Unknown approval mode: {0}").format(mode))
	_store_approval_mode(session, mode)
	_apply_hermes_yolo(session, mode)
	return {"approval_mode": mode, "yolo": _hermes_yolo(mode)}


@frappe.whitelist(methods=["POST"])
def delete_session(session: str):
	_require_access()
	try_request("DELETE", f"/api/sessions/{session}", timeout=30)
	rows = [r for r in _load_local_sessions() if _session_id(r) != session]
	_save_local_sessions(rows)
	return {"ok": True}


# --- transcript ---------------------------------------------------------------


def _message_text(content) -> str:
	if content is None:
		return ""
	if isinstance(content, str):
		return content
	if isinstance(content, list):
		parts = []
		for block in content:
			if isinstance(block, str):
				parts.append(block)
			elif isinstance(block, dict):
				parts.append(block.get("text") or block.get("content") or "")
		return "".join(parts)
	if isinstance(content, dict):
		return content.get("text") or content.get("content") or json.dumps(content)
	return str(content)


def _messages_to_entries(messages: list) -> list[dict]:
	"""Map Hermes message history into Flow-compatible transcript events."""
	entries: list[dict] = []
	seq = 0
	for msg in messages or []:
		role = (msg.get("role") or msg.get("type") or "").lower()
		text = _message_text(msg.get("content") or msg.get("text") or msg.get("message"))
		if role in ("system",):
			continue
		if role in ("user", "human"):
			seq += 1
			entries.append({"type": "run_started", "seq": seq, "ts": time.time()})
			seq += 1
			entries.append(
				{
					"type": "user_message",
					"seq": seq,
					"content": [{"type": "text", "text": text}],
					"ts": time.time(),
				}
			)
		elif role in ("assistant", "agent", "model"):
			seq += 1
			entries.append(
				{
					"type": "assistant_message",
					"seq": seq,
					"content": [{"type": "text", "text": text}],
					"ts": time.time(),
				}
			)
			seq += 1
			entries.append({"type": "run_ended", "seq": seq, "reason": "completed", "ts": time.time()})
		elif role == "tool":
			# keep tool noise out of the main transcript for now
			continue
	return entries


def _load_event_log(session: str) -> list[dict]:
	raw = frappe.cache().get_value(_event_log_key(session))
	return raw if isinstance(raw, list) else []


def _save_event_log(session: str, entries: list[dict]):
	frappe.cache().set_value(_event_log_key(session), entries[-500:])


def _append_events(session: str, events: list[dict]) -> list[dict]:
	"""Append durable Flow events with monotonic seq (SessionStream cursor)."""
	log = _load_event_log(session)
	seq = int(log[-1].get("seq") or 0) if log else 0
	out: list[dict] = []
	now = time.time()
	for event in events:
		seq += 1
		row = {**event, "seq": seq, "ts": event.get("ts") or now}
		log.append(row)
		out.append(row)
	_save_event_log(session, log)
	return out


def _load_preview(session: str) -> list[dict]:
	raw = frappe.cache().get_value(_preview_key(session))
	return raw if isinstance(raw, list) else []


def _save_preview(session: str, events: list[dict]):
	frappe.cache().set_value(_preview_key(session), events[-400:])


def _clear_preview(session: str):
	frappe.cache().set_value(_preview_key(session), [])


def _append_preview(session: str, events: list[dict]):
	if not events:
		return
	preview = _load_preview(session)
	preview.extend(events)
	_save_preview(session, preview)


def _fetch_session_messages(session: str) -> list:
	ok, payload, _err = try_request(
		"GET",
		f"/api/sessions/{session}/messages",
		params={"inline_images": "false"},
		timeout=60,
	)
	if ok:
		if isinstance(payload, dict):
			return payload.get("messages") or payload.get("data") or payload.get("items") or []
		return payload or []
	return _load_transcript(session)


def _ensure_event_log(session: str) -> list[dict]:
	"""Prefer the live event log; bootstrap once from Hermes/local messages."""
	log = _load_event_log(session)
	if log:
		return log
	boot = _messages_to_entries(_fetch_session_messages(session))
	if boot:
		_save_event_log(session, boot)
	return boot


def _tool_id(payload: dict) -> str:
	return str(
		payload.get("tool_call_id")
		or payload.get("call_id")
		or payload.get("id")
		or payload.get("request_id")
		or uuid.uuid4()
	)


def _tool_name(payload: dict) -> str:
	return str(payload.get("name") or payload.get("tool") or payload.get("tool_name") or "tool")


def _hermes_event_to_preview(etype: str, payload: dict) -> list[dict]:
	"""Map Hermes gateway events → Flow preview deltas (OpsPilot / Desktop parity)."""
	if not isinstance(payload, dict):
		payload = {}
	events: list[dict] = []

	if etype in ("message.delta", "message.interim"):
		text = payload.get("text") or payload.get("delta") or payload.get("content") or ""
		if text:
			events.append({"type": "text_delta", "text": str(text)})
	elif etype in ("thinking.delta", "reasoning.delta"):
		text = payload.get("text") or payload.get("delta") or payload.get("content") or ""
		if text:
			events.append({"type": "thinking_delta", "thinking": str(text)})
	elif etype == "tool.start":
		tid = _tool_id(payload)
		name = _tool_name(payload)
		args = payload.get("input") or payload.get("args") or payload.get("arguments") or {}
		if not isinstance(args, dict):
			args = {"input": args}
		display = payload.get("summary") or payload.get("display")
		events.append({"type": "tool_call_started", "id": tid, "name": name})
		events.append(
			{
				"type": "tool_call_display_ready",
				"id": tid,
				"name": name,
				"arguments": args,
				"display": display,
			}
		)
	elif etype in ("tool.complete", "tool.progress"):
		# Preview already shows the call; durable tool_result lands with the final message.
		pass

	return events


def _fail_hermes_turn(session: str, message: str):
	_clear_preview(session)
	_append_events(
		session,
		[
			{"type": "run_error", "message": message},
			{"type": "run_ended", "reason": "error"},
		],
	)


def _complete_hermes_turn(session: str, message: str) -> str:
	"""Run one Hermes turn, streaming preview events for SessionStream polls."""

	def on_event(etype: str, payload: dict):
		try:
			_append_preview(session, _hermes_event_to_preview(etype, payload))
		except Exception:
			pass

	try:
		assistant = run_gateway_turn(session, message, timeout=300, on_event=on_event)
	except HermesError as err:
		_fail_hermes_turn(session, str(err))
		raise
	except Exception as err:
		_fail_hermes_turn(session, str(err) or _("Hermes turn failed"))
		raise

	_clear_preview(session)
	if assistant:
		# Pull HTML/PDF workspace files into the user's private folder and rewrite
		# Hermes paths / ::preview{file=…} to Frappe private URLs (OpsPilot parity).
		ingested = ingest_assistant_artifacts(session, assistant)
		final_text = ingested.get("text") or assistant
		artifacts = ingested.get("artifacts") or []
		_append_transcript(session, "assistant", final_text)
		content = [{"type": "text", "text": final_text}]
		for art in artifacts:
			content.append(
				{
					"type": "file_artifact",
					"id": art.get("file_name") or art.get("fid"),
					"name": art.get("filename"),
					"file_url": art.get("file_url"),
					"fid": art.get("fid") or art.get("file_name"),
					"hermes_path": art.get("hermes_path"),
					"ext": art.get("ext"),
				}
			)
		_append_events(
			session,
			[
				{"type": "assistant_message", "content": content},
				{"type": "run_ended", "reason": "completed"},
			],
		)
		_upsert_local_session(
			{
				"id": session,
				"stored_session_id": session,
				"title": (message[:48] or "Chat"),
				"modified": frappe.utils.now_datetime().isoformat(),
				"model": HERMES_MODEL,
			}
		)
		return final_text
	_append_events(session, [{"type": "run_ended", "reason": "completed"}])
	return ""


def _start_hermes_turn_background(session: str, message: str):
	"""Non-blocking turn so Desk SessionStream can poll preview mid-reply."""
	site = frappe.local.site
	user = frappe.session.user

	def _worker():
		try:
			frappe.init(site=site)
			frappe.connect()
			frappe.set_user(user)
			try:
				_complete_hermes_turn(session, message)
				# Background threads do not auto-commit — without this, private File
				# rows roll back on destroy while the Redis transcript keeps their URLs
				# (Preview/Download then 403 Forbidden).
				frappe.db.commit()
			except Exception:
				frappe.db.rollback()
				frappe.log_error(title="OpsAi Hermes turn failed")
		finally:
			try:
				frappe.destroy()
			except Exception:
				pass

	threading.Thread(target=_worker, name=f"opsai-turn-{session[:12]}", daemon=True).start()


@frappe.whitelist()
def entries(session: str, since: int = 0, path: str = "active"):
	"""Durable Flow events + live preview deltas (replayed each poll like Flow)."""
	_require_access()
	all_entries = _ensure_event_log(session)
	since = int(since or 0)
	filtered = [e for e in all_entries if (e.get("seq") or 0) > since]
	latest = all_entries[-1]["seq"] if all_entries else 0
	preview = _load_preview(session)
	return {"entries": filtered, "latest_seq": latest, "preview": preview}


@frappe.whitelist(methods=["POST"])
def run(session: str, message: str, attachments: list | None = None):
	"""Start a Hermes turn; stream thinking/text/tools into preview while it runs."""
	_require_access()
	message = (message or "").strip()
	if not message:
		frappe.throw(_("Message is required"))

	_ensure_event_log(session)
	_append_transcript(session, "user", message)
	_clear_preview(session)
	_append_events(
		session,
		[
			{"type": "run_started"},
			{"type": "user_message", "content": [{"type": "text", "text": message}]},
		],
	)
	_start_hermes_turn_background(session, message)
	return {"status": "running"}


@frappe.whitelist(methods=["POST"])
def sync_session(session: str):
	_require_access()
	return session(session)


@frappe.whitelist(methods=["POST"])
def resume(session: str, answers: dict | list | None = None, approval_seq: int | None = None):
	_require_access()
	frappe.throw(_("Approvals are not available with Hermes yet."))


@frappe.whitelist(methods=["POST"])
def abort(session: str):
	_require_access()
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def screen_result(session: str, token: str, screen: str | None = None, error: str | None = None):
	_require_access()
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def cancel_pending(session: str):
	_require_access()
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def rewind(session: str, target_seq: int = 0):
	_require_access()
	frappe.throw(_("Rewind is not available with Hermes yet."))


@frappe.whitelist(methods=["POST"])
def compact(session: str):
	_require_access()
	return {"ok": True}


@frappe.whitelist()
def skills(session: str | None = None, agent: str | None = None):
	_require_access()
	try:
		payload = hermes_request("GET", "/v1/skills", timeout=30)
		rows = payload if isinstance(payload, list) else (payload or {}).get("skills") or []
		return {"skills": rows}
	except Exception:
		return {"skills": []}


@frappe.whitelist()
def system_prompt(session: str):
	_require_access()
	return None


@frappe.whitelist()
def list_shares(session: str):
	_require_access()
	return []


@frappe.whitelist()
def find_users(query: str | None = None):
	_require_access()
	return []


@frappe.whitelist(methods=["POST"])
def share_session(session: str, user: str):
	_require_access()
	frappe.throw(_("Sharing is not available with Hermes yet."))


@frappe.whitelist(methods=["POST"])
def unshare_session(session: str, user: str):
	_require_access()
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def set_general_access(session: str, access: str):
	_require_access()
	return {"general_access": access}


@frappe.whitelist(methods=["POST"])
def import_artifact(path: str, session: str | None = None):
	"""Fetch a Hermes workspace HTML/PDF into the user's private Home/OpsAi folder."""
	_require_access()
	path = (path or "").strip()
	if not path:
		frappe.throw(_("File path is required"))
	try:
		row = import_hermes_path(path, session=session)
	except HermesError as err:
		frappe.throw(str(err))
	frappe.db.commit()
	return row


@frappe.whitelist()
def artifact_file(file_url: str | None = None, fid: str | None = None):
	"""Serve a private OpsAi artifact the current user owns (Preview / Download)."""
	_require_access()
	file_url = (file_url or "").strip()
	fid = (fid or "").strip() or None
	if not file_url and not fid:
		frappe.throw(_("file_url is required"))

	from frappe.core.doctype.file.utils import find_file_by_url

	doc = None
	if fid and frappe.db.exists("File", fid):
		doc = frappe.get_doc("File", fid)
	elif file_url:
		doc = find_file_by_url(file_url, name=fid)

	if not doc:
		frappe.throw(_("File not found"), frappe.DoesNotExistError)
	if not doc.has_permission("read"):
		frappe.throw(_("You don't have permission to access this file"), frappe.PermissionError)

	import mimetypes
	from os.path import basename

	filename = doc.file_name or basename((doc.file_url or "").split("?")[0]) or "download"
	as_download = frappe.form_dict.get("download") in (1, "1", True, "true")
	frappe.local.response.filename = filename
	frappe.local.response.filecontent = doc.get_content()
	frappe.local.response.type = "download"  # as_raw — honors display_content_as
	frappe.local.response.display_content_as = "attachment" if as_download else "inline"
	frappe.local.response.content_type = (
		mimetypes.guess_type(filename)[0] or "application/octet-stream"
	)


@frappe.whitelist(methods=["POST"])
def attach_file(file: str, model: str | None = None):
	_require_access()
	frappe.throw(_("Attachments are not available with Hermes yet."))


@frappe.whitelist(methods=["POST"])
def cleanup_attachments(attachments: list | None = None, session: str | None = None):
	_require_access()
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def save_secret(session: str, call_id: str, password: str):
	_require_access()
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def submit_feedback(run_name: str, rating: int, comment: str | None = None):
	_require_access()
	return {"ok": True}


# --- setup stubs (Flow provider UI → Hermes uses OpsAi Settings) --------------


@frappe.whitelist()
def setup_options():
	_require_access()
	return {"ollama": []}


@frappe.whitelist(methods=["POST"])
def setup_connect(provider: str | None = None, api_key: str | None = None, base_url: str | None = None):
	_require_access()
	frappe.throw(_("Connect Hermes in OpsAi Settings (Gateway URL and credentials)."))


@frappe.whitelist()
def setup_services():
	_require_access()
	return {"services": [], "other": []}


@frappe.whitelist(methods=["POST"])
def setup_add_model(provider: str | None = None, model_id: str | None = None, for_chat: int | None = None):
	_require_access()
	frappe.throw(_("Models come from your Hermes gateway. Configure OpsAi Settings instead."))


@frappe.whitelist(methods=["POST"])
def setup_remove_provider(provider: str | None = None):
	_require_access()
	frappe.throw(_("Providers are managed by Hermes. Configure OpsAi Settings instead."))


# legacy one-shot chat (desktop / simple clients)
@frappe.whitelist()
def chat(message: str | None = None):
	_require_access()
	message = (message or "").strip()
	if not message:
		frappe.throw(_("Message is required"))
	created = create_session(title=(message[:48] or "Chat"))
	sid = created["name"]
	_ensure_event_log(sid)
	_append_transcript(sid, "user", message)
	_clear_preview(sid)
	_append_events(
		sid,
		[
			{"type": "run_started"},
			{"type": "user_message", "content": [{"type": "text", "text": message}]},
		],
	)
	try:
		assistant = _complete_hermes_turn(sid, message)
	except HermesError as err:
		frappe.throw(str(err))
	return {"text": assistant or "", "session": sid}
