// ─── Incident Log Validation Engine (IRP) ──────────────────────────────────
//
// Detects the Incident Log / Issue Log / Incident Register / Incident
// Tracker by semantic file/sheet matching, maps its header row to the 26
// required logical fields (semantic matching, never exact-name dependent),
// then performs row-level data-quality, chronology, Priority Matrix, and
// SLA validation. Read-only — never modifies the source file.
//
// Exposes parsed records (id/priority/impact/urgency/status/dates/SLA
// breach flags) so rcaEngine.js can validate RCA-required-for-breach
// traceability without re-parsing the sheet.
//
// NOTE: follows the same self-contained-module convention already used by
// riskSlaEngine.js and irpEngine.js (own local file-reading + finding
// factory) so this module can be added without touching either of them.

import * as XLSX from 'xlsx'
import { normalizeText, matchFieldsExclusive, nameMatchesKeywords } from './textMatch'

export const INCIDENT_LOG_NAME_KEYWORDS = [
  'incident log', 'issue log', 'incident register', 'incident tracker',
  'incident management log', 'irp log', 'incident log register',
  'issue register', 'issue tracker',
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

// Locates the Incident Log among `files`. Exported so rcaEngine.js can
// independently confirm/reuse the same detection without importing private
// state from this module.
export async function findIncidentLog(files) {
  return findNamedSource(files, INCIDENT_LOG_NAME_KEYWORDS)
}

// ─── Required Logical Fields (spec §3) ──────────────────────────────────────

const INC_FIELDS = [
  { key: 'id', label: 'Incident ID', severity: 'Critical', canonical: 'incident id',
    synonyms: ['issue id', 'id', 'ticket id', 'incident number', 'issue number'] },
  { key: 'status', label: 'Status', severity: 'Critical', canonical: 'status',
    synonyms: ['incident status', 'current status'] },
  { key: 'category', label: 'Category', severity: 'Major', canonical: 'category',
    synonyms: ['incident category', 'issue category', 'type'] },
  { key: 'description', label: 'Description', severity: 'Critical', canonical: 'description',
    synonyms: ['incident description', 'issue description', 'summary', 'details'] },
  { key: 'priority', label: 'Priority', severity: 'Critical', canonical: 'priority',
    synonyms: ['priority level'] },
  { key: 'owner', label: 'Owner', severity: 'Major', canonical: 'owner',
    synonyms: ['assigned to', 'incident owner', 'responsible'] },
  { key: 'recurrence', label: 'Recurrence', severity: 'Minor', canonical: 'recurrence',
    synonyms: ['recurring', 'repeat occurrence', 'recurrence status'] },
  { key: 'impact', label: 'Impact', severity: 'Critical', canonical: 'impact',
    synonyms: ['impact level', 'business impact'] },
  { key: 'severity', label: 'Severity', severity: 'Minor', canonical: 'severity',
    synonyms: ['severity level'] },
  { key: 'escalateTo', label: 'Escalate To', severity: 'Minor', canonical: 'escalate to',
    synonyms: ['escalation', 'escalated to', 'escalation contact'] },
  { key: 'cause', label: 'Cause', severity: 'Minor', canonical: 'cause',
    synonyms: ['cause of incident', 'contributing cause'] },
  { key: 'ncStatus', label: 'Non-Conformity Status', severity: 'Minor', canonical: 'nc status',
    synonyms: ['non-conformity status', 'non conformity status', 'nc'] },
  { key: 'response', label: 'Response', severity: 'Major', canonical: 'response',
    synonyms: ['response action', 'response details', 'response plan'] },
  { key: 'closureCriteria', label: 'Closure Criteria', severity: 'Major', canonical: 'closure criteria',
    synonyms: ['closure verification', 'closure conditions'] },
  { key: 'finalResolution', label: 'Final Resolution', severity: 'Major', canonical: 'final resolution',
    synonyms: ['resolution', 'resolution details', 'resolution summary'] },
  { key: 'closureApprovedBy', label: 'Closure Approved By', severity: 'Minor', canonical: 'closure approved by',
    synonyms: ['closure approval', 'approved by', 'closure sign off'] },
  { key: 'mirReportIssued', label: 'MIR Report Issued', severity: 'Minor', canonical: 'mir report issued',
    synonyms: ['mir report', 'major incident report', 'mir issued'] },
  { key: 'incidentType', label: 'Incident Type', severity: 'Minor', canonical: 'incident type',
    synonyms: ['type of incident'] },
  { key: 'reportDateTime', label: 'Report Date & Time', severity: 'Major', canonical: 'report date time',
    synonyms: ['reported date', 'report date', 'date reported', 'logged date', 'date time reported', 'opened date'] },
  { key: 'reportedBy', label: 'Reported By', severity: 'Minor', canonical: 'reported by',
    synonyms: ['raised by', 'logged by'] },
  { key: 'rootCause', label: 'Root Cause', severity: 'Major', canonical: 'root cause',
    synonyms: ['root cause summary'] },
  { key: 'closeDateTime', label: 'Close Date / Closure Date & Time', severity: 'Major', canonical: 'close date time',
    synonyms: ['closed date', 'closure date', 'close date', 'resolved date', 'date closed', 'closure date time'] },
  { key: 'clientRemarks', label: 'Client Remarks', severity: 'Minor', canonical: 'client remarks',
    synonyms: ['customer remarks', 'client comments'] },
  { key: 'urgency', label: 'Urgency', severity: 'Critical', canonical: 'urgency',
    synonyms: ['urgency level'] },
  { key: 'sla', label: 'SLA', severity: 'Major', canonical: 'sla',
    synonyms: ['sla target', 'sla applicable'] },
  { key: 'slaStatus', label: 'SLA Status', severity: 'Major', canonical: 'sla status',
    synonyms: ['sla compliance', 'sla breach status'] },
  // Not part of the official 26 — detected opportunistically so Response
  // SLA can be computed when the data genuinely supports it (§13).
  { key: 'responseDateTime', label: 'Response Date & Time', severity: 'Minor', canonical: 'response date time',
    synonyms: ['first response date', 'response time', 'date responded', 'response date & time', 'first response'] },
]

function mapHeaders(rawHeaders) {
  return matchFieldsExclusive(rawHeaders, INC_FIELDS)
}

// ─── Value Helpers ───────────────────────────────────────────────────────────

const DESC_PLACEHOLDERS = new Set(['na', 'n/a', '-', 'issue', 'problem'])
function isMeaningfulDescription(v) {
  const s = raw(v)
  if (!s) return false
  return !DESC_PLACEHOLDERS.has(s.toLowerCase())
}

const MEANINGLESS_VALUES = new Set(['na', 'n/a', 'none', 'unknown', 'issue', 'error', 'tbd', '-', '.', 'nil'])
function isMeaningfulValue(v) {
  const s = raw(v)
  if (!s) return false
  return !MEANINGLESS_VALUES.has(s.toLowerCase())
}

// Null/blank detection for mandatory checklist fields (Category, Impact,
// Urgency, Priority, Close Date, Close Time): blank/whitespace-only, AND
// "N/A"/"NA" — "N/A" must never be silently accepted as a valid value for a
// required field. The original source value is never modified; this is
// validation-only normalization.
const BLANK_LIKE_VALUES = new Set(['n/a', 'na'])
function isBlank(v) {
  const s = raw(v)
  if (!s) return true
  return BLANK_LIKE_VALUES.has(s.toLowerCase())
}

const CLOSED_STATUS_KEYWORDS = ['closed', 'resolved', 'completed', 'done']
const OPEN_STATUS_KEYWORDS = ['open', 'in progress', 'pending', 'assigned', 'under review', 'new', 'reopen']
function classifyIncidentStatus(v) {
  const s = raw(v).toLowerCase()
  if (!s) return { recognized: false, closed: false }
  const closed = CLOSED_STATUS_KEYWORDS.some(k => s.includes(k))
  const open = OPEN_STATUS_KEYWORDS.some(k => s.includes(k))
  return { recognized: closed || open, closed }
}

function classifyLevel(v) {
  const s = raw(v).toLowerCase()
  if (!s) return null
  if (s === 'h' || s.includes('high')) return 'high'
  if (s === 'm' || s.includes('med')) return 'medium'
  if (s === 'l' || s.includes('low')) return 'low'
  return null
}

function classifyPriorityLevel(v) {
  const s = raw(v).toLowerCase()
  if (!s) return null
  if (s.includes('p1') || s === '1') return 'P1'
  if (s.includes('p2') || s === '2') return 'P2'
  if (s.includes('p3') || s === '3') return 'P3'
  if (s.includes('p4') || s === '4') return 'P4'
  return null
}

// Issue Category — centralized allowed-category configuration (single
// source of truth — do not hardcode this list anywhere else). Only these
// four values are valid; comparison is case/whitespace normalized, but
// unrelated category names (e.g. "Database Issue") are never silently
// accepted or auto-corrected into one of the four.
export const ALLOWED_ISSUE_CATEGORIES = ['Software Errors', 'Hardware Failures', 'Network Outages', 'User-reported Problems']
const ALLOWED_ISSUE_CATEGORIES_NORMALIZED = new Set(ALLOWED_ISSUE_CATEGORIES.map(c => c.toLowerCase()))
function normalizeCategory(v) { return raw(v).toLowerCase().replace(/\s+/g, ' ').trim() }
function isValidIssueCategory(v) { return ALLOWED_ISSUE_CATEGORIES_NORMALIZED.has(normalizeCategory(v)) }

// Issue Category blank detection — on top of the shared isBlank() rules
// (empty cell/null/empty string/whitespace-only, including non-breaking
// spaces: raw()'s String.prototype.trim() strips U+00A0 like any other
// Unicode whitespace, and "N/A"/"NA"), some uploaded Issue Logs literally
// write the word "Blank" into the cell instead of leaving it empty — that
// must be treated as missing too, never as an "unrecognized category" gap.
// Valid categories (Software Errors, Hardware Failures, Network Outages,
// User-reported Problems) are completely unaffected by this check.
function isBlankIssueCategory(v) {
  if (isBlank(v)) return true
  return normalizeCategory(v) === 'blank'
}

// §11 — EXACT Priority Matrix — centralized single source of truth for
// Impact+Urgency → Priority. Never inferred or overridden by any other rule.
export const PRIORITY_MATRIX = {
  high:   { high: 'P1', medium: 'P1', low: 'P2' },
  medium: { high: 'P2', medium: 'P3', low: 'P3' },
  low:    { high: 'P3', medium: 'P4', low: 'P4' },
}

// §12 — EXACT SLA Matrix, expressed in minutes.
const SLA_MATRIX = {
  P1: { responseMin: 30, resolutionMin: 2 * 60, label: { response: '30 Minutes', resolution: '2 Hours' } },
  P2: { responseMin: 60, resolutionMin: 8 * 60, label: { response: '1 Hour', resolution: '8 Hours' } },
  P3: { responseMin: 4 * 60, resolutionMin: 16 * 60, label: { response: '4 Hours', resolution: '16 Hours' } },
  P4: { responseMin: 24 * 60, resolutionMin: 3 * 24 * 60, label: { response: '1 Day', resolution: '3 Days' } },
}

function parseDateTime(v) {
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
  const m = str.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,}|\d{1,2})[-\/\s](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (m) {
    const day = parseInt(m[1], 10)
    const monthToken = m[2]
    const year = parseInt(m[3].length === 2 ? '20' + m[3] : m[3], 10)
    const month = isNaN(monthToken)
      ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthToken.toLowerCase().slice(0, 3))
      : parseInt(monthToken, 10) - 1
    if (month >= 0) {
      const d = new Date(year, month, day, parseInt(m[4] || '0', 10), parseInt(m[5] || '0', 10), parseInt(m[6] || '0', 10))
      if (!isNaN(d)) return d
    }
  }
  return null
}

