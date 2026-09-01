// ─── Non-Conformity (NC) Lifecycle Engine ──────────────────────────────────
//
// Fully generic — driven by PA_CHECKLISTS, never by PA-specific logic. Every
// missing mandatory header is one Non-Conformity. Re-validating a Practice
// Area (re-uploading a corrected document) automatically closes NCs whose
// field is now present, and reopens ones that regress — no manual workflow
// or persistence beyond the current session is required.

import { PA_CHECKLISTS } from './checklists'

function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export function daysBetween(fromISO, toDate = new Date()) {
  const from = new Date(fromISO)
  return Math.max(0, Math.round((toDate - from) / 86400000))
}

// Finding Type / Gap Description / Missing Evidence text for one checklist
// header, given the document-level and field-level validation outcome.
// Purely descriptive of the existing validatePracticeArea() result — invents
// no CMMI content of its own.
function describeFinding(paCode, cfg, result, h) {
  if (result.documentFound === false) {
    return {
      findingType: 'Missing Required Document',
      gapDescription: `Required document "${cfg.requiredDocument.label}" was not found in the ${paCode} Practice Area folder; therefore mandatory field "${h.name}" could not be validated.`,
      missingEvidenceText: `Document not found: "${cfg.requiredDocument.label}" was not located under the ${paCode} Practice Area folder.`,
    }
  }
  return {
    findingType: 'Missing Mandatory Field',
    gapDescription: `Missing mandatory field "${h.name}" in ${result.fileName || cfg.requiredDocument.label}.`,
    missingEvidenceText: `"${h.name}" column/header not present in the header row of ${result.fileName || cfg.requiredDocument.label}.`,
  }
}

// prevStore: { records: NCRecord[], seq: number } | undefined
// result: output of validatePracticeArea() for this same paCode
// sourceInfo: { sourcePath, uploadSource, sourceMeta } — traceability back to
// where the validated document came from (Local Folder / GitHub / SharePoint
// / Google Drive). Optional — defaults preserve prior callers' behavior.
// Returns the next store — pure function, no side effects.
export function updateNCStore(prevStore, paCode, result, sourceInfo = {}) {
  const cfg = PA_CHECKLISTS[paCode]
  if (!cfg) return prevStore || { records: [], seq: 0 }

  const { sourcePath = null, uploadSource = null, sourceMeta = null } = sourceInfo

  const now = new Date()
  const prevRecords = prevStore?.records || []
  let seq = prevStore?.seq || 0

  const currentlyMissing = new Set(
    result.documentFound === false
      ? cfg.headers.map(h => h.name)
      : (result.headers || []).filter(h => h.status === 'FAIL').map(h => h.name)
  )

  const byField = new Map(prevRecords.map(r => [r.fieldName, r]))
  const records = []

  // Iterate the checklist in its own fixed order so table rows stay stable
  // and predictable across re-validations, regardless of Set iteration order.
  cfg.headers.forEach(h => {
    const existing = byField.get(h.name)
    const isMissing = currentlyMissing.has(h.name)
    const { findingType, gapDescription, missingEvidenceText } = describeFinding(paCode, cfg, result, h)

    if (isMissing) {
      if (existing && existing.status === 'Open') {
        records.push({
          ...existing,
          findingType, gapDescription,
          missingEvidence: missingEvidenceText,
          sourcePath, uploadSource, sourceMeta,
        })
      } else if (existing && existing.status === 'Closed') {
        // Regression — the field was fixed before but is missing again.
        records.push({
          ...existing,
          status: 'Open',
          reopenedAt: now.toISOString(),
          closedAt: null,
          closedBy: null,
          evidence: null,
          evidenceFound: null,
          findingType, gapDescription,
          missingEvidence: missingEvidenceText,
          sourcePath, uploadSource, sourceMeta,
        })
      } else {
        seq += 1
        records.push({
          ncId: `${paCode}-NC-${String(seq).padStart(3, '0')}`,
          paCode,
          paName: cfg.name,
          documentLabel: cfg.requiredDocument.label,
          fileName: result.fileName || null,
          fieldName: h.name,
          severity: h.severity,
          status: 'Open',
          firstDetectedAt: now.toISOString(),
          targetDate: addDays(now, 14).toISOString(),
          owner: 'Unassigned',
          closedAt: null,
          closedBy: null,
          evidence: null,
          findingType, gapDescription,
          missingEvidence: missingEvidenceText,
          evidenceFound: null,
          sourcePath, uploadSource, sourceMeta,
        })
      }
    } else if (existing) {
      if (existing.status === 'Open') {
        const evidenceText = `"${h.name}" header found in the header row of "${result.fileName || cfg.requiredDocument.label}".`
        records.push({
          ...existing,
          status: 'Closed',
          closedAt: now.toISOString(),
          closedBy: 'System (auto-verified on re-validation)',
          evidence: evidenceText,
          evidenceFound: evidenceText,
          missingEvidence: null,
          findingType, gapDescription,
          sourcePath, uploadSource, sourceMeta,
        })
      } else {
        records.push({ ...existing, sourcePath, uploadSource, sourceMeta })
      }
    }
    // else: field has never been missing — no NC ever raised for it.
  })

  return { records, seq }
}
