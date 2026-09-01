// ─── RCA / 5-Why Validation Engine (IRP) ───────────────────────────────────
//
// Detects the RCA / Root Cause Analysis / 5 Why register by semantic
// file/sheet matching, maps its header row to the 20 required logical
// fields, then performs row-level data-quality, traceability (against the
// Incident Log), 5-Why completeness, and action-closure validation.
// Read-only — never modifies the source file.
//
// `incidentContext` (produced by incidentEngine.validateIncidentLog) is
// used only for: (a) confirming a referenced Incident ID actually exists,
// (b) checking RCA Date isn't earlier than the incident's Report Date, and
// (c) the §14 "P1/P2 SLA breach requires RCA" cross-check. This module
// never re-derives or re-validates Incident Log fields itself.
//
// NOTE: follows the same self-contained-module convention already used by
// riskSlaEngine.js / irpEngine.js / incidentEngine.js (own local
// file-reading + finding factory) so it can be added without touching them.

import * as XLSX from 'xlsx'
import { normalizeText, matchFieldsExclusive, nameMatchesKeywords } from './textMatch'

export const RCA_NAME_KEYWORDS = [
  'rca', 'root cause analysis', '5 why', '5 whys', 'five why', 'five whys',
  'rca register', 'corrective action analysis',
]

const TABULAR_EXTS = ['xlsx', 'xls', 'csv']
function getExt(name) { return (name || '').split('.').pop().toLowerCase() }
function raw(v) { return String(v ?? '').trim() }

async function readRows(file, sheetName) {
  const ext = getExt(file.name)
  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array', cellDates: true })
    const targetSheet = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0]
    const sheet = wb.Sheets[targetSheet]
    return { sheetName: targetSheet, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' }) }
  }
  if (ext === 'csv') {
    const text = await file.text()
    const rows = text.split(/\r?\n/).filter(l => l.trim().length > 0).map(line => {
      const out = []
      let cur = '', inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === '"') { inQuotes = !inQuotes; continue }
        if (c === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue }
        cur += c
      }
      out.push(cur.trim())
      return out
    })
    return { sheetName: null, rows }
  }
  return { sheetName: null, rows: null }
}

async function findNamedSource(files, keywords) {
  let unsupportedMatch = null
  for (const file of files) {
    const ext = getExt(file.name)
    if (ext === 'xlsx' || ext === 'xls') {
      try {
        const buf = await file.arrayBuffer()
        const wb = XLSX.read(buf, { type: 'array', cellDates: true })
        const hitSheet = wb.SheetNames.find(s => nameMatchesKeywords(s, keywords))
        if (hitSheet) return { file, sheetName: hitSheet, supported: true }
      } catch (_) { /* unreadable workbook — fall through to filename check */ }
    }
    if (nameMatchesKeywords(file.name, keywords)) {
      if (TABULAR_EXTS.includes(ext)) return { file, sheetName: null, supported: true }
      if (!unsupportedMatch) unsupportedMatch = { file, sheetName: null, supported: false }
    }
  }
  return unsupportedMatch
}

export async function findRCASource(files) {
  return findNamedSource(files, RCA_NAME_KEYWORDS)
}

// ─── Required Logical Fields (spec §16) ─────────────────────────────────────

