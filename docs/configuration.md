# Configuration

Copy `.env.example` to `.env` and set `SECRET_KEY`, MySQL credentials, and bootstrap administrator credentials. Local development defaults to port `8010`; set `PUBLIC_BASE_URL` and `MICROSOFT_REDIRECT_URI` to the externally reachable URL in each environment. The normal database configuration is the `DB_*` variable set; `DATABASE_URL` is an optional test/deployment override.

Turnstile is enabled only when `TURNSTILE_ENABLED=true` and server-side keys are configured. Microsoft login requires Azure tenant/client/secret/redirect values. Google Drive requires a server-side client ID and secret. GitHub personal tokens are supplied per request/session and are never persisted.