function formatDateTime(d) {
  if (!d) return ''
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatMinutes(min) {
  if (min < 60) return `${Math.round(min)} min`
  if (min < 24 * 60) return `${(min / 60).toFixed(1)} hr`
  return `${(min / (24 * 60)).toFixed(1)} day(s)`
}

// Time-only parsing ("15:30", "3:30 PM") for the split Close Time column.
function parseTimeOnly(v) {
  if (v instanceof Date && !isNaN(v)) return { h: v.getHours(), min: v.getMinutes(), sec: v.getSeconds() }
  const s = raw(v)
  if (!s) return null
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const sec = parseInt(m[3] || '0', 10)
  const ampm = m[4]
  if (ampm) {
    if (/pm/i.test(ampm) && h < 12) h += 12
    if (/am/i.test(ampm) && h === 12) h = 0
  }
  if (h > 23 || min > 59) return null
  return { h, min, sec }
}

// Merges a date-only value with a time-only value into one Date object for
// chronology/SLA calculations — used only when the Incident Log has
// separate Close Date / Close Time columns instead of one combined column.
// Never modifies the original source values.
function combineDateAndTime(dateVal, timeVal) {
  const d = parseDateTime(dateVal)
  if (!d) return null
  const t = parseTimeOnly(timeVal)
  if (!t) return d
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.min, t.sec)
}

