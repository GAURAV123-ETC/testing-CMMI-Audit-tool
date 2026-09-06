# Legacy React removal readiness

This document is the migration gate for removing `src/`. A page that looks
similar is not sufficient: its persisted data flow, permission checks, and
export/scan behaviour must also have a Python/NiceGUI equivalent.

## Verified Python/NiceGUI coverage

| Legacy capability | Server-first replacement | Verification |
| --- | --- | --- |
| Login, sessions, RBAC and protected navigation | FastAPI auth service, middleware, NiceGUI shared layout | Unit tests and unauthenticated live-route checks |
| Dashboard, filters, findings, comments and remediation | `app/gui/pages/dashboard.py` and persisted models | Regression tests |
| Audit setup (customer, project, session) | `app/gui/pages/audit_workspace.py` | Regression tests |
| Repository imports | Server-side GitHub, SharePoint and Google Drive services | Regression tests; permission checks in endpoints |
| Evidence extraction and CMMI scan | `extractors.py`, `evidence_validation.py`, `evidence_scan.py` | Database-backed scan test |
| Evidence Scan IRP/PLAN/RSK/RDM content mapping | `EVIDENCE_SCAN_KEYWORDS` in `evidence_validation.py` | Regression test and persisted scan test |
| Legacy multi-project parent-folder grouping | ZIP parent-folder importer in `evidence_ingestion.py` and Evidence Scan | Creates persisted project/session per top-level project folder |
| IRP, RCA and risk/SLA validation | `irp_validation.py`, `rca_validation.py`, `risk_sla_validation.py` | CSV/XLSX validator tests |
| Audit package checker | Protected `/package-checker` NiceGUI page and `package_validation.py` | ZIP folder-coverage regression test |
| AFR and gap exports | `app/services/reports/afr_report.py` | Export tests |

## Current verification result

Run from the project root:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m compileall -q app tests
.\.venv\Scripts\python.exe -m pip check
```

At the time this gate was updated, all three checks passed (`44 passed`; no
broken Python requirements). A live local smoke check also confirmed that
`/login` returns `200` and the sampled protected pages redirect unauthenticated
requests to `/login`.

## Blocking gaps before deleting `src/`

1. **Legacy AI service:** the new AI Guide intentionally uses stored CMMI
   rules and persisted findings only. It does not call the legacy browser AI
   service. This is safer and deterministic, but it is a behavioural change
   that requires product approval before deleting the old implementation.

## Removal decision

**Do not delete `src/` yet** until the legacy AI-service difference is either
migrated or formally retired. Then rerun the checks above plus authenticated UI
smoke tests for each route. Only then may the legacy source be removed in a
dedicated, reviewable change.
