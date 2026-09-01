// ─── IRP / IRO Lesson Learned Validation Engine ────────────────────────────
//
// Validates the Lesson Learned register belonging to the Incident Response
// Process (IRP) evidence set: locates the sheet/file by semantic name
// matching (never depends on an exact file/sheet name), maps its headers to
// the required logical fields, then performs row-level data-quality and
// traceability validation. Read-only — never modifies the source file.
//
// Scope note: traceability back to the Incident Log only checks that a
// referenced Incident ID exists in the log (and, where a Priority/Severity
// column can be identified, that P1/P2 incidents have a corresponding
// Lesson Learned record). Full Incident Log / RCA field validation is a
// separate concern and is not duplicated here.

import * as XLSX from 'xlsx'
import { normalizeText, matchFieldsExclusive, nameMatchesKeywords, textsAreEquivalent } from './textMatch'

// ─── Source Detection ───────────────────────────────────────────────────────

export const LESSON_LEARNED_NAME_KEYWORDS = [
  'lesson learned', 'lessons learned', 'lessons learnt', 'iro lesson learned',
  'incident lessons learned', 'incident learning', 'learning register',
  'lessons learned register', 'improvement & lessons learned',
  'improvement and lessons learned', 'iro learning', 'lesson learnt register',
]

const INCIDENT_LOG_NAME_KEYWORDS = [
  'incident log', 'incident register', 'incident tracker',
  'incident management log', 'irp log', 'incident log register',
]

const TABULAR_EXTS = ['xlsx', 'xls', 'csv']

function getExt(name) {
  return (name || '').split('.').pop().toLowerCase()
}

