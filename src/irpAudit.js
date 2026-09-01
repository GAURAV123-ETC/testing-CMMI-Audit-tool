// ─── IRP Audit Orchestrator ─────────────────────────────────────────────────
//
// Combines the three independent, self-contained IRP engines into one audit
// result, without modifying any of them:
//   - incidentEngine.validateIncidentLog  (Incident Log)
//   - rcaEngine.validateRCA               (RCA / 5 Why, cross-checked
//                                           against Incident Log breaches)
//   - irpEngine.validateLessonLearned     (Lesson Learned — pre-existing,
//                                           untouched)
//
// Folder-structure gating (spec §1): when the caller cannot find an
// IRP-coded folder at all, `files` is passed as `null` and this module
// short-circuits with a single top-level gap rather than running any
// document-level validation.

import * as XLSX from 'xlsx'
import { validateIncidentLog } from './incidentEngine'
import { validateRCA } from './rcaEngine'
import { validateLessonLearned, LESSON_LEARNED_NAME_KEYWORDS } from './irpEngine'
import { nameMatchesKeywords, matchFieldsExclusive } from './textMatch'

function getExt(name) { return (name || '').split('.').pop().toLowerCase() }
function raw(v) { return String(v ?? '').trim() }

// Best-effort re-scan of the Lesson Learned sheet purely to tally Action
// Item totals (Open vs Closed) for the §28 summary — irpEngine.js's
// validateLessonLearned() does not expose per-record data, only findings,
// and it must not be modified to add that. Read-only; independent of, and
// never contradicts, the Lesson Learned findings themselves.
async function tallyLLActionItems(files) {
  let total = 0, open = 0, closed = 0
  for (const file of files) {
    const ext = getExt(file.name)
    if (ext !== 'xlsx' && ext !== 'xls') continue
    let wb
    try {
      const buf = await file.arrayBuffer()
      wb = XLSX.read(buf, { type: 'array', cellDates: true })
    } catch (_) { continue }
    const hitSheet = wb.SheetNames.find(s => nameMatchesKeywords(s, LESSON_LEARNED_NAME_KEYWORDS))
    const useSheet = hitSheet || (nameMatchesKeywords(file.name, LESSON_LEARNED_NAME_KEYWORDS) ? wb.SheetNames[0] : null)
    if (!useSheet) continue

    const sheet = wb.Sheets[useSheet]
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
    if (!rows || rows.length < 2) return { total, open, closed }

    const rawHeaders = rows[0].map(c => String(c ?? '').trim())
    const { actionItem, status } = matchFieldsExclusive(rawHeaders, [
      { key: 'actionItem', canonical: 'resulting action item', synonyms: ['action item', 'resulting action', 'improvement action', 'corrective improvement', 'follow up action'] },
      { key: 'status', canonical: 'action item status', synonyms: ['action status', 'status', 'improvement action status'] },
    ])
    if (actionItem.columnIndex === -1) return { total, open, closed }

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      if (!row || row.every(c => raw(c) === '')) continue
      const actionVal = raw(row[actionItem.columnIndex])
      if (!actionVal || ['na', 'n/a', 'none', '-', '.'].includes(actionVal.toLowerCase())) continue
      total += 1
      const statusVal = status.columnIndex !== -1 ? raw(row[status.columnIndex]).toLowerCase() : ''
      if (['closed', 'completed', 'approved', 'done'].some(k => statusVal.includes(k))) closed += 1
      else open += 1
    }
    return { total, open, closed }
  }
  return { total, open, closed }
}

function emptySummary() {
  return {
    totalIncidents: 0, p1: 0, p2: 0, p3: 0, p4: 0,
    slaBreaches: 0, p1SlaBreaches: 0, p2SlaBreaches: 0,
    rcaRequired: 0, rcaAvailable: 0, rcaMissing: 0, rcaTraceabilityGaps: 0,
    lessonLearnedRecords: 0, lessonLearnedMissing: 0, lessonLearnedTraceabilityGaps: 0,
    actionItems: 0, openActions: 0, closedActions: 0,
    missingMandatoryFields: 0,
    duplicateIds: 0, duplicateIncidentIds: 0, duplicateRcaIds: 0, duplicateLessonLearnedIds: 0,
    priorityMatrixViolations: 0, traceabilityGaps: 0,
    totalGaps: 0, criticalGaps: 0, majorGaps: 0, minorGaps: 0,
  }
}

