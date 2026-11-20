# OpsAi

Frappe / ERPNext app that stores per-user AI gateway settings for [OpsAi](https://github.com/UpGoTech/OpsAi).

## Install

```bash
cd ~/frappe-bench
bench get-app https://github.com/UpGoTech/OpsAi
bench --site <site> install-app opsai
bench --site <site> migrate
```

## Usage

1. Open **OpsAi Settings** in Desk.
2. Create one document per User (name = User id).
3. Set AI `gateway_url`, auth mode, and credentials.
4. OpsAi logs into this site, calls `opsai.api.ping`, then `get_my_opsai_settings`.

## API

- `GET /api/method/opsai.api.ping` — confirms the site supports OpsAi
- `GET /api/method/opsai.api.get_my_opsai_settings` — caller’s AI settings (Password fields decrypted)

Requires a logged-in session (`sid`). Guest and cross-user access are rejected.
No settings row → OpsAi shows “This user is not permitted to use AI.”
