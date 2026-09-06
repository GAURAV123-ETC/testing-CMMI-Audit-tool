# Feature parity matrix

| Legacy workflow | Python replacement |
|---|---|
| Dashboard | NiceGUI dashboard with persisted counts |
| Audit information / customer / project / session setup | NiceGUI Audit Workspace with persisted MySQL records |
| Local evidence upload and scan | NiceGUI Evidence & Scan tab; upload controls and persisted 302-rule scan |
| Findings and gap dashboard | NiceGUI Findings and Gap Analysis pages backed by persisted findings and correlation service |
| Rule / CMMI knowledge search | NiceGUI Rule Library searches the imported 302-rule checklist |
| User registration | Administrator-only NiceGUI Users page; public registration intentionally absent |
| Folder/package scan | `package_validation.py` with 31 configured folders |
| IRP validation | `irp_validation.py` (24 synonym-aware columns, IDs, category, date ordering) |
| Evidence/master rule scan | `evidence_scan.py` and seeded `rule_engine.py` |
| Document extraction | XLSX, DOCX, PPTX, PDF, CSV extractors; OCR hook |
| AFR Excel/Word/PDF | persisted server-side AFR generator |
| Local uploads | protected API with filename/type/size checks |
| GitHub | server-side REST client; session token is not persisted |
| SharePoint/Google Drive | secure configuration/disabled-state adapters; live OAuth requires credentials |
| Gap/correlation | server-side gap and correlation services |

Items still requiring live-provider credentials are intentionally disabled rather than simulated in production.

## Not yet equivalent to the legacy React application

- Browser-native recursive folder selection and visual domain charts/filters.
- Full GitHub, SharePoint, and Google Drive scan-to-audit-session UI and OAuth callback flow.
- Legacy AI chat assistant and its complete curated knowledge-base corpus.
- Detailed PA validation/NC comment/remediation UI, all legacy report layouts, and fixture-by-fixture IRP edge-case parity.