// Dedicated, exact-match-only column lookup for the split "Close Date" /
// "Close Time" headers — deliberately NOT routed through
// matchFieldsExclusive/INC_FIELDS, since "Close Date" and "Close Time" are
// substrings of the existing combined field's canonical name ("close date
// time") and would collide with its fuzzy/substring matching. Exact
// (normalized) match only.
const CLOSE_DATE_HEADER_NAMES = ['Close Date', 'Closed Date', 'Date Closed']
const CLOSE_TIME_HEADER_NAMES = ['Close Time', 'Closed Time', 'Time Closed']
function findExactColumn(rawHeaders, candidateNames) {
  const normalizedHeaders = rawHeaders.map(h => normalizeText(h))
  for (const name of candidateNames) {
    const n = normalizeText(name)
    const idx = normalizedHeaders.findIndex(h => h === n)
    if (idx !== -1) return idx
  }
  return -1
}

// ─── Finding Factory (private copy — see riskSlaEngine.js convention) ──────

let findingSeq = 0
function makeFinding({ field, sheet, evidence, row = null, incidentId = '', finding, actual = null, expected = null, severity, recommendation, status = 'Open', level = 'row', meta = null }) {
  findingSeq += 1
  return {
    id: `IRP-INC-${String(findingSeq).padStart(3, '0')}`,
    pa: 'IRP',
    evidence,
    sheet,
    row,
    record: incidentId,
    field,
    finding,
    actual,
    expected,
    severity,
    recommendation,
    status,
    meta,
    level,
  }
}

function emptyChecklist() {
  return {
    sheetExists: false, idPresent: false, idUnique: false, datesValid: false, chronologyValid: false,
    statusValid: false, categoryPresent: false, descriptionMeaningful: false, impactValid: false,
    urgencyValid: false, priorityMatrixOk: false, slaCalculated: false,
  }
}

// ─── Checklist Rule Validators (dedicated validation layer) ────────────────
//
// Each function validates exactly one checklist rule for one incident
// record and returns the findings for that rule — never mixed into UI
// rendering, never invoked with dummy/hardcoded data (always called from
// validateIncidentRecord() below, once per real uploaded row). Composed as:
//
//   validateIncidentRecord()
//       ├── validateClosedDateTime()
//       ├── validateIssueCategory()
//       ├── validateImpact()
//       ├── validateUrgency()
//       └── validatePriority()
//
// Category validation reads from the centralized ALLOWED_ISSUE_CATEGORIES
// config; Priority validation reads from the centralized PRIORITY_MATRIX —
// single source of truth for both, never re-hardcoded elsewhere.

function validateIssueCategory({ incId, categoryRaw, sheet, evidence, rowNum }) {
  const findings = []
  if (isBlankIssueCategory(categoryRaw)) {
    findings.push(makeFinding({ field: 'Issue Category', sheet, evidence, row: rowNum, incidentId: incId,
      finding: `Issue ID ${incId}: Issue Category is missing/blank. Please update the Issue Category for this incident.`,
      actual: raw(categoryRaw) || '(blank)', expected: ALLOWED_ISSUE_CATEGORIES.join(' / '),
      severity: 'Major',
      recommendation: `Issue ID ${incId}: Update the Issue Category using one of the approved categories: ${ALLOWED_ISSUE_CATEGORIES.join(', ')}.`,
      meta: { gapType: 'Issue Category Missing', incidentId: incId, validationStatus: 'Gap' } }))
  } else if (!isValidIssueCategory(categoryRaw)) {
    findings.push(makeFinding({ field: 'Issue Category', sheet, evidence, row: rowNum, incidentId: incId,
      finding: `Incident ${incId}: Issue Category is not a defined category: ${raw(categoryRaw)}.`,
      actual: raw(categoryRaw), expected: ALLOWED_ISSUE_CATEGORIES.join(' / '),
      severity: 'Major', recommendation: 'Correct the Issue Category using one of the approved checklist categories.',
      meta: { gapType: 'Invalid Issue Category', incidentId: incId, allowedCategories: ALLOWED_ISSUE_CATEGORIES, validationStatus: 'Gap' } }))
  }
  return findings
}

function validateImpact({ incId, impactRaw, sheet, evidence, rowNum }) {
  const findings = []
  let impactLevel = null
  if (isBlank(impactRaw)) {
    findings.push(makeFinding({ field: 'Impact', sheet, evidence, row: rowNum, incidentId: incId,
      finding: `Impact is missing for Incident ${incId}. Priority cannot be validated without a valid Impact value.`,
      actual: '(blank)', expected: 'High, Medium, or Low',
      severity: 'Major', recommendation: 'Update the Incident Log with valid Impact and Urgency values before determining the incident Priority.',
      meta: { gapType: 'Impact Missing', incidentId: incId } }))
  } else {
    impactLevel = classifyLevel(impactRaw)
    if (!impactLevel) {
      findings.push(makeFinding({ field: 'Impact', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Incident ${incId} contains an invalid Impact value '${raw(impactRaw)}'. Impact must be High, Medium, or Low according to the defined checklist.`,
        actual: raw(impactRaw), expected: 'High, Medium, or Low',
        severity: 'Major', recommendation: 'Use a recognized Impact value (High, Medium, Low).',
        meta: { gapType: 'Invalid Impact', incidentId: incId } }))
    }
  }
  return { findings, impactLevel }
}

function validateUrgency({ incId, urgencyRaw, sheet, evidence, rowNum }) {
  const findings = []
  let urgencyLevel = null
  if (isBlank(urgencyRaw)) {
    findings.push(makeFinding({ field: 'Urgency', sheet, evidence, row: rowNum, incidentId: incId,
      finding: `Urgency is missing for Incident ${incId}. Priority cannot be validated without a valid Urgency value.`,
      actual: '(blank)', expected: 'High, Medium, or Low',
      severity: 'Major', recommendation: 'Update the Incident Log with valid Impact and Urgency values before determining the incident Priority.',
      meta: { gapType: 'Urgency Missing', incidentId: incId } }))
  } else {
    urgencyLevel = classifyLevel(urgencyRaw)
    if (!urgencyLevel) {
      findings.push(makeFinding({ field: 'Urgency', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Incident ${incId} contains an invalid Urgency value '${raw(urgencyRaw)}'. Urgency must be High, Medium, or Low according to the defined checklist.`,
        actual: raw(urgencyRaw), expected: 'High, Medium, or Low',
        severity: 'Major', recommendation: 'Use a recognized Urgency value (High, Medium, Low).',
        meta: { gapType: 'Invalid Urgency', incidentId: incId } }))
    }
  }
  return { findings, urgencyLevel }
}

