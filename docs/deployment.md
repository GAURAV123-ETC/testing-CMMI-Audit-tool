# Deployment

1. Install Docker Engine and Docker Compose on the Linux VPS.
2. Copy `.env.example` to `.env`, set all production secrets, then run `docker compose up -d --build`.
3. Put an HTTPS reverse proxy in front of port 8090 and restrict MySQL to the private Docker network.
4. Confirm `/api/docs` responds, then visit `/login` and create the initial administrator. The one-time setup endpoint refuses registration once any account exists; later accounts must be created through Manage Users.

Volumes `mysql_data`, `uploads`, `reports`, and `templates` retain data across application upgrades. Back up MySQL and the three file volumes together.
