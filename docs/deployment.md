# Deployment

1. Install Docker Engine and Docker Compose on the Linux VPS.
2. Copy `.env.example` to `.env`, set all production secrets, set `ENVIRONMENT=production` and `AUTO_MIGRATE_ON_STARTUP=false`. Provision `MIGRATION_DB_USER` separately with only the DDL and seed-data privileges needed for this schema (the standard MySQL image creates only `DB_USER`). Run `docker compose --profile migrate run --rm migrate`, then run `docker compose up -d --build` with the non-root `DB_USER` runtime account. The runtime account must not have DDL privileges.
3. Put an HTTPS reverse proxy in front of the loopback-bound port 8090, terminate TLS there, and restrict MySQL to the private Docker network. Configure the proxy to add HSTS only after confirming the production hostname is HTTPS-only.
4. Confirm `/healthz` responds through the proxy, then visit `/login` and create the initial administrator. The one-time setup endpoint refuses registration once any account exists; later accounts must be created through Manage Users.

Volumes `mysql_data`, `uploads`, `reports`, and `templates` retain data across application upgrades. Back up MySQL and the three file volumes together.