// Priority is independently CALCULATED from Impact+Urgency via
// PRIORITY_MATRIX and compared against the recorded value — the recorded
// Priority is never trusted on its own. Never calculates/compares a
// mismatch when Impact or Urgency itself is missing/invalid (§7) — that
// would misclassify a data-availability gap as a priority-mismatch gap.
function validatePriority({ incId, priorityRaw, impactLevel, urgencyLevel, sheet, evidence, rowNum }) {
  const findings = []
  let actualPriority = null
  let expectedPriority = null

  if (isBlank(priorityRaw)) {
    findings.push(makeFinding({ field: 'Priority', sheet, evidence, row: rowNum, incidentId: incId,
      finding: `Priority is not defined for Incident ${incId}. Priority must be calculated based on the approved Impact/Urgency Priority Matrix.`,
      actual: '(blank)', expected: 'P1, P2, P3, or P4',
      severity: 'Critical', recommendation: 'Populate Priority (P1-P4).',
      meta: { gapType: 'Priority Missing', incidentId: incId } }))
  } else {
    actualPriority = classifyPriorityLevel(priorityRaw)
    if (!actualPriority) {
      findings.push(makeFinding({ field: 'Priority', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Incident ${incId} contains an invalid Priority value '${raw(priorityRaw)}'. The approved Priority values are P1, P2, P3, and P4.`,
        actual: raw(priorityRaw), expected: 'P1, P2, P3, or P4',
        severity: 'Critical', recommendation: 'Use a recognized Priority value (P1, P2, P3, P4).',
        meta: { gapType: 'Invalid Priority', incidentId: incId } }))
    }
  }

  if (impactLevel && urgencyLevel) {
    expectedPriority = PRIORITY_MATRIX[impactLevel][urgencyLevel]
    if (actualPriority && actualPriority !== expectedPriority) {
      const impactLabel = impactLevel[0].toUpperCase() + impactLevel.slice(1)
      const urgencyLabel = urgencyLevel[0].toUpperCase() + urgencyLevel.slice(1)
      findings.push(makeFinding({ field: 'Priority', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Priority mismatch: Incident ${incId} has Impact '${impactLabel}' and Urgency '${urgencyLabel}'. According to the approved Priority Matrix, the expected Priority is '${expectedPriority}', but the recorded Priority is '${actualPriority}'.`,
        actual: actualPriority, expected: expectedPriority,
        severity: 'Major', recommendation: 'Reassess the incident Priority using the approved Impact/Urgency Priority Matrix and update the recorded Priority accordingly.', level: 'sla-rca',
        meta: { gapType: 'Priority Mismatch', incidentId: incId, impact: impactLabel, urgency: urgencyLabel, recordedPriority: actualPriority, expectedPriority } }))
    }
  }

  return { findings, actualPriority, expectedPriority }
}

// If Issue Status = Closed, Close Date AND Close Time are independently
// mandatory. Supports two Incident Log shapes without changing the source
// data: (a) separate "Close Date" + "Close Time" columns — validated and
// reported independently, so an incident can have one, the other, or both
// findings; (b) one combined "Close Date & Time" column (pre-existing
// behavior, unchanged). Never fires when Issue Status is not Closed.
function validateClosedDateTime({ incId, statusClosed, closeCombinedRaw, closeDateRaw, closeTimeRaw, hasSplitCloseFields, sheet, evidence, rowNum }) {
  const findings = []
  let closeDT = parseDateTime(closeCombinedRaw)

  if (statusClosed) {
    if (hasSplitCloseFields) {
      if (isBlank(closeDateRaw)) {
        findings.push(makeFinding({ field: 'Close Date', sheet, evidence, row: rowNum, incidentId: incId,
          finding: `Incident ${incId} is marked as Closed, but Close Date is not defined.`,
          actual: '(blank)', expected: 'A valid Close Date',
          severity: 'Major', recommendation: 'Update the Incident Log with the actual Close Date and Close Time for every incident marked as Closed.',
          meta: { gapType: 'Close Date Missing', incidentId: incId, issueStatus: 'Closed' } }))
      }
      if (isBlank(closeTimeRaw)) {
        findings.push(makeFinding({ field: 'Close Time', sheet, evidence, row: rowNum, incidentId: incId,
          finding: `Incident ${incId} is marked as Closed, but Close Time is not defined.`,
          actual: '(blank)', expected: 'A valid Close Time',
          severity: 'Major', recommendation: 'Update the Incident Log with the actual Close Date and Close Time for every incident marked as Closed.',
          meta: { gapType: 'Close Time Missing', incidentId: incId, issueStatus: 'Closed' } }))
      }
      if (!closeDT) closeDT = combineDateAndTime(closeDateRaw, closeTimeRaw)
    } else if (isBlank(closeCombinedRaw)) {
      findings.push(makeFinding({ field: 'Close Date & Time', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Incident ${incId} is marked as Closed, but the required Close Date/Close Time has not been provided.`,
        actual: '(blank)', expected: 'A valid Close Date and Close Time, on/after the Report Date',
        severity: 'Major', recommendation: 'Update the Incident Log with the actual Close Date and Close Time for every incident marked as Closed.',
        meta: { gapType: 'Closed Date/Time Missing', incidentId: incId, issueStatus: 'Closed' } }))
    } else if (!closeDT) {
      findings.push(makeFinding({ field: 'Close Date & Time', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Invalid Close Date & Time identified for Incident ID ${incId}.`, actual: raw(closeCombinedRaw),
        severity: 'Major', recommendation: 'Correct the Close Date & Time to a valid, unambiguous date/time.' }))
    }
  } else if (!hasSplitCloseFields && raw(closeCombinedRaw) && !closeDT) {
    findings.push(makeFinding({ field: 'Close Date & Time', sheet, evidence, row: rowNum, incidentId: incId,
      finding: `Invalid Close Date & Time identified for Incident ID ${incId}.`, actual: raw(closeCombinedRaw),
      severity: 'Minor', recommendation: 'Correct the Close Date & Time to a valid, unambiguous date/time.' }))
  }

  return { findings, closeDT }
}

