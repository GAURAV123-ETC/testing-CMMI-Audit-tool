# Security

Passwords use Argon2id. Authentication creates revocable, expiring server-side sessions. Login and reset endpoints are rate limited; failed logins lock accounts after the configured threshold. RBAC is enforced at API dependencies, and business/security actions are written to `audit_logs`.

## Workspace authorization policy

This release is an intentionally **shared internal audit workspace**: a user
who has Read or Write access to a screen is authorized for every customer,
project, audit session, evidence item, finding, and report exposed by that
screen. `created_by_id` and `owner_id` are provenance fields, not tenant
boundaries. The application must not be used to isolate independent customers
or organizations. Introducing tenant isolation requires an explicit
organization-membership data model and end-to-end scoped queries.

Uploads are size-limited, use a basename-only filename, block executables, are stored outside static web content, and should be malware-scanned by the deployment environment before processing. ZIP extraction must use the supplied traversal/bomb validation. OCR and LibreOffice are isolated in the application container; configure resource limits at the container/VPS layer.

Set a unique `SECRET_KEY`, strong database passwords, HTTPS at the reverse proxy, and production Turnstile keys before deployment. Never place tokens or provider secrets in browser code or checked-in files.
