# Deployment

1. Install Docker Engine and Docker Compose on the Linux VPS.
2. Copy `.env.example` to `.env`, set all production secrets, then run `docker compose up -d --build`.
3. Put an HTTPS reverse proxy in front of port 8080 and restrict MySQL to the private Docker network.
4. Confirm `/api/docs` responds, then create the initial administrator using `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` only for first boot; remove the password from the environment afterward.

Volumes `mysql_data`, `uploads`, `reports`, and `templates` retain data across application upgrades. Back up MySQL and the three file volumes together.