const RCA_FIELDS = [
  { key: 'id', label: 'RCA ID', canonical: 'rca id', synonyms: ['rca number', 'rca ref', 'root cause analysis id'] },
  { key: 'date', label: 'RCA Date', canonical: 'rca date', synonyms: ['date of rca', 'analysis date'] },
  { key: 'incidentId', label: 'Incident ID', canonical: 'incident id', synonyms: ['iro id', 'issue id', 'related incident', 'incident reference'] },
  { key: 'problemStatement', label: 'Problem/Event Statement', canonical: 'problem statement', synonyms: ['event statement', 'problem description', 'issue statement'] },
  { key: 'sourceOfProblem', label: 'Source of Problem', canonical: 'source of problem', synonyms: ['problem source'] },
  { key: 'method', label: 'RCA Method', canonical: 'rca method', synonyms: ['method', 'analysis method', 'technique'] },
  { key: 'why1', label: 'Why 1', canonical: 'why 1', synonyms: ['why1', 'why-1', 'first why'] },
  { key: 'why2', label: 'Why 2', canonical: 'why 2', synonyms: ['why2', 'why-2', 'second why'] },
  { key: 'why3', label: 'Why 3', canonical: 'why 3', synonyms: ['why3', 'why-3', 'third why'] },
  { key: 'why4', label: 'Why 4', canonical: 'why 4', synonyms: ['why4', 'why-4', 'fourth why'] },
  { key: 'why5', label: 'Why 5', canonical: 'why 5', synonyms: ['why5', 'why-5', 'fifth why'] },
  { key: 'rootCause', label: 'Final Root Cause', canonical: 'final root cause', synonyms: ['root cause', 'final cause'] },
  { key: 'correctiveAction', label: 'Corrective Action', canonical: 'corrective action', synonyms: ['correction'] },
  { key: 'preventiveAction', label: 'Preventive Action', canonical: 'preventive action', synonyms: ['prevention', 'preventative action'] },
  { key: 'owner', label: 'Action Owner', canonical: 'action owner', synonyms: ['owner', 'responsible'] },
  { key: 'targetDate', label: 'Target Date', canonical: 'target date', synonyms: ['due date'] },
  { key: 'validation', label: 'Completion/Validation', canonical: 'validation', synonyms: ['completion', 'verification'] },
  { key: 'status', label: 'Action Status', canonical: 'action status', synonyms: ['status'] },
  { key: 'closureDate', label: 'Closure Date', canonical: 'closure date', synonyms: ['closed date', 'date closed'] },
  { key: 'approval', label: 'Approval Evidence', canonical: 'approval evidence', synonyms: ['approved by', 'sign off', 'approval'] },
]

function mapHeaders(rawHeaders) {
  return matchFieldsExclusive(rawHeaders, RCA_FIELDS)
}

// ─── Value Helpers ───────────────────────────────────────────────────────────

const PLACEHOLDER_VALUES = new Set(['na', 'n/a', 'none', 'not applicable', '*', '-', '.', 'nil', 'tbd', 'unknown', 'issue', 'error'])
function isMeaningful(v) {
  const s = raw(v)
  if (!s) return false
  return !PLACEHOLDER_VALUES.has(s.toLowerCase())
}

const CLOSED_STATUS_KEYWORDS = ['closed', 'completed', 'approved', 'done']
const VALID_STATUS_KEYWORDS = [...CLOSED_STATUS_KEYWORDS, 'open', 'in progress', 'pending', 'on hold', 'under review', 'in review', 'cancelled', 'canceled', 'deferred', 'planned', 'not started']
function classifyStatus(v) {
  const s = raw(v).toLowerCase()
  if (!s) return { recognized: false, closed: false }
  const closed = CLOSED_STATUS_KEYWORDS.some(k => s.includes(k))
  const recognized = closed || VALID_STATUS_KEYWORDS.some(k => s.includes(k))
  return { recognized, closed }
}

function isFiveWhyMethod(v) {
  const s = normalizeText(v)
  return s.includes('5 why') || s.includes('five why')
}

function parseDateValue(v) {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date && !isNaN(v)) return v
  if (typeof v === 'number') {
    const parsed = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null
    return parsed ? new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0) : null
  }
  const str = String(v).trim()
  if (!str) return null
  const direct = new Date(str)
  if (!isNaN(direct)) return direct
  const m = str.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,}|\d{1,2})[-\/\s](\d{2,4})/)
  if (m) {
    const day = parseInt(m[1], 10)
    const monthToken = m[2]
    const year = parseInt(m[3].length === 2 ? '20' + m[3] : m[3], 10)
    const month = isNaN(monthToken)
      ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthToken.toLowerCase().slice(0, 3))
      : parseInt(monthToken, 10) - 1
    if (month >= 0) {
      const d = new Date(year, month, day)
      if (!isNaN(d)) return d
    }
  }
  return null
}

