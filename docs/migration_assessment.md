# Migration assessment (retired predecessor)

The retired React/Vite application used browser-only state and 302 generated checklist rules. Its audit logic was distributed across JSX and JavaScript modules, including package availability, IRP checks, evidence scanning, and browser-side export code. It had 31 folder/practice-area entries, while its CMMI knowledge base described 24 practice areas. The Python/NiceGUI platform retains 31 folder checks as the configurable evidence registry and records the 24-model scope as knowledge-base content; this resolves the mismatch without silently dropping evidence requirements.

Migrated source assets: 302 MASTER rules, 33 document-type mappings, and 146 related-document mappings. The old UI and all Node/React build artifacts were permanently removed after the Python test and runtime verification gates passed.