// Orchestrator — composes the five rule validators above for one incident
// record, returning their combined findings plus the derived values
// (impactLevel/urgencyLevel/actualPriority/closeDT) the caller needs for
// downstream SLA calculation and chronology checks.
function validateIncidentRecord(ctx) {
  const categoryFindings = validateIssueCategory(ctx)
  const impactResult = validateImpact(ctx)
  const urgencyResult = validateUrgency(ctx)
  const priorityResult = validatePriority({ ...ctx, impactLevel: impactResult.impactLevel, urgencyLevel: urgencyResult.urgencyLevel })
  const closedDateTimeResult = validateClosedDateTime(ctx)

  return {
    findings: [
      ...categoryFindings,
      ...impactResult.findings,
      ...urgencyResult.findings,
      ...priorityResult.findings,
      ...closedDateTimeResult.findings,
    ],
    impactLevel: impactResult.impactLevel,
    urgencyLevel: urgencyResult.urgencyLevel,
    actualPriority: priorityResult.actualPriority,
    expectedPriority: priorityResult.expectedPriority,
    closeDT: closedDateTimeResult.closeDT,
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

// Returns { supported, findings, records, incidentIds, p1p2BreachedIds,
// summary, checklist } — never throws.
export async function validateIncidentLog(files) {
  findingSeq = 0
  const src = await findIncidentLog(files)

  if (!src) {
    return {
      supported: false,
      findings: [makeFinding({
        field: 'Incident Log', sheet: 'N/A', evidence: 'IRP folder', level: 'evidence',
        finding: 'Required Incident Log evidence is not available in the uploaded project repository.',
        severity: 'Critical',
        recommendation: 'Upload an Incident Log / Issue Log documenting all raised incidents.',
      })],
      records: [], incidentIds: new Set(), p1p2BreachedIds: new Set(), slaBreachedIds: new Set(),
      checklist: emptyChecklist(),
      summary: { total: 0, p1: 0, p2: 0, p3: 0, p4: 0, slaBreaches: 0, p1Breaches: 0, p2Breaches: 0, duplicates: 0, critical: 1, major: 0, minor: 0 },
    }
  }

  if (!src.supported) {
    return {
      supported: false,
      fileName: src.file.name,
      findings: [makeFinding({
        field: 'Incident Log', sheet: 'N/A', evidence: src.file.name, level: 'evidence',
        finding: `An Incident Log document ("${src.file.name}") was found but is not in a supported tabular format (.xlsx, .xls, .csv).`,
        severity: 'Major',
        recommendation: 'Provide the Incident Log as an Excel (.xlsx) or CSV file so row-level validation can be performed.',
      })],
      records: [], incidentIds: new Set(), p1p2BreachedIds: new Set(), slaBreachedIds: new Set(),
      checklist: emptyChecklist(),
      summary: { total: 0, p1: 0, p2: 0, p3: 0, p4: 0, slaBreaches: 0, p1Breaches: 0, p2Breaches: 0, duplicates: 0, critical: 0, major: 1, minor: 0 },
    }
  }

  const { sheetName, rows } = await readRows(src.file, src.sheetName)
  if (!rows || rows.length < 2) {
    return {
      supported: false,
      fileName: src.file.name, sheetName,
      findings: [makeFinding({
        field: 'Incident Log', sheet: sheetName || src.file.name, evidence: src.file.name, level: 'evidence',
        finding: 'The Incident Log was found but contains no data rows.',
        severity: 'Major',
        recommendation: 'Populate the Incident Log with at least one record.',
      })],
      records: [], incidentIds: new Set(), p1p2BreachedIds: new Set(), slaBreachedIds: new Set(),
      checklist: emptyChecklist(),
      summary: { total: 0, p1: 0, p2: 0, p3: 0, p4: 0, slaBreaches: 0, p1Breaches: 0, p2Breaches: 0, duplicates: 0, critical: 0, major: 1, minor: 0 },
    }
  }

  const rawHeaders = rows[0].map(c => String(c ?? '').trim())
  const headerMapping = mapHeaders(rawHeaders)
  const col = Object.fromEntries(Object.entries(headerMapping).map(([k, v]) => [k, v.columnIndex]))
  const evidence = src.file.name
  const sheet = sheetName || src.file.name

  // Split Close Date / Close Time columns (see findExactColumn above) —
  // detected once per file, independent of the combined "Close Date & Time"
  // column (col.closeDateTime).
  const closeDateColIdx = findExactColumn(rawHeaders, CLOSE_DATE_HEADER_NAMES)
  const closeTimeColIdx = findExactColumn(rawHeaders, CLOSE_TIME_HEADER_NAMES)
  const hasSplitCloseFields = closeDateColIdx !== -1 || closeTimeColIdx !== -1

  // Header-missing gaps (once per field, not per row).
  const headerGapFindings = []
  for (const f of INC_FIELDS) {
    if (f.key === 'responseDateTime') continue // optional/opportunistic — no gap if absent
    if (col[f.key] === -1) {
      headerGapFindings.push(makeFinding({
        field: f.label, sheet, evidence, level: 'header',
        finding: `Required Incident Log header "${f.label}" was not found (no equivalent column detected).`,
        severity: f.severity,
        recommendation: `Add a column for ${f.label} (or an equivalent header) to the Incident Log.`,
      }))
    }
  }

  if (col.responseDateTime === -1) {
    headerGapFindings.push(makeFinding({
      field: 'Response Date & Time', sheet, evidence, level: 'sla-rca',
      finding: 'No dedicated Response / First-Response timestamp field was found in the Incident Log — Response SLA will be calculated using Closed Date & Time in place of a dedicated first-response timestamp.',
      severity: 'Minor',
      recommendation: 'Add a Response / First Response Date & Time column to enable more precise, first-response-based Response SLA validation.',
    }))
  }

  const findings = [...headerGapFindings]
  const records = []
  const seenIds = new Map()

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every(c => raw(c) === '')) continue
    const rowNum = r + 1
    const get = key => (col[key] !== -1 && col[key] !== undefined ? row[col[key]] : '')

    const idVal = raw(get('id'))
    const incId = idVal || `Row ${rowNum}`
    if (idVal) {
      const norm = idVal.toLowerCase()
      seenIds.set(norm, [...(seenIds.get(norm) || []), rowNum])
    }

    // §4 — Incident ID
    if (!idVal) {
      findings.push(makeFinding({ field: 'Incident ID', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Incident ID is blank for the record at Row ${rowNum}.`, actual: '(blank)', expected: 'Unique, populated Incident ID',
        severity: 'Critical', recommendation: 'Assign a unique Incident ID to this record.' }))
    }

    // §6 — Status
    const statusRaw = get('status')
    const { recognized: statusRecognized, closed: statusClosed } = classifyIncidentStatus(statusRaw)
    if (!raw(statusRaw)) {
      findings.push(makeFinding({ field: 'Status', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Status is blank for Incident ID ${incId}.`, actual: '(blank)', expected: 'Open, In Progress, Resolved, or Closed',
        severity: 'Critical', recommendation: 'Populate the incident Status (Open, In Progress, Resolved, Closed).' }))
    } else if (!statusRecognized) {
      findings.push(makeFinding({ field: 'Status', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Invalid Status identified for Incident ID ${incId}.`, actual: raw(statusRaw), expected: 'Open, In Progress, Resolved, or Closed',
        severity: 'Major', recommendation: 'Use a recognized Status value (Open, In Progress, Resolved, Closed).' }))
    }

    // §8 — Description
    if (!isMeaningfulDescription(get('description'))) {
      findings.push(makeFinding({ field: 'Description', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Description is missing or not meaningful for Incident ID ${incId}.`, actual: raw(get('description')) || '(blank)', expected: 'Meaningful description',
        severity: 'Critical', recommendation: 'Document a meaningful description of the incident.' }))
    }

    // §5 — Dates
    const reportRaw = get('reportDateTime')
    const reportDT = parseDateTime(reportRaw)
    if (!raw(reportRaw)) {
      findings.push(makeFinding({ field: 'Report Date & Time', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Report Date & Time is missing for Incident ID ${incId}.`, actual: '(blank)', expected: 'Valid date/time',
        severity: 'Major', recommendation: 'Populate the Report Date & Time.' }))
    } else if (!reportDT) {
      findings.push(makeFinding({ field: 'Report Date & Time', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Invalid Report Date & Time identified for Incident ID ${incId}.`, actual: raw(reportRaw),
        severity: 'Major', recommendation: 'Correct the Report Date & Time to a valid, unambiguous date/time.' }))
    }

    // §7, §9-§13 — Issue Category, Impact, Urgency, Priority, Closed
    // Date/Time — dedicated validation layer (see validateIncidentRecord
    // and its five rule validators above). Reads actual uploaded row
    // values only — never dummy/hardcoded data.
    const categoryRaw = get('category')
    const impactRaw = get('impact')
    const urgencyRaw = get('urgency')
    const priorityRaw = get('priority')
    const closeCombinedRaw = get('closeDateTime')
    const closeDateRaw = closeDateColIdx !== -1 ? row[closeDateColIdx] : ''
    const closeTimeRaw = closeTimeColIdx !== -1 ? row[closeTimeColIdx] : ''

    const recordResult = validateIncidentRecord({
      incId, categoryRaw, impactRaw, urgencyRaw, priorityRaw,
      statusClosed, closeCombinedRaw, closeDateRaw, closeTimeRaw, hasSplitCloseFields,
      sheet, evidence, rowNum,
    })
    findings.push(...recordResult.findings)
    const { impactLevel, urgencyLevel, actualPriority, closeDT } = recordResult

    if (reportDT && closeDT && closeDT < reportDT) {
      findings.push(makeFinding({ field: 'Close Date & Time', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Close Date & Time is earlier than Report Date & Time for Incident ID ${incId}.`,
        actual: formatDateTime(closeDT), expected: `On/after ${formatDateTime(reportDT)}`,
        severity: 'Major', recommendation: 'Correct the Report/Close Date chronology.' }))
    }

    // §12/§13 — SLA calculation (actual-priority based; never invents timestamps)
    let resolutionBreach = 'Not Applicable'
    let responseBreach = 'Cannot Determine'
    if (actualPriority) {
      const sla = SLA_MATRIX[actualPriority]
      if (statusClosed) {
        if (reportDT && closeDT && closeDT >= reportDT) {
          const durationMin = (closeDT - reportDT) / 60000
          const breach = durationMin > sla.resolutionMin
          resolutionBreach = breach ? 'Breach' : 'No Breach'
          if (breach) {
            findings.push(makeFinding({ field: 'SLA Status', sheet, evidence, row: rowNum, incidentId: incId,
              finding: `Resolution Time SLA breached for Incident ID ${incId} (${actualPriority}): actual resolution time was ${formatMinutes(durationMin)}, exceeding the allowed ${sla.label.resolution} resolution SLA by ${formatMinutes(durationMin - sla.resolutionMin)}.`,
              actual: formatMinutes(durationMin), expected: sla.label.resolution,
              severity: actualPriority === 'P1' ? 'Critical' : actualPriority === 'P2' ? 'Major' : 'Minor',
              recommendation: 'Investigate the resolution delay and document justification, or expedite closure within SLA.', level: 'sla-rca',
              meta: { gapType: 'Resolution Time SLA Breach', incidentId: incId, priority: actualPriority, slaType: 'Resolution',
                reportDateTime: formatDateTime(reportDT), closeDateTime: formatDateTime(closeDT),
                allowedSLA: sla.label.resolution, actualTime: formatMinutes(durationMin), breachDuration: formatMinutes(durationMin - sla.resolutionMin) } }))
          }
        } else {
          resolutionBreach = 'Cannot Determine'
        }
      }
      // Response SLA: prefer a dedicated Response/First-Response timestamp
      // when the Incident Log provides one (true first-response elapsed
      // time); otherwise fall back to Response Time = Closed Date & Time -
      // Report Date & Time, since most real Incident Logs only capture
      // Reported and Closed timestamps and don't track first response
      // separately.
      let responseDT = null
      if (col.responseDateTime !== -1) {
        const responseRaw = get('responseDateTime')
        responseDT = parseDateTime(responseRaw)
        if (!responseDT && raw(responseRaw)) {
          findings.push(makeFinding({ field: 'Response Date & Time', sheet, evidence, row: rowNum, incidentId: incId,
            finding: `Invalid Response Date & Time identified for Incident ID ${incId} — Response SLA cannot be determined.`, actual: raw(responseRaw),
            severity: 'Minor', recommendation: 'Correct the Response Date & Time.', level: 'sla-rca' }))
        }
      }
      const usingCloseDTAsResponse = !responseDT && !!closeDT
      if (usingCloseDTAsResponse) responseDT = closeDT

      if (reportDT && responseDT) {
        const respMin = (responseDT - reportDT) / 60000
        const breach = respMin > sla.responseMin
        responseBreach = breach ? 'Breach' : 'No Breach'
        if (breach) {
          findings.push(makeFinding({ field: 'SLA Status', sheet, evidence, row: rowNum, incidentId: incId,
            finding: `Response Time SLA breached for Incident ID ${incId}: actual response time was ${formatMinutes(respMin)}, whereas the defined SLA for ${actualPriority} is ${sla.label.response}. SLA breached by ${formatMinutes(respMin - sla.responseMin)}. RCA is required for this SLA breach.`,
            actual: formatMinutes(respMin), expected: sla.label.response,
            severity: actualPriority === 'P1' ? 'Critical' : actualPriority === 'P2' ? 'Major' : 'Minor',
            recommendation: 'Perform and document an RCA for this SLA breach; investigate the response delay.', level: 'sla-rca',
            meta: { gapType: 'Response Time SLA Breach', incidentId: incId, priority: actualPriority, slaType: 'Response',
              reportDateTime: formatDateTime(reportDT), responseDateTime: formatDateTime(responseDT),
              responseTimeSource: usingCloseDTAsResponse ? 'Closed Date & Time' : 'Response Date & Time',
              allowedSLA: sla.label.response, actualTime: formatMinutes(respMin), breachDuration: formatMinutes(respMin - sla.responseMin), rcaRequired: true } }))
        }
      }
    }

    // §12 — SLA (text) field: required; when populated and an explicit
    // priority token is present, it must match the incident's actual Priority.
    const slaRaw = get('sla')
    if (col.sla !== -1) {
      if (!raw(slaRaw)) {
        findings.push(makeFinding({ field: 'SLA', sheet, evidence, row: rowNum, incidentId: incId,
          finding: `SLA is blank for Incident ID ${incId}.`, actual: '(blank)', expected: 'SLA value corresponding to Priority',
          severity: 'Minor', recommendation: "Populate the SLA value applicable to this incident's Priority." }))
      } else if (actualPriority) {
        const slaImpliedPriority = classifyPriorityLevel(slaRaw)
        if (slaImpliedPriority && slaImpliedPriority !== actualPriority) {
          findings.push(makeFinding({ field: 'SLA', sheet, evidence, row: rowNum, incidentId: incId,
            finding: `SLA value for Incident ID ${incId} references ${slaImpliedPriority}, which does not correspond to its actual Priority (${actualPriority}).`,
            actual: raw(slaRaw), expected: `SLA corresponding to ${actualPriority}`,
            severity: 'Minor', recommendation: 'Ensure the SLA value documented matches the SLA Matrix for the actual Priority.' }))
        }
      }
    }

    // §13 — SLA Status (text) field: required; when the SLA condition can be
    // objectively calculated, the sheet's own status must not contradict it.
    const slaStatusRaw = get('slaStatus')
    if (col.slaStatus !== -1) {
      if (!raw(slaStatusRaw)) {
        findings.push(makeFinding({ field: 'SLA Status', sheet, evidence, row: rowNum, incidentId: incId,
          finding: `SLA Status is blank for Incident ID ${incId}.`, actual: '(blank)', expected: 'SLA Status reflecting the calculated SLA condition',
          severity: 'Minor', recommendation: 'Populate the SLA Status.' }))
      } else {
        const determinate = (resolutionBreach === 'Breach' || resolutionBreach === 'No Breach') ? resolutionBreach
          : (responseBreach === 'Breach' || responseBreach === 'No Breach') ? responseBreach : null
        if (determinate) {
          const text = raw(slaStatusRaw).toLowerCase()
          const saysBreach = ['breach', 'missed', 'fail', 'not met', 'violated', 'exceeded'].some(k => text.includes(k))
          const saysNoBreach = ['met', 'compliant', 'within sla', 'no breach', 'achieved', 'on time'].some(k => text.includes(k))
          if (determinate === 'Breach' && saysNoBreach && !saysBreach) {
            findings.push(makeFinding({ field: 'SLA Status', sheet, evidence, row: rowNum, incidentId: incId,
              finding: `SLA Status for Incident ID ${incId} says "${raw(slaStatusRaw)}", but the calculated SLA condition is a Breach.`,
              actual: raw(slaStatusRaw), expected: 'Breach',
              severity: 'Major', recommendation: 'Correct the SLA Status to reflect the actual calculated SLA condition.', level: 'sla-rca' }))
          } else if (determinate === 'No Breach' && saysBreach && !saysNoBreach) {
            findings.push(makeFinding({ field: 'SLA Status', sheet, evidence, row: rowNum, incidentId: incId,
              finding: `SLA Status for Incident ID ${incId} says "${raw(slaStatusRaw)}", but the calculated SLA condition is No Breach.`,
              actual: raw(slaStatusRaw), expected: 'No Breach',
              severity: 'Major', recommendation: 'Correct the SLA Status to reflect the actual calculated SLA condition.', level: 'sla-rca' }))
          }
        }
      }
    }

    // Simple population checks — presence/population only, no invented
    // controlled vocabularies, for fields the spec does not define a value
    // rule for. (Client Remarks is deliberately excluded: the spec
    // explicitly warns against inventing a mandatory rule for it, so it
    // gets header-existence validation only, above.)
    const populationChecks = [
      ['recurrence', 'Recurrence'],
      ['severity', 'Severity'],
      ['ncStatus', 'Non-Conformity Status'],
      ['response', 'Response'],
      ['incidentType', 'Incident Type'],
      ['reportedBy', 'Reported By'],
    ]
    for (const [key, label] of populationChecks) {
      if (col[key] !== -1 && !raw(get(key))) {
        findings.push(makeFinding({ field: label, sheet, evidence, row: rowNum, incidentId: incId,
          finding: `${label} is missing or blank for Incident ID ${incId}.`, actual: '(blank)', expected: 'Populated value',
          severity: 'Minor', recommendation: `Populate ${label}.` }))
      }
    }

    // Escalate To — "required where escalation is applicable"; since no
    // independent escalation flag exists among the 26 fields, gated on the
    // P1/P2 tier that typically warrants escalation (same pattern already
    // used for MIR Report Issued below).
    if ((actualPriority === 'P1' || actualPriority === 'P2') && col.escalateTo !== -1 && !raw(get('escalateTo'))) {
      findings.push(makeFinding({ field: 'Escalate To', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Escalate To is missing for P1/P2 Incident ID ${incId}, which would typically require escalation.`, actual: '(blank)', expected: 'Escalation destination/person',
        severity: 'Minor', recommendation: 'Document the escalation destination/person for P1/P2 incidents.' }))
    }

    // Gated closure-related field checks (only meaningful once closed).
    if (statusClosed) {
      const closureFields = [
        ['closureCriteria', 'Closure Criteria'],
        ['finalResolution', 'Final Resolution'],
        ['closureApprovedBy', 'Closure Approved By'],
        ['cause', 'Cause'],
      ]
      for (const [key, label] of closureFields) {
        if (col[key] !== -1 && !raw(get(key))) {
          findings.push(makeFinding({ field: label, sheet, evidence, row: rowNum, incidentId: incId,
            finding: `${label} is missing for closed Incident ID ${incId}.`, actual: '(blank)', expected: 'Populated value',
            severity: 'Minor', recommendation: `Populate ${label} for closed incidents.` }))
        }
      }
      // Root Cause — meaningful, not just non-blank, once closed.
      if (col.rootCause !== -1 && !isMeaningfulValue(get('rootCause'))) {
        findings.push(makeFinding({ field: 'Root Cause', sheet, evidence, row: rowNum, incidentId: incId,
          finding: `Root Cause is missing or not meaningful for closed Incident ID ${incId}.`, actual: raw(get('rootCause')) || '(blank)', expected: 'Meaningful root cause description',
          severity: 'Minor', recommendation: 'Document a specific, meaningful Root Cause for closed incidents.' }))
      }
    }
    if (actualPriority === 'P1' && col.mirReportIssued !== -1 && !raw(get('mirReportIssued'))) {
      findings.push(makeFinding({ field: 'MIR Report Issued', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `MIR Report Issued is not documented for P1 Incident ID ${incId}.`, actual: '(blank)', expected: 'Documented Yes/No',
        severity: 'Minor', recommendation: 'Document whether a Major Incident Report (MIR) was issued for this P1 incident.' }))
    }
    if (col.owner !== -1 && !raw(get('owner'))) {
      findings.push(makeFinding({ field: 'Owner', sheet, evidence, row: rowNum, incidentId: incId,
        finding: `Owner is not assigned for Incident ID ${incId}.`, actual: '(blank)', expected: 'Assigned owner',
        severity: 'Minor', recommendation: 'Assign a responsible Owner to this incident.' }))
    }

    records.push({
      rowNum, id: idVal, status: raw(statusRaw), closed: statusClosed,
      category: raw(get('category')), priority: actualPriority, impact: impactLevel, urgency: urgencyLevel,
      reportDateTime: reportDT, closeDateTime: closeDT,
      resolutionBreach, responseBreach,
    })
  }

  // §4 — Duplicate IDs
  for (const [norm, rowNums] of seenIds.entries()) {
    if (rowNums.length > 1) {
      const original = records.find(rec => rec.id.toLowerCase() === norm)?.id || norm
      findings.push(makeFinding({ field: 'Incident ID', sheet, evidence, incidentId: original,
        finding: `Duplicate Incident ID "${original}" identified in the Incident Log (rows ${rowNums.join(', ')}).`,
        actual: `Appears ${rowNums.length} times (rows ${rowNums.join(', ')})`, expected: 'Unique Incident ID',
        severity: 'Critical', recommendation: 'Ensure every Incident ID is unique across the log.' }))
    }
  }

  const incidentIds = new Set(records.filter(r => r.id).map(r => r.id.toLowerCase()))
  const p1p2BreachedIds = new Set(
    records.filter(r => (r.priority === 'P1' || r.priority === 'P2') && (r.resolutionBreach === 'Breach' || r.responseBreach === 'Breach')).map(r => r.id).filter(Boolean)
  )
  // Any-priority SLA breach — RCA is mandatory whenever the Response or
  // Resolution SLA is breached, regardless of Priority tier (unlike
  // p1p2BreachedIds above, which is kept only for backward compatibility).
  const slaBreachedIds = new Set(
    records.filter(r => r.resolutionBreach === 'Breach' || r.responseBreach === 'Breach').map(r => r.id).filter(Boolean)
  )

  const critical = findings.filter(f => f.severity === 'Critical').length
  const major = findings.filter(f => f.severity === 'Major').length
  const minor = findings.filter(f => f.severity === 'Minor').length

  return {
    supported: true,
    fileName: src.file.name,
    sheetName,
    headerMapping,
    findings,
    records,
    incidentIds,
    p1p2BreachedIds,
    slaBreachedIds,
    checklist: {
      sheetExists: true,
      idPresent: !findings.some(f => f.field === 'Incident ID' && f.finding.includes('is blank')),
      idUnique: !findings.some(f => f.field === 'Incident ID' && f.finding.includes('Duplicate')),
      datesValid: !findings.some(f => (f.field === 'Report Date & Time' || f.field === 'Close Date & Time') && f.finding.includes('Invalid')),
      chronologyValid: !findings.some(f => f.finding.includes('earlier than Report Date')),
      statusValid: !findings.some(f => f.field === 'Status'),
      categoryPresent: !findings.some(f => f.field === 'Issue Category'),
      descriptionMeaningful: !findings.some(f => f.field === 'Description'),
      impactValid: !findings.some(f => f.field === 'Impact'),
      urgencyValid: !findings.some(f => f.field === 'Urgency'),
      priorityMatrixOk: !findings.some(f => f.finding.includes('Priority mismatch')),
      slaCalculated: records.some(r => r.resolutionBreach !== 'Not Applicable' && r.resolutionBreach !== 'Cannot Determine'),
    },
    summary: {
      total: records.length,
      p1: records.filter(r => r.priority === 'P1').length,
      p2: records.filter(r => r.priority === 'P2').length,
      p3: records.filter(r => r.priority === 'P3').length,
      p4: records.filter(r => r.priority === 'P4').length,
      slaBreaches: records.filter(r => r.resolutionBreach === 'Breach' || r.responseBreach === 'Breach').length,
      p1Breaches: records.filter(r => r.priority === 'P1' && (r.resolutionBreach === 'Breach' || r.responseBreach === 'Breach')).length,
      p2Breaches: records.filter(r => r.priority === 'P2' && (r.resolutionBreach === 'Breach' || r.responseBreach === 'Breach')).length,
      duplicates: [...seenIds.values()].filter(v => v.length > 1).length,
      critical, major, minor,
    },
  }
}