// Accepts either the richer folder-structure-aware context produced by
// App.jsx's collectIRPFiles() — { status: 'found'|'rsk-missing'|'irp-missing',
// files } — or, for backward compatibility (existing callers/tests), a plain
// File[] array (treated as status 'found') or `null`/`undefined` (treated as
// a generic "not found", same wording as the original folder-not-found gap).
function normalizeInput(input) {
  if (Array.isArray(input)) return { status: 'found', files: input }
  if (input && typeof input === 'object' && 'status' in input) return input
  return { status: 'not-found', files: null }
}

function singleFindingResult(finding, extraSummary = {}) {
  return {
    folderFound: false,
    findings: [finding],
    incident: null, rca: null, lessonLearned: null,
    summary: { ...emptySummary(), totalGaps: 1, [finding.severity === 'Critical' ? 'criticalGaps' : finding.severity === 'Major' ? 'majorGaps' : 'minorGaps']: 1, ...extraSummary },
  }
}

// `input`: see normalizeInput() above.
// Never throws.
export async function validateIRPAudit(input) {
  const ctx = normalizeInput(input)

  // Folder-structure gate (spec §1/§10): Practice Area folders → RSK → IRP →
  // evidence. Distinguishes "RSK Practice Area itself is unavailable" from
  // "RSK is available but has no IRP subfolder" so the two documented gap
  // levels (Practice Area level vs. Folder level) are never collapsed into
  // one message, and so the reader knows exactly which folder to create.
  if (ctx.status === 'rsk-missing') {
    return singleFindingResult({
      id: 'IRP-PA-001', pa: 'IRP', evidence: 'Project Repository', sheet: 'N/A', row: null, record: '',
      field: 'Practice Area (RSK)',
      finding: 'The RSK (Risk & Opportunity Management) Practice Area folder — which hosts IRP (Incident Response Process) evidence — was not found in the uploaded project repository. IRP document-level validation was not performed.',
      actual: 'RSK Practice Area folder: Missing', expected: 'RSK Practice Area folder: Available',
      severity: 'Critical',
      recommendation: 'Upload the RSK Practice Area folder, containing an IRP subfolder with the Incident Log, RCA / 5 Why register, and Lesson Learned register.',
      status: 'Open', level: 'practice-area',
    })
  }
  if (ctx.status === 'irp-missing') {
    return singleFindingResult({
      id: 'IRP-FOLDER-001', pa: 'IRP', evidence: 'RSK Practice Area folder', sheet: 'N/A', row: null, record: '',
      field: 'IRP Folder',
      finding: 'The RSK Practice Area folder is available, but no IRP (Incident Response Process) subfolder was found within it. Document-level validation was not performed.',
      actual: 'IRP folder under RSK: Missing', expected: 'IRP folder under RSK: Available',
      severity: 'Critical',
      recommendation: 'Create an IRP subfolder under the RSK Practice Area folder containing the Incident Log, RCA / 5 Why register, and Lesson Learned register.',
      status: 'Open', level: 'folder',
    })
  }
  if (ctx.status === 'not-found' || !ctx.files) {
    return singleFindingResult({
      id: 'IRP-FOLDER-001', pa: 'IRP', evidence: 'Project Repository', sheet: 'N/A', row: null, record: '',
      field: 'IRP Folder', finding: 'Required IRP (Incident Response Process) folder was not found in the uploaded project repository. Document-level validation was not performed.',
      actual: null, expected: null, severity: 'Critical',
      recommendation: 'Upload an IRP folder containing the Incident Log, RCA / 5 Why register, and Lesson Learned register.',
      status: 'Open', level: 'folder',
    })
  }

  const files = ctx.files
  const incident = await validateIncidentLog(files)
  const incidentContext = {
    available: incident.supported,
    incidentIds: incident.incidentIds || new Set(),
    recordsById: new Map((incident.records || []).filter(r => r.id).map(r => [r.id.toLowerCase(), r])),
    p1p2BreachedIds: incident.p1p2BreachedIds || new Set(),
    // RCA is mandatory for ANY-priority SLA breach (Response or Resolution),
    // not just P1/P2 — see rcaEngine.js's p1p2CrossCheck, which now keys off
    // this broader set.
    slaBreachedIds: incident.slaBreachedIds || incident.p1p2BreachedIds || new Set(),
  }
  const rca = await validateRCA(files, incidentContext)
  const lessonLearned = await validateLessonLearned(files)
  const llTally = await tallyLLActionItems(files)

  const findings = [...incident.findings, ...rca.findings, ...lessonLearned.findings]

  const llDuplicates = lessonLearned.findings.filter(f => f.field === 'Lesson Learned ID' && f.finding.includes('Duplicate')).length
  const llTraceabilityGaps = lessonLearned.findings.filter(f => f.field === 'IRO ID' && f.finding.includes('cannot be found')).length
  const priorityMatrixViolations = incident.findings.filter(f => f.finding.includes('Priority mismatch')).length
  const headerGaps = findings.filter(f => f.level === 'header').length

  const summary = {
    totalIncidents: incident.summary?.total || 0,
    p1: incident.summary?.p1 || 0, p2: incident.summary?.p2 || 0, p3: incident.summary?.p3 || 0, p4: incident.summary?.p4 || 0,
    slaBreaches: incident.summary?.slaBreaches || 0,
    p1SlaBreaches: incident.summary?.p1Breaches || 0,
    p2SlaBreaches: incident.summary?.p2Breaches || 0,
    rcaRequired: rca.summary?.p1p2Required || 0,
    rcaAvailable: (rca.summary?.p1p2Required || 0) - (rca.summary?.p1p2Missing || 0),
    rcaMissing: rca.summary?.p1p2Missing || 0,
    rcaTraceabilityGaps: rca.summary?.traceabilityGaps || 0,
    lessonLearnedRecords: lessonLearned.totalRecords || 0,
    lessonLearnedMissing: lessonLearned.supported ? 0 : 1,
    lessonLearnedTraceabilityGaps: llTraceabilityGaps,
    actionItems: llTally.total, openActions: llTally.open, closedActions: llTally.closed,
    missingMandatoryFields: headerGaps,
    duplicateIds: (incident.summary?.duplicates || 0) + (rca.summary?.duplicates || 0) + llDuplicates,
    duplicateIncidentIds: incident.summary?.duplicates || 0,
    duplicateRcaIds: rca.summary?.duplicates || 0,
    duplicateLessonLearnedIds: llDuplicates,
    priorityMatrixViolations,
    traceabilityGaps: (rca.summary?.traceabilityGaps || 0) + llTraceabilityGaps,
    totalGaps: findings.length,
    criticalGaps: findings.filter(f => f.severity === 'Critical').length,
    majorGaps: findings.filter(f => f.severity === 'Major').length,
    minorGaps: findings.filter(f => f.severity === 'Minor').length,
  }

  return { folderFound: true, incident, rca, lessonLearned, findings, summary }
}

// Single source of truth for "which validateIRPAudit() findings count as
// incident-level Gap Report rows" — Priority Matrix mismatch, Response/
// Resolution SLA breach, RCA-missing-on-breach, RCA traceability, Closed
// Date/Time, Issue Category, duplicate Incident/RCA ID, chronology, etc.
// Excludes pure header-presence findings (level === 'header'), which
// duplicate the IRP Issue Log's own Stage-1 header-availability gap
// surfaced elsewhere (pkgAvailability/irpIssueLog). Every consumer that
// needs to list these findings (Dashboard, on-screen Gap Analysis, AFR
// Excel/Word, and the separate PDF/Excel Gap Report) calls this instead of
// re-deriving its own filter, so all four surfaces always agree.
export function getIrpIncidentFindings(irpAuditResult) {
  if (!irpAuditResult || !irpAuditResult.folderFound) return []
  return [
    ...(irpAuditResult.incident?.findings || []),
    ...(irpAuditResult.rca?.findings || []),
  ].filter(f => f.level !== 'header')
}
