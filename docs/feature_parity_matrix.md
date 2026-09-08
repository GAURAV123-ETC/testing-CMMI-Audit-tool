# Feature parity matrix

| Legacy workflow | Python replacement |
|---|---|
| Dashboard | NiceGUI dashboard with persisted counts |
| Audit information / customer / project / session setup | NiceGUI Add Project with persisted customer, project, and audit-session records |
| Local evidence upload and scan | NiceGUI Evidence & Scan tab; upload controls and persisted 302-rule scan |
| Findings dashboard | NiceGUI Dashboard and Findings pages backed by persisted findings and correlation service |
| Rule / CMMI knowledge search | Rules Catalogue's Browse stored rules tab searches the imported, versioned database checklist |
| User registration | Administrator-only NiceGUI Users page; public registration intentionally absent |
| Folder/package scan | Retired; customer files and ZIP archives are uploaded and scanned in Evidence Scan |
| IRP validation | `irp_validation.py` (24 synonym-aware columns, IDs, category, date ordering) |
| Evidence/master rule scan | `evidence_scan.py` and seeded `rule_engine.py` |
| Document extraction | XLSX, DOCX, PPTX, PDF, CSV extractors; OCR hook |
| AFR Excel/Word/PDF | persisted server-side AFR generator |
| Local uploads | protected API with filename/type/size checks |
| Repository / cloud-drive imports | Retired; customer evidence is uploaded through the single Evidence Scan workflow |
| Finding correlation | persisted findings and evidence correlation map |

The supported application has no live repository or cloud-provider integration.

## Retired predecessor capabilities

- Browser-native recursive folder selection and visual domain charts/filters.
- Repository, SharePoint, and Google Drive import flows are intentionally retired. Add any future approved import capability inside Evidence Scan.
- Legacy AI chat assistant and its complete curated knowledge-base corpus.
- Detailed PA validation/NC comment/remediation UI, historical report layouts, and fixture-by-fixture IRP edge-case parity.

These are product-scope decisions for the Python/NiceGUI platform, not pending
dependencies on a retained browser implementation.  The predecessor source,
build output, package manifests, and tool configuration have been removed.
