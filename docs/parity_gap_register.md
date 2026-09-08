# Parity gap register

This is the historical migration-scope record. The retired browser implementation is not required by, included in, or invoked by the current Python/NiceGUI platform.

## Migrated foundation

- 302 MASTER checklist rules, 33 document-type mappings, 146 related-document mappings, and all 24 IRP header/synonym mappings.
- MySQL schema, audit-session checklist pinning, evidence metadata, scan history, findings history, report metadata, comments/remediation/approval tables, and IRP persistence tables.
- Secure local-login/session/RBAC foundation, Turnstile verification adapter, password-reset email adapter, security audit logging, upload controls, Docker configuration, and server-side AFR Excel/Word/PDF generation.
- NiceGUI pages for dashboard, audit setup, upload and scan, package checking, findings, live gap/correlation analysis, AFR generation/download, integration state, rule-library search, and administrator-only user creation. Each registered route has been smoke-tested after authenticated login.

## Deferred or intentionally retired scope

- The Dashboard domain/session/practice-area/severity/status/date filters, real coverage score, domain table, and per-practice-area drill-down are calculated from persisted MySQL audit data. NC owner/comment/remediation workflow and combined-gap export formats remain future Python/NiceGUI enhancements.
- Recursive browser-folder flow, GitHub/SharePoint/Google imports, and duplicate practice-area validation imports are retired. Any future approved import capability must be added to Evidence Scan, not as a separate menu.
- The former JavaScript validator edge cases were formally retired with the predecessor source. Python covers the 24-field headers, IDs, category, priority matrix, basic resolution SLA, chronology, RCA/5-Why, and lesson-learned register checks; further rule coverage must be implemented and tested in Python.
- Exact evidence-keyword matching, knowledge-base assistant corpus/matching, correlation relationships, and non-AFR report formats remain product enhancements.
- Database migrations (Alembic) and increased Python test coverage remain technical improvements.

The legacy React/Vite files, their Node dependencies, build output, manifests, and legacy tool permissions have been deleted. Docker starts only the Python ASGI application through `main:app`.