function formatDate(d) {
  if (!d) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── Finding Factory (private copy — see riskSlaEngine.js convention) ──────

let findingSeq = 0
function makeFinding({ field, sheet, evidence, row = null, rcaId = '', finding, actual = null, expected = null, severity, recommendation, status = 'Open', level = 'row', meta = null }) {
  findingSeq += 1
  return {
    id: `IRP-RCA-${String(findingSeq).padStart(3, '0')}`,
    pa: 'IRP',
    evidence, sheet, row,
    record: rcaId,
    field, finding, actual, expected, severity, recommendation, status, level, meta,
  }
}

function emptyChecklist() {
  return {
    sheetExists: false, idPresent: false, idUnique: false, dateValid: false, dateChronologyOk: false,
    incidentTraceable: false, problemStatementPresent: false, methodPresent: false, fiveWhyComplete: false,
    rootCauseMeaningful: false, correctiveActionPresent: false, preventiveActionPresent: false,
    actionTrackingOk: false, closureEvidenceOk: false, p1p2CoverageOk: false,
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

// `incidentContext`: { available, incidentIds: Set<lowercased id>,
// recordsById: Map<lowercased id, {reportDateTime, priority}>,
// p1p2BreachedIds: Set<incident id>, slaBreachedIds: Set<incident id> } —
// as produced by incidentEngine. RCA is mandatory whenever the Response
// or Resolution SLA is breached, regardless of Priority tier — so this
// cross-check runs against slaBreachedIds (falling back to p1p2BreachedIds
// for backward compatibility with callers that don't supply it).
//
// Returns { supported, findings, rcaIds, rcaByIncidentId, summary, checklist }.
export async function validateRCA(files, incidentContext) {
  findingSeq = 0
  const ctx = incidentContext || { available: false, incidentIds: new Set(), recordsById: new Map(), p1p2BreachedIds: new Set(), slaBreachedIds: new Set() }
  const breachedIds = ctx.slaBreachedIds || ctx.p1p2BreachedIds || new Set()
  const src = await findRCASource(files)

  const p1p2CrossCheck = (rcaByIncidentId) => {
    const findings = []
    for (const incId of breachedIds) {
      if (!rcaByIncidentId.has(incId.toLowerCase())) {
        const rec = ctx.recordsById?.get(incId.toLowerCase())
        const severity = rec?.priority === 'P1' ? 'Critical' : 'Major'
        findings.push(makeFinding({
          field: 'RCA Availability', sheet: 'N/A', evidence: 'RCA register', level: 'sla-rca', rcaId: incId,
          finding: `SLA breach identified for Incident ID "${incId}" (Priority ${rec?.priority || 'Unknown'}). RCA is mandatory for the SLA breach, but no corresponding RCA was found.`,
          actual: 'RCA: Not Available', expected: `RCA referencing Incident ID ${incId}`,
          severity, recommendation: 'Perform and document an RCA for every incident that breaches its Response or Resolution SLA.',
          meta: { gapType: 'RCA Missing', incidentId: incId, priority: rec?.priority || 'Unknown', rcaStatus: 'Not Available' },
        }))
      }
    }
    return findings
  }

  if (!src) {
    const findings = [makeFinding({
      field: 'RCA Register', sheet: 'N/A', evidence: 'IRP folder', level: 'evidence',
      finding: 'Required RCA / Root Cause Analysis evidence is not available in the uploaded project repository.',
      severity: 'Critical',
      recommendation: 'Upload an RCA / 5 Why register documenting root cause analysis for SLA-breached and applicable incidents.',
    })]
    findings.push(...p1p2CrossCheck(new Map()))
    return {
      supported: false, findings, rcaIds: new Set(), rcaByIncidentId: new Map(),
      checklist: emptyChecklist(),
      summary: { total: 0, duplicates: 0, traceabilityGaps: 0, p1p2Required: breachedIds.size, p1p2Missing: breachedIds.size, critical: findings.filter(f=>f.severity==='Critical').length, major: findings.filter(f=>f.severity==='Major').length, minor: 0 },
    }
  }

  if (!src.supported) {
    const findings = [makeFinding({
      field: 'RCA Register', sheet: 'N/A', evidence: src.file.name, level: 'evidence',
      finding: `An RCA document ("${src.file.name}") was found but is not in a supported tabular format (.xlsx, .xls, .csv).`,
      severity: 'Major',
      recommendation: 'Provide the RCA register as an Excel (.xlsx) or CSV file so row-level validation can be performed.',
    })]
    findings.push(...p1p2CrossCheck(new Map()))
    return {
      supported: false, fileName: src.file.name, findings, rcaIds: new Set(), rcaByIncidentId: new Map(),
      checklist: emptyChecklist(),
      summary: { total: 0, duplicates: 0, traceabilityGaps: 0, p1p2Required: breachedIds.size, p1p2Missing: breachedIds.size, critical: findings.filter(f=>f.severity==='Critical').length, major: findings.filter(f=>f.severity==='Major').length, minor: 0 },
    }
  }

  const { sheetName, rows } = await readRows(src.file, src.sheetName)
  if (!rows || rows.length < 2) {
    const findings = [makeFinding({
      field: 'RCA Register', sheet: sheetName || src.file.name, evidence: src.file.name, level: 'evidence',
      finding: 'The RCA register was found but contains no data rows.',
      severity: 'Major', recommendation: 'Populate the RCA register with at least one record.',
    })]
    findings.push(...p1p2CrossCheck(new Map()))
    return {
      supported: false, fileName: src.file.name, sheetName, findings, rcaIds: new Set(), rcaByIncidentId: new Map(),
      checklist: emptyChecklist(),
      summary: { total: 0, duplicates: 0, traceabilityGaps: 0, p1p2Required: breachedIds.size, p1p2Missing: breachedIds.size, critical: findings.filter(f=>f.severity==='Critical').length, major: findings.filter(f=>f.severity==='Major').length, minor: 0 },
    }
  }

  const rawHeaders = rows[0].map(c => String(c ?? '').trim())
  const headerMapping = mapHeaders(rawHeaders)
  const col = Object.fromEntries(Object.entries(headerMapping).map(([k, v]) => [k, v.columnIndex]))
  const evidence = src.file.name
  const sheet = sheetName || src.file.name

  const findings = []
  for (const f of RCA_FIELDS) {
    if (col[f.key] === -1) {
      const optional = ['why1', 'why2', 'why3', 'why4', 'why5'].includes(f.key) // gated on method — no blanket header gap
      if (optional) continue
      findings.push(makeFinding({ field: f.label, sheet, evidence, level: 'header',
        finding: `Required RCA header "${f.label}" was not found (no equivalent column detected).`,
        severity: ['id', 'incidentId', 'rootCause'].includes(f.key) ? 'Major' : 'Minor',
        recommendation: `Add a column for ${f.label} (or an equivalent header) to the RCA register.` }))
    }
  }

  const seenIds = new Map()
  const rcaByIncidentId = new Map()
  const records = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every(c => raw(c) === '')) continue
    const rowNum = r + 1
    const get = key => (col[key] !== -1 && col[key] !== undefined ? row[col[key]] : '')

    const idVal = raw(get('id'))
    const rcaId = idVal || `Row ${rowNum}`
    if (idVal) {
      const norm = idVal.toLowerCase()
      seenIds.set(norm, [...(seenIds.get(norm) || []), rowNum])
    }
    records.push({ rowNum, id: idVal })

    // §17 — RCA ID
    if (!idVal) {
      findings.push(makeFinding({ field: 'RCA ID', sheet, evidence, row: rowNum, rcaId,
        finding: `RCA ID is blank for the record at Row ${rowNum}.`, actual: '(blank)', expected: 'Unique, populated RCA ID',
        severity: 'Major', recommendation: 'Assign a unique RCA ID to this record.' }))
    }

    // §19 — RCA Date
    const dateRaw = get('date')
    const rcaDate = parseDateValue(dateRaw)
    if (!raw(dateRaw)) {
      findings.push(makeFinding({ field: 'RCA Date', sheet, evidence, row: rowNum, rcaId,
        finding: `RCA Date is missing for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'Valid date',
        severity: 'Major', recommendation: 'Populate the RCA Date.' }))
    } else if (!rcaDate) {
      findings.push(makeFinding({ field: 'RCA Date', sheet, evidence, row: rowNum, rcaId,
        finding: `Invalid RCA Date identified for RCA ID ${rcaId}.`, actual: raw(dateRaw), expected: 'Valid, unambiguous date',
        severity: 'Major', recommendation: 'Correct the RCA Date to a valid, unambiguous date.' }))
    }

    // §18 — Incident ID traceability
    const incIdVal = raw(get('incidentId'))
    if (!incIdVal) {
      findings.push(makeFinding({ field: 'Incident ID', sheet, evidence, row: rowNum, rcaId,
        finding: `Incident ID reference is missing for RCA record ${rcaId}.`, actual: '(blank)', expected: 'Reference to a valid Incident ID',
        severity: 'Major', recommendation: 'Reference the source Incident ID this RCA was performed for.' }))
    } else {
      rcaByIncidentId.set(incIdVal.toLowerCase(), { rcaId, rowNum })
      if (ctx.available && !ctx.incidentIds.has(incIdVal.toLowerCase())) {
        findings.push(makeFinding({ field: 'Incident ID', sheet, evidence, row: rowNum, rcaId,
          finding: `RCA Traceability Gap: ${rcaId} references Incident ID "${incIdVal}" which does not exist in the Incident Log.`,
          actual: incIdVal, expected: 'An Incident ID present in the Incident Log',
          severity: 'Major', recommendation: 'Correct the Incident ID reference so it traces to an existing Incident Log record.', level: 'traceability',
          meta: { gapType: 'RCA Traceability Gap', incidentId: incIdVal, rcaId } }))
      } else if (rcaDate) {
        const incRec = ctx.recordsById?.get(incIdVal.toLowerCase())
        if (incRec?.reportDateTime && rcaDate < incRec.reportDateTime) {
          findings.push(makeFinding({ field: 'RCA Date', sheet, evidence, row: rowNum, rcaId,
            finding: `RCA Date for ${rcaId} precedes the Report Date of the related Incident ID "${incIdVal}".`,
            actual: formatDate(rcaDate), expected: `On/after ${formatDate(incRec.reportDateTime)}`,
            severity: 'Major', recommendation: 'Correct the RCA Date/Incident chronology.', level: 'traceability' }))
        }
      }
    }

    // §16 — Problem Statement / Source of Problem
    if (!isMeaningful(get('problemStatement'))) {
      findings.push(makeFinding({ field: 'Problem/Event Statement', sheet, evidence, row: rowNum, rcaId,
        finding: `Problem/Event Statement is missing for RCA ID ${rcaId}.`, actual: raw(get('problemStatement')) || '(blank)', expected: 'Meaningful problem/event statement',
        severity: 'Major', recommendation: 'Document the problem/event statement being analyzed.' }))
    }
    if (col.sourceOfProblem !== -1 && !raw(get('sourceOfProblem'))) {
      findings.push(makeFinding({ field: 'Source of Problem', sheet, evidence, row: rowNum, rcaId,
        finding: `Source of Problem is missing for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'Populated value',
        severity: 'Minor', recommendation: 'Document the source of the problem.' }))
    }

    // §20 — RCA Method / 5 Why completeness
    const methodRaw = get('method')
    if (!raw(methodRaw)) {
      findings.push(makeFinding({ field: 'RCA Method', sheet, evidence, row: rowNum, rcaId,
        finding: `RCA Method is missing for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'e.g. 5 Why, Fishbone, Fault Tree Analysis, Pareto Analysis',
        severity: 'Major', recommendation: 'Document the RCA Method used (e.g. 5 Why, Fishbone, Fault Tree Analysis).' }))
    } else if (isFiveWhyMethod(methodRaw)) {
      const blankWhys = ['why1', 'why2', 'why3', 'why4', 'why5'].filter(k => col[k] === -1 || !raw(get(k)))
      if (blankWhys.length > 0) {
        const labels = blankWhys.map(k => `Why ${k.slice(-1)}`)
        findings.push(makeFinding({ field: 'RCA Completeness', sheet, evidence, row: rowNum, rcaId,
          finding: `5 Why RCA ${rcaId} is incomplete — ${labels.join(', ')} ${labels.length > 1 ? 'are' : 'is'} blank.`,
          actual: `${labels.join(', ')} blank`, expected: 'Why 1 through Why 5 all populated',
          severity: 'Major', recommendation: 'Populate all five "Why" levels for a 5 Why RCA method.' }))
      }
    }

    // §21 — Final Root Cause
    if (!isMeaningful(get('rootCause'))) {
      findings.push(makeFinding({ field: 'Final Root Cause', sheet, evidence, row: rowNum, rcaId,
        finding: `Final Root Cause is missing or not meaningful for RCA ID ${rcaId}.`, actual: raw(get('rootCause')) || '(blank)', expected: 'Meaningful, specific root cause',
        severity: 'Major', recommendation: 'Document a specific, meaningful Final Root Cause.' }))
    }

    // §22 — Corrective / Preventive Action
    if (col.correctiveAction !== -1 && !raw(get('correctiveAction'))) {
      findings.push(makeFinding({ field: 'Corrective Action', sheet, evidence, row: rowNum, rcaId,
        finding: `Corrective Action is missing for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'Populated corrective action',
        severity: 'Major', recommendation: 'Document the corrective action taken.' }))
    }
    if (col.preventiveAction !== -1 && !raw(get('preventiveAction'))) {
      findings.push(makeFinding({ field: 'Preventive Action', sheet, evidence, row: rowNum, rcaId,
        finding: `Preventive Action is missing for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'Populated preventive action',
        severity: 'Major', recommendation: 'Document the preventive action to avoid recurrence.' }))
    }

    // §23 — Action Tracking
    if (col.owner !== -1 && !raw(get('owner'))) {
      findings.push(makeFinding({ field: 'Action Owner', sheet, evidence, row: rowNum, rcaId,
        finding: `Action Owner is not assigned for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'Assigned owner',
        severity: 'Minor', recommendation: 'Assign a responsible Action Owner.' }))
    }
    const targetRaw = get('targetDate')
    if (col.targetDate !== -1 && !raw(targetRaw)) {
      findings.push(makeFinding({ field: 'Target Date', sheet, evidence, row: rowNum, rcaId,
        finding: `Target Date is missing for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'Valid target date',
        severity: 'Minor', recommendation: 'Define a target completion date for the corrective/preventive action.' }))
    } else if (raw(targetRaw) && !parseDateValue(targetRaw)) {
      findings.push(makeFinding({ field: 'Target Date', sheet, evidence, row: rowNum, rcaId,
        finding: `Invalid Target Date identified for RCA ID ${rcaId}.`, actual: raw(targetRaw), expected: 'Valid, unambiguous date',
        severity: 'Minor', recommendation: 'Correct the Target Date to a valid, unambiguous date.' }))
    }

    const statusRaw = get('status')
    const { recognized: statusRecognized, closed: statusClosed } = classifyStatus(statusRaw)
    if (col.status !== -1) {
      if (!raw(statusRaw)) {
        findings.push(makeFinding({ field: 'Action Status', sheet, evidence, row: rowNum, rcaId,
          finding: `Action Status is missing for RCA ID ${rcaId}.`, actual: '(blank)', expected: 'Open, In Progress, Closed, Completed, or Approved',
          severity: 'Major', recommendation: 'Populate the Action Status (e.g. Open, In Progress, Closed, Completed, Approved).' }))
      } else if (!statusRecognized) {
        findings.push(makeFinding({ field: 'Action Status', sheet, evidence, row: rowNum, rcaId,
          finding: `Invalid Action Status identified for RCA ID ${rcaId}.`, actual: raw(statusRaw), expected: 'Open, In Progress, Closed, Completed, or Approved',
          severity: 'Major', recommendation: 'Use a recognized Action Status value (Open, In Progress, Closed, Completed, Approved).' }))
      } else if (statusClosed) {
        // §23 — closure evidence
        if (col.closureDate !== -1 && !raw(get('closureDate'))) {
          findings.push(makeFinding({ field: 'Closure Date', sheet, evidence, row: rowNum, rcaId,
            finding: `RCA action ${rcaId} is marked as completed, but Closure Date is not available.`, actual: '(blank)', expected: 'Populated Closure Date',
            severity: 'Major', recommendation: 'Populate the Closure Date for completed RCA actions.' }))
        }
        const hasValidation = isMeaningful(get('validation'))
        const hasApproval = isMeaningful(get('approval'))
        if ((col.validation !== -1 || col.approval !== -1) && !hasValidation && !hasApproval) {
          findings.push(makeFinding({ field: 'Approval Evidence', sheet, evidence, row: rowNum, rcaId,
            finding: `RCA action ${rcaId} is marked as completed, but supporting closure/validation/approval evidence is not available.`, actual: '(blank)', expected: 'Validation or Approval evidence',
            severity: 'Major', recommendation: 'Attach validation/verification or approval evidence for this completed RCA action.' }))
        }
      }
    }
  }

  // §17 — Duplicate RCA IDs
  for (const [norm, rowNums] of seenIds.entries()) {
    if (rowNums.length > 1) {
      const original = records.find(rec => rec.id.toLowerCase() === norm)?.id || norm
      findings.push(makeFinding({ field: 'RCA ID', sheet, evidence, rcaId: original,
        finding: `Duplicate RCA ID "${original}" identified in the RCA register (rows ${rowNums.join(', ')}).`,
        actual: `Appears ${rowNums.length} times (rows ${rowNums.join(', ')})`, expected: 'Unique RCA ID',
        severity: 'Major', recommendation: 'Ensure every RCA ID is unique across the register.' }))
    }
  }

  // §14 — P1/P2 SLA-breached incidents must have a corresponding RCA
  findings.push(...p1p2CrossCheck(rcaByIncidentId))

  const rcaIds = new Set(records.filter(r => r.id).map(r => r.id.toLowerCase()))
  const traceabilityGaps = findings.filter(f => f.level === 'traceability' && f.finding.includes('does not exist')).length
  const p1p2Required = breachedIds.size
  const p1p2Missing = findings.filter(f => f.field === 'RCA Availability').length

  const critical = findings.filter(f => f.severity === 'Critical').length
  const major = findings.filter(f => f.severity === 'Major').length
  const minor = findings.filter(f => f.severity === 'Minor').length

  return {
    supported: true,
    fileName: src.file.name,
    sheetName,
    headerMapping,
    findings,
    rcaIds,
    rcaByIncidentId,
    checklist: {
      sheetExists: true,
      idPresent: !findings.some(f => f.field === 'RCA ID' && f.finding.includes('is blank')),
      idUnique: !findings.some(f => f.field === 'RCA ID' && f.finding.includes('Duplicate')),
      dateValid: !findings.some(f => f.field === 'RCA Date' && f.finding.includes('Invalid')),
      dateChronologyOk: !findings.some(f => f.finding.includes('precedes the Report Date')),
      incidentTraceable: !findings.some(f => f.finding.includes('does not exist in the Incident Log')),
      problemStatementPresent: !findings.some(f => f.field === 'Problem/Event Statement'),
      methodPresent: !findings.some(f => f.field === 'RCA Method'),
      fiveWhyComplete: !findings.some(f => f.field === 'RCA Completeness'),
      rootCauseMeaningful: !findings.some(f => f.field === 'Final Root Cause'),
      correctiveActionPresent: !findings.some(f => f.field === 'Corrective Action'),
      preventiveActionPresent: !findings.some(f => f.field === 'Preventive Action'),
      actionTrackingOk: !findings.some(f => ['Action Owner', 'Target Date', 'Action Status'].includes(f.field)),
      closureEvidenceOk: !findings.some(f => f.field === 'Closure Date' || f.field === 'Approval Evidence'),
      p1p2CoverageOk: p1p2Missing === 0,
    },
    summary: { total: records.length, duplicates: [...seenIds.values()].filter(v => v.length > 1).length, traceabilityGaps, p1p2Required, p1p2Missing, critical, major, minor },
  }
}
