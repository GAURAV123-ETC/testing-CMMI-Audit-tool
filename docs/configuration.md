# Configuration

Copy `.env.example` to `.env` and set `SECRET_KEY` and MySQL credentials. Local development defaults to port `8010`; set `APP_HOST`, `APP_PORT`, `PUBLIC_BASE_URL`, and `MICROSOFT_REDIRECT_URI` to the externally reachable values in each environment. The normal database configuration is the `DB_*` variable set; `DATABASE_URL` is an optional test/deployment override. On the first empty-database visit to `/login`, create the initial administrator account; there are no bootstrap passwords stored in environment configuration.

Turnstile is enabled only when `TURNSTILE_ENABLED=true` and server-side keys are configured. Microsoft login requires Azure tenant/client/secret/redirect values. Repository and cloud-drive imports are not enabled in this release; upload customer evidence through Evidence Scan.