// Reads every row of a sheet (or a CSV file) as an array of cells.
async function readRows(file, sheetName) {
  const ext = getExt(file.name)
  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array', cellDates: true })
    const targetSheet = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0]
    const sheet = wb.Sheets[targetSheet]
    return { sheetName: targetSheet, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' }), workbookSheetNames: wb.SheetNames }
  }
  if (ext === 'csv') {
    const text = await file.text()
    const rows = text
      .split(/\r?\n/)
      .filter(l => l.trim().length > 0)
      .map(line => {
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
    return { sheetName: null, rows, workbookSheetNames: [] }
  }
  return { sheetName: null, rows: null, workbookSheetNames: [] }
}

// Locates the first file/sheet among `files` whose name (or, for workbooks,
// any sheet name) semantically matches `keywords`. Checked before falling
// back to an unsupported-format match so a real hit is preferred.
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

// ─── Required Logical Fields (spec §43) ─────────────────────────────────────

const LL_FIELDS = [
  { key: 'id', label: 'Lesson Learned ID', canonical: 'lesson learned id',
    synonyms: ['learning id', 'lesson id', 'll id', 'lessons learnt id'] },
  { key: 'area', label: 'Lesson Learned Area', canonical: 'lesson learned area',
    synonyms: ['learning area', 'improvement area', 'lesson category', 'learning category'] },
  { key: 'incidentId', label: 'IRO ID', canonical: 'iro id',
    synonyms: ['incident id', 'issue id', 'incident reference', 'reference incident id', 'related incident'] },
  { key: 'details', label: 'Lesson Learned Details', canonical: 'lesson learned details',
    synonyms: ['lessons learned', 'learning details', 'key learning', 'learning description', 'lesson description'] },
  { key: 'actionItem', label: 'Resulting Action Item', canonical: 'resulting action item',
    synonyms: ['action item', 'resulting action', 'improvement action', 'corrective improvement', 'follow up action', 'follow-up action'] },
  { key: 'dueDate', label: 'Action Item Due Date', canonical: 'action item due date',
    synonyms: ['due date', 'action due date', 'target date', 'action item target date'] },
  { key: 'owner', label: 'Action Item Owner', canonical: 'action item owner',
    synonyms: ['action owner', 'owner', 'responsible person', 'action responsible'] },
  { key: 'status', label: 'Action Item Status', canonical: 'action item status',
    synonyms: ['action status', 'status', 'improvement action status'] },
  { key: 'document', label: 'Relevant Document', canonical: 'relevant document',
    synonyms: ['reference document', 'supporting document', 'related document', 'evidence document', 'applicable document'] },
]

function mapHeaders(rawHeaders) {
  return matchFieldsExclusive(rawHeaders, LL_FIELDS)
}

// ─── Value Helpers ───────────────────────────────────────────────────────────

const PLACEHOLDER_VALUES = new Set(['na', 'n/a', 'none', 'not applicable', '*', '-', '.', 'nil', 'tbd'])

function raw(v) { return String(v ?? '').trim() }

// Blank or a bare meaningless placeholder (e.g. "NA"). A placeholder WITH a
// documented reason ("N/A - RCA not required, informational only") is not a
// bare match and is treated as meaningful.
function isMeaningful(v) {
  const s = raw(v)
  if (!s) return false
  return !PLACEHOLDER_VALUES.has(s.toLowerCase())
}

const NO_ACTION_PHRASES = ['no action required', 'no action needed', 'not applicable', 'no further action']
function isJustifiedNoAction(v) {
  const s = raw(v).toLowerCase()
  if (!s) return false
  if (PLACEHOLDER_VALUES.has(s)) return false // bare placeholder is NOT a justification
  return NO_ACTION_PHRASES.some(p => s.includes(p))
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

function parseDateValue(v) {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date && !isNaN(v)) return v
  if (typeof v === 'number') {
    const parsed = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null
    return parsed ? new Date(parsed.y, parsed.m - 1, parsed.d) : null
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

function fileNameMatches(refText, files) {
  const norm = normalizeText(refText).replace(/\.[a-z0-9]+$/, '')
  if (!norm) return false
  return files.some(f => {
    const fn = normalizeText(f.name).replace(/\.[a-z0-9]+$/, '')
    return fn.includes(norm) || norm.includes(fn) || textsAreEquivalent(fn, norm)
  })
}

// ─── Incident Log Traceability (best-effort — ID + Priority only) ──────────

async function loadIncidentLogIndex(files) {
  const src = await findNamedSource(files, INCIDENT_LOG_NAME_KEYWORDS)
  if (!src || !src.supported) return { available: false }

  const { rows } = await readRows(src.file, src.sheetName)
  if (!rows || rows.length < 2) return { available: false }

  const rawHeaders = rows[0].map(c => String(c ?? '').trim())
  const { id: idMatch, priority: priorityMatch } = matchFieldsExclusive(rawHeaders, [
    { key: 'id', canonical: 'incident id', synonyms: ['iro id', 'issue id', 'ticket id', 'id', 'incident reference'] },
    { key: 'priority', canonical: 'priority', synonyms: ['severity', 'priority level'] },
  ])
  if (idMatch.columnIndex === -1) return { available: false }

  const ids = new Set()
  const p1p2Ids = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every(c => raw(c) === '')) continue
    const id = raw(row[idMatch.columnIndex])
    if (!id) continue
    ids.add(id.toLowerCase())
    if (priorityMatch.columnIndex !== -1) {
      const p = raw(row[priorityMatch.columnIndex]).toLowerCase()
      const isP1P2 = p.includes('p1') || p.includes('p2') || p.includes('critical') || p.includes('high') || /sev(erity)?\s*[12]\b/.test(p)
      if (isP1P2) p1p2Ids.push(id)
    }
  }
  return { available: true, fileName: src.file.name, ids, p1p2Ids }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

let findingSeq = 0
function makeFinding({ field, sheet, evidence, finding, severity, recommendation, status = 'Open', llId = '' }) {
  findingSeq += 1
  return {
    id: `IRP-LL-${String(findingSeq).padStart(3, '0')}`,
    pa: 'IRP',
    evidence,
    sheet,
    field,
    llId,
    finding,
    severity,
    recommendation,
    status,
  }
}

// Returns { supported, findings, checklist, summary } — never throws.
export async function validateLessonLearned(files) {
  findingSeq = 0
  const src = await findNamedSource(files, LESSON_LEARNED_NAME_KEYWORDS)

  if (!src) {
    return {
      supported: false,
      findings: [makeFinding({
        field: 'Lesson Learned Sheet',
        sheet: 'N/A',
        evidence: 'IRP folder',
        finding: 'Required IRO/IRP Lesson Learned evidence is not available in the uploaded project repository.',
        severity: 'Critical',
        recommendation: 'Upload a Lesson Learned / Lessons Learned register documenting learnings and resulting improvement actions from incident RCA activities.',
      })],
      checklist: emptyChecklist(),
      summary: { totalRecords: 0, critical: 1, major: 0, minor: 0 },
    }
  }

  if (!src.supported) {
    return {
      supported: false,
      fileName: src.file.name,
      findings: [makeFinding({
        field: 'Lesson Learned Sheet',
        sheet: 'N/A',
        evidence: src.file.name,
        finding: `A Lesson Learned document ("${src.file.name}") was found but is not in a supported tabular format (.xlsx, .xls, .csv) for row-level validation.`,
        severity: 'Major',
        recommendation: 'Provide the Lesson Learned register as an Excel (.xlsx) or CSV file so field-level and traceability validation can be performed.',
      })],
      checklist: emptyChecklist(),
      summary: { totalRecords: 0, critical: 0, major: 1, minor: 0 },
    }
  }

  const { sheetName, rows } = await readRows(src.file, src.sheetName)
  if (!rows || rows.length < 2) {
    return {
      supported: false,
      fileName: src.file.name,
      sheetName,
      findings: [makeFinding({
        field: 'Lesson Learned Sheet',
        sheet: sheetName || src.file.name,
        evidence: src.file.name,
        finding: 'The Lesson Learned sheet was found but contains no data rows.',
        severity: 'Major',
        recommendation: 'Populate the Lesson Learned register with at least one record.',
      })],
      checklist: emptyChecklist(),
      summary: { totalRecords: 0, critical: 0, major: 1, minor: 0 },
    }
  }

  const rawHeaders = rows[0].map(c => String(c ?? '').trim())
  const headerMapping = mapHeaders(rawHeaders)
  const col = Object.fromEntries(Object.entries(headerMapping).map(([k, v]) => [k, v.columnIndex]))
  const incidentLog = await loadIncidentLogIndex(files)

  const findings = []
  const seenIds = new Map() // normalized id -> [rowNum,...]
  const records = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every(c => raw(c) === '')) continue
    const rowNum = r + 1

    const get = key => (col[key] !== -1 && col[key] !== undefined ? row[col[key]] : '')
    const idVal = raw(get('id'))
    const llId = idVal || `Row ${rowNum}`
    records.push({ rowNum, id: idVal })
    if (idVal) {
      const norm = idVal.toLowerCase()
      seenIds.set(norm, [...(seenIds.get(norm) || []), rowNum])
    }

    const evidence = src.file.name
    const sheet = sheetName || src.file.name

    // §44 — ID
    if (!idVal) {
      findings.push(makeFinding({ field: 'Lesson Learned ID', sheet, evidence, llId,
        finding: `Lesson Learned ID is blank for the record at Row ${rowNum}.`,
        severity: 'Major', recommendation: 'Assign a unique Lesson Learned ID to this record.' }))
    }

    // §45 — Area
    if (!isMeaningful(get('area'))) {
      findings.push(makeFinding({ field: 'Lesson Learned Area', sheet, evidence, llId,
        finding: `Lesson Learned Area is missing or blank for Lesson Learned ID ${llId}.`,
        severity: 'Minor', recommendation: 'Populate the Lesson Learned Area (e.g. Process, Technology, Application, Communication, Vendor).' }))
    }

    // §46 — IRO/Incident ID traceability
    const incidentIdVal = raw(get('incidentId'))
    if (!incidentIdVal) {
      findings.push(makeFinding({ field: 'IRO ID', sheet, evidence, llId,
        finding: `IRO/Incident ID reference is missing for Lesson Learned record ${llId}.`,
        severity: 'Major', recommendation: 'Reference the source Incident/IRO ID this lesson was derived from.' }))
    } else if (incidentLog.available && !incidentLog.ids.has(incidentIdVal.toLowerCase())) {
      findings.push(makeFinding({ field: 'IRO ID', sheet, evidence, llId,
        finding: `Lesson Learned record ${llId} references IRO/Incident ID "${incidentIdVal}", but the referenced incident cannot be found in the Incident Log.`,
        severity: 'Major', recommendation: 'Correct the IRO/Incident ID reference so it traces to an existing Incident Log record.' }))
    }

    // §47 — Details
    if (!isMeaningful(get('details'))) {
      findings.push(makeFinding({ field: 'Lesson Learned Details', sheet, evidence, llId,
        finding: `Lesson Learned Details are missing for Lesson Learned ID ${llId}.`,
        severity: 'Major', recommendation: 'Document what was learned from the incident/event in meaningful detail.' }))
    }

    // §48 — Resulting Action Item (with no-action justification exception)
    const actionRaw = get('actionItem')
    const actionMeaningful = isMeaningful(actionRaw)
    const actionApplicable = actionMeaningful && !isJustifiedNoAction(actionRaw)
    if (!actionMeaningful) {
      findings.push(makeFinding({ field: 'Resulting Action Item', sheet, evidence, llId,
        finding: `Resulting Action Item is missing for Lesson Learned ID ${llId}.`,
        severity: 'Major', recommendation: 'Document the resulting improvement action, or explicitly record that no action is applicable with a valid rationale.' }))
    }

    if (actionApplicable) {
      // §49 — Due Date
      const dueRaw = get('dueDate')
      if (!raw(dueRaw)) {
        findings.push(makeFinding({ field: 'Action Item Due Date', sheet, evidence, llId,
          finding: `Action Item Due Date is missing for Lesson Learned ID ${llId}.`,
          severity: 'Minor', recommendation: 'Define a target completion date for the resulting action item.' }))
      } else if (!parseDateValue(dueRaw)) {
        findings.push(makeFinding({ field: 'Action Item Due Date', sheet, evidence, llId,
          finding: `Invalid Action Item Due Date identified for Lesson Learned ID ${llId}.`,
          severity: 'Minor', recommendation: 'Correct the Action Item Due Date to a valid, unambiguous date.' }))
      }

      // §50 — Owner
      if (!isMeaningful(get('owner'))) {
        findings.push(makeFinding({ field: 'Action Item Owner', sheet, evidence, llId,
          finding: `Action Item Owner is not assigned for Lesson Learned ID ${llId}.`,
          severity: 'Minor', recommendation: 'Assign a responsible owner for the resulting action item.' }))
      }

      // §51 — Status
      const statusRaw = get('status')
      if (!raw(statusRaw)) {
        findings.push(makeFinding({ field: 'Action Item Status', sheet, evidence, llId,
          finding: `Action Item Status is missing for Lesson Learned ID ${llId}.`,
          severity: 'Major', recommendation: 'Populate the Action Item Status (e.g. Open, In Progress, Closed, Completed, Approved).' }))
      } else {
        const { recognized, closed } = classifyStatus(statusRaw)
        if (!recognized) {
          findings.push(makeFinding({ field: 'Action Item Status', sheet, evidence, llId,
            finding: `Invalid Action Item Status identified for Lesson Learned ID ${llId}. Value found: "${raw(statusRaw)}".`,
            severity: 'Major', recommendation: 'Use a recognized Action Item Status value (Open, In Progress, Closed, Completed, Approved).' }))
        } else if (closed) {
          // §52 — Closure evidence
          const docRaw = get('document')
          if (!isMeaningful(docRaw)) {
            findings.push(makeFinding({ field: 'Relevant Document', sheet, evidence, llId,
              finding: `Lesson Learned action ${llId} is marked as completed, but supporting closure/verification evidence is not available.`,
              severity: 'Major', recommendation: 'Attach the closure/verification evidence (Relevant Document reference) for this completed action item.' }))
          }
        }
      }

    }

    // §53 — Referenced document must exist in the uploaded repository
    const docRaw3 = get('document')
    if (isMeaningful(docRaw3) && !fileNameMatches(docRaw3, files)) {
      findings.push(makeFinding({ field: 'Relevant Document', sheet, evidence, llId,
        finding: `Referenced document "${raw(docRaw3)}" from Lesson Learned ${llId} could not be located in the uploaded repository.`,
        severity: 'Minor', recommendation: 'Upload the referenced supporting document, or correct the Relevant Document reference.' }))
    }
  }

  // §44 — Duplicate IDs
  for (const [norm, rowNums] of seenIds.entries()) {
    if (rowNums.length > 1) {
      const original = records.find(rec => rec.id.toLowerCase() === norm)?.id || norm
      findings.push(makeFinding({ field: 'Lesson Learned ID', sheet: sheetName || src.file.name, evidence: src.file.name, llId: original,
        finding: `Duplicate Lesson Learned ID "${original}" identified in the Lesson Learned register (rows ${rowNums.join(', ')}).`,
        severity: 'Major', recommendation: 'Ensure every Lesson Learned ID is unique across the register.' }))
    }
  }

  // §54 — P1/P2 incidents with no corresponding Lesson Learned record
  if (incidentLog.available && incidentLog.p1p2Ids && incidentLog.p1p2Ids.length) {
    const referencedIncidentIds = new Set()
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      if (!row) continue
      const v = raw(col.incidentId !== -1 ? row[col.incidentId] : '')
      if (v) referencedIncidentIds.add(v.toLowerCase())
    }
    for (const incId of incidentLog.p1p2Ids) {
      if (!referencedIncidentIds.has(incId.toLowerCase())) {
        findings.push(makeFinding({ field: 'Lesson Learned Coverage', sheet: sheetName || src.file.name, evidence: incidentLog.fileName, llId: '',
          finding: `Lesson Learned evidence is not available for the applicable incident record (Incident ID "${incId}", Priority P1/P2).`,
          severity: 'Major', recommendation: 'Document a Lesson Learned record for every P1/P2 incident.' }))
      }
    }
  }

  const critical = findings.filter(f => f.severity === 'Critical').length
  const major = findings.filter(f => f.severity === 'Major').length
  const minor = findings.filter(f => f.severity === 'Minor').length

  return {
    supported: true,
    fileName: src.file.name,
    sheetName,
    headerMapping,
    incidentLogAvailable: incidentLog.available,
    incidentLogFileName: incidentLog.fileName || null,
    totalRecords: records.length,
    findings,
    checklist: buildChecklist(findings),
    summary: { totalRecords: records.length, critical, major, minor },
  }
}

