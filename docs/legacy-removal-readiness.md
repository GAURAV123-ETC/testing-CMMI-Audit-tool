# Legacy React retirement record

The React/Vite implementation was retired after the server-first
Python/NiceGUI/FastAPI flow reached functional parity. This document records
the verification completed before removal; it is not a runtime dependency.

## Verified Python/NiceGUI coverage

| Legacy capability | Server-first replacement | Verification |
| --- | --- | --- |
| Login, sessions, RBAC and protected navigation | FastAPI auth service, middleware, NiceGUI shared layout | Unit tests and unauthenticated live-route checks |
| Dashboard, filters, findings, comments and remediation | `app/gui/pages/dashboard.py` and persisted models | Regression tests |
| Audit setup (customer, project, session) | `app/gui/pages/audit_workspace.py` | Regression tests |
| Duplicate repository and practice-area imports | Retired in favour of the single Evidence Scan workflow | Routes, APIs, provider services, and browser-folder uploaders removed |
| Evidence extraction and CMMI scan | `extractors.py`, `evidence_validation.py`, `evidence_scan.py` | Database-backed scan test |
| Evidence Scan IRP/PLAN/RSK/RDM content mapping | `EVIDENCE_SCAN_KEYWORDS` in `evidence_validation.py` | Regression test and persisted scan test |
| Legacy multi-project parent-folder grouping | ZIP parent-folder importer in `evidence_ingestion.py` and Evidence Scan | Creates persisted project/session per top-level project folder |
| IRP, RCA and risk/SLA validation | `irp_validation.py`, `rca_validation.py`, `risk_sla_validation.py` | CSV/XLSX validator tests |
| Duplicate package and gap-analysis workflows | Retired in favour of Evidence Scan, Dashboard, Findings, and AFR Reports | Routes, services, APIs, and browser controls removed |
| AFR and gap exports | `app/services/reports/afr_report.py` | Export tests |

## Verification completed

Run from the project root:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m compileall -q app tests
.\.venv\Scripts\python.exe -m pip check
```

At the time this gate was approved, all three checks passed with no broken
Python requirements. A live local smoke check also confirmed that
`/login` returns `200` and the sampled protected pages redirect unauthenticated
requests to `/login`.

## Retirement decision

The former browser AI-service behaviour was formally retired. The supported AI
Guide uses the pinned CMMI rules and persisted audit findings, which is the
current approved product behaviour. The legacy React/Vite sources, builds,
Node dependencies, and Node-only generators have been removed.
