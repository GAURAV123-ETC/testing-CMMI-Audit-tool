# Security

Passwords use Argon2id. Authentication creates revocable, expiring server-side sessions. Login and reset endpoints are rate limited; failed logins lock accounts after the configured threshold. RBAC is enforced at API dependencies, and business/security actions are written to `audit_logs`.

Uploads are size-limited, use a basename-only filename, block executables, are stored outside static web content, and should be malware-scanned by the deployment environment before processing. ZIP extraction must use the supplied traversal/bomb validation. OCR and LibreOffice are isolated in the application container; configure resource limits at the container/VPS layer.

Set a unique `SECRET_KEY`, strong database passwords, HTTPS at the reverse proxy, and production Turnstile keys before deployment. Never place tokens or provider secrets in browser code or checked-in files.