function emptyChecklist() {
  return Object.fromEntries(CHECKLIST_ITEMS.map(k => [k, false]))
}

const CHECKLIST_ITEMS = [
  'sheetExists', 'idPresent', 'idUnique', 'areaPresent', 'iroIdPresent', 'iroIdTraceable',
  'detailsPresent', 'actionItemPresent', 'dueDatePresent', 'ownerPresent',
  'statusPresentValid', 'relevantDocumentPresent', 'closureEvidenceOk',
]

function buildChecklist(findings) {
  const has = field => findings.some(f => f.field === field)
  return {
    sheetExists: true,
    idPresent: !findings.some(f => f.field === 'Lesson Learned ID' && f.finding.includes('is blank')),
    idUnique: !findings.some(f => f.field === 'Lesson Learned ID' && f.finding.includes('Duplicate')),
    areaPresent: !has('Lesson Learned Area'),
    iroIdPresent: !findings.some(f => f.field === 'IRO ID' && f.finding.includes('reference is missing')),
    iroIdTraceable: !findings.some(f => f.field === 'IRO ID' && f.finding.includes('cannot be found')),
    detailsPresent: !has('Lesson Learned Details'),
    actionItemPresent: !has('Resulting Action Item'),
    dueDatePresent: !has('Action Item Due Date'),
    ownerPresent: !has('Action Item Owner'),
    statusPresentValid: !has('Action Item Status'),
    relevantDocumentPresent: !findings.some(f => f.field === 'Relevant Document' && f.finding.includes('could not be located')),
    closureEvidenceOk: !findings.some(f => f.field === 'Relevant Document' && f.finding.includes('supporting closure')),
  }
}
