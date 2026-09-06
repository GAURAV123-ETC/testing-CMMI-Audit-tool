# Parity gap register

This is the authoritative completion register. It prevents the migration from being represented as complete before the legacy workflows are ported and tested.

## Migrated foundation

- 302 MASTER checklist rules, 33 document-type mappings, 146 related-document mappings, and all 24 IRP header/synonym mappings.
- MySQL schema, audit-session checklist pinning, evidence metadata, scan history, findings history, report metadata, comments/remediation/approval tables, and IRP persistence tables.
- Secure local-login/session/RBAC foundation, Turnstile verification adapter, password-reset email adapter, security audit logging, upload controls, Docker configuration, and server-side AFR Excel/Word/PDF generation.
- NiceGUI pages for dashboard, audit setup, upload and scan, package checking, findings, live gap/correlation analysis, AFR generation/download, integration state, rule-library search, and administrator-only user creation. Each registered route has been smoke-tested after authenticated login.

## Must still be ported before production parity sign-off

- The Dashboard domain/session/practice-area/severity/status/date filters, real coverage score, domain table, and per-practice-area drill-down are now ported to NiceGUI and calculated from persisted MySQL audit data. Remaining work is the NC owner/comment/remediation workflow and the legacy dashboard's combined-gap export formats; neither is represented as complete in the UI.
- The legacy package UI's recursive local-folder flow, complete GitHub/SharePoint/Google OAuth ingestion flow, and provider callback handling.
- Remaining detailed edge cases from the legacy `incidentEngine.js`, `riskSlaEngine.js`, `rcaEngine.js`, `irpEngine.js`, `irpAudit.js`, `irpDataValidation.js`, and `irpIssueLogEngine.js`. Python now covers the 24-field headers, IDs, category, priority matrix, basic resolution SLA, chronology, RCA/5-Why, and lesson-learned register checks; every legacy edge case still requires fixture-by-fixture parity tests.
- Exact evidence-keyword matching, knowledge-base assistant corpus/matching, correlation relationships, all legacy gap reports, and every non-AFR report format.
- Database migrations (Alembic), full test coverage, and successful Python/Docker end-to-end verification.

The legacy React/Vite files must stay out of production Docker images and may only be deleted after every row above is migrated, tested, and approved.
