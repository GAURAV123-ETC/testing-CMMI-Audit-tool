# Migration assessment

The legacy application is React/Vite with browser-only state and 302 generated checklist rules. Its audit logic is distributed across JSX and JavaScript modules, including package availability, IRP checks, evidence scanning, and browser-side export code. It has 31 folder/practice-area entries, while its CMMI knowledge base describes 24 practice areas. This migration retains 31 folder checks as the configurable evidence registry and records the 24-model scope as knowledge-base content; this resolves the mismatch without silently dropping evidence requirements.

Migrated source assets: 302 MASTER rules, 33 document-type mappings, and 146 related-document mappings. The old UI remains temporarily as a non-production reference until the Python test and Docker verification gates pass.
