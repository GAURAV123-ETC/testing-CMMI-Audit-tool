// ─── Centralized Practice Area Checklist Configuration ────────────────────────
//
// This is the single source of truth for Gap Analysis / PA Validation.
// To support a new Practice Area, add a new entry to PA_CHECKLISTS — no
// changes to the validation engine, UI, or export logic are required.
//
// Shape of each entry:
// {
//   code:      CMMI practice area code (matches PRACTICE_AREAS in App.jsx)
//   name:      Full practice area name
//   folderKeywords: substrings that identify the PA from a folder name
//   requiredDocument: { label, keywords } — the one document that must be
//                     present in the folder for validation to proceed
//   headers:   [{ name, severity: 'critical'|'major'|'minor', synonyms[] }]
//              — validated against the FIRST ROW (header row) only
//   recommendations: { [headerName]: explanation text } shown for gaps
// }

export const PA_CHECKLISTS = {
  // No Practice Area checklists are currently configured.
  // Add a new entry here following the shape documented above.
}

export const SUPPORTED_PA_CODES = Object.keys(PA_CHECKLISTS)
