// ─── Expected Practice Area Registry (Audit Folder Availability Flow) ─────
//
// Source of truth for "which Practice Area folders should exist in an
// uploaded audit package". Mirrors the Practice Area codes/names already
// defined in App.jsx (CORE_PRACTICE_AREAS + DOMAINS' pas) plus IRP —
// the Incident Resolution Process module, named IRP (not IIP) — which this
// flow treats as its own top-level Practice Area folder.
//
// This is intentionally a plain, standalone array (not imported from
// App.jsx, and App.jsx is not changed to import from here) to avoid a
// circular dependency and to keep zero blast-radius on App.jsx's existing
// PRACTICE_AREAS data, which also carries presentation-only score/status
// fields unrelated to folder-availability scanning. Codes are kept in sync
// with App.jsx by convention; adding a new Practice Area only ever requires
// appending a row here — no scanning-engine changes are needed (§16).
export const EXPECTED_PRACTICE_AREAS = [
  { code: 'IRP', name: 'Incident Resolution Process' },
  { code: 'CAR', name: 'Causal Analysis and Resolution' },
  { code: 'RSK', name: 'Risk & Opportunity Management' },
  { code: 'PR', name: 'Peer Reviews' },
  { code: 'PQA', name: 'Process Quality Assurance' },
  { code: 'RDM', name: 'Requirements Development & Management' },
  { code: 'VV', name: 'Verification & Validation' },
  { code: 'EST', name: 'Estimating' },
  { code: 'MC', name: 'Monitor & Control' },
  { code: 'PLAN', name: 'Planning' },
  { code: 'OT', name: 'Organizational Training' },
  { code: 'CM', name: 'Configuration Management' },
  { code: 'DAR', name: 'Decision Analysis & Resolution' },
  { code: 'MPM', name: 'Managing Performance & Measurement' },
  { code: 'PAD', name: 'Process Asset Development' },
  { code: 'PCM', name: 'Process Management' },
  { code: 'GOV', name: 'Governance' },
  { code: 'II', name: 'Implementation Infrastructure' },
  { code: 'PI', name: 'Product Integration' },
  { code: 'TS', name: 'Technical Solution' },
  { code: 'CONT', name: 'Continuity' },
  { code: 'SDM', name: 'Service Delivery Management' },
  { code: 'STSM', name: 'Strategic Service Management' },
  { code: 'SAM', name: 'Supplier Agreement Management' },
  { code: 'WE', name: 'Workforce Empowerment' },
  { code: 'DM', name: 'Data Management' },
  { code: 'DQ', name: 'Data Quality' },
  { code: 'ESEC', name: 'Enabling Security' },
  { code: 'MST', name: 'Managing Security Threats & Vulnerabilities' },
  { code: 'ESAF', name: 'Enabling Safety' },
  { code: 'EVW', name: 'Enabling Virtual Work' },
]
