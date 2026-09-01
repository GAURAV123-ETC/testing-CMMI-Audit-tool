// ─── Evidence Scan — Practice Area Keyword Mapping ─────────────────────────
//
// Single source of truth for the Folder-Based Keyword & Evidence Scan
// feature (evidenceScanEngine.js / documentTextExtraction.js). Mirrors the
// plain-array-config convention already used by checklists.js
// (PA_CHECKLISTS) and practiceAreaRegistry.js (EXPECTED_PRACTICE_AREAS) —
// adding/expanding a keyword list only ever requires editing this file, no
// engine changes required.
//
// Display names for these codes are NOT duplicated here — they come from
// EXPECTED_PRACTICE_AREAS in practiceAreaRegistry.js, the app's existing
// single source of truth for Practice Area names.

export const EVIDENCE_SCAN_PA_CODES = ['IRP', 'PLAN', 'RSK', 'RDM']

export const EVIDENCE_KEYWORDS = {
  IRP: ['SLA', 'RCA', 'Priority'],
  PLAN: ['Planning', 'Schedule', 'Milestone'],
  RSK: ['Risk', 'Impact', 'Owner'],
  RDM: ['Requirement', 'Scope'],
}

// Filename-only hints — used strictly as a *supporting/fallback* signal
// (never the primary signal; document content always takes priority) when
// content scoring against EVIDENCE_KEYWORDS is empty or tied across PAs.
export const EVIDENCE_FILENAME_HINTS = {
  IRP: ['irp', 'incident'],
  PLAN: ['plan', 'schedule'],
  RSK: ['risk'],
  RDM: ['sow', 'requirement', 'brd', 'srs', 'scope'],
}
