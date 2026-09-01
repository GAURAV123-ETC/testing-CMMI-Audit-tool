// ─── IRP Issue Log Availability & Header Validation Engine ─────────────────
//
// First-stage AVAILABILITY validation only (per spec — detailed data-level
// rules such as SLA/RCA/5-Why/priority/severity/closure validation are a
// separate, later stage and are NOT performed here). This module answers
// three questions:
//   1. Does an IRP Issue Log exist anywhere under the IRP folder, in any
//      supported format, identified by filename/sheet-name/keyword — never
//      by exact filename alone?
//   2. If more than one candidate exists, which is primary vs secondary,
//      without silently discarding any of them (spec §14)?
//   3. For the primary candidate, which of the 24 required header columns
//      are present (via semantic/synonym matching), and which are missing?
//
// Read-only — never modifies source files. Never throws: unreadable files
// are reported as READ ERROR (not MISSING), and non-tabular formats
// (PDF/DOC/DOCX) are reported as HEADER VALIDATION NOT POSSIBLE (not
// MISSING headers) — this app has no PDF/DOCX text-extraction library, so
// detection for those formats is filename/keyword-based only (see §15 in
// the spec, which explicitly designs for this fallback).
//
// NOTE: follows the same self-contained-module convention already used by
// incidentEngine.js / rcaEngine.js / irpEngine.js (own local file-reading +
// header matching) so this module can be added without touching them.

import * as XLSX from 'xlsx'
import { normalizeText, matchFieldsExclusive, nameMatchesKeywords } from './textMatch'

export const ISSUE_LOG_NAME_KEYWORDS = [
  'issue log', 'irp issue log', 'issue register', 'issues', 'issue_register',
  'problem log', 'problem register', 'irp issues', 'irp_issues',
]

const TABULAR_EXTS = ['xlsx', 'xls', 'csv']
const NON_TABULAR_EXTS = ['pdf', 'doc', 'docx']
function getExt(name) { return (name || '').split('.').pop().toLowerCase() }
function raw(v) { return String(v ?? '').trim() }

// ─── Required Logical Fields (spec §6-7) ────────────────────────────────────

export const ISSUE_LOG_FIELDS = [
  { key: 'issueId', label: 'Issue ID', canonical: 'issue id', synonyms: ['issue identifier', 'issue #', 'issue number', 'issue_id', 'incident id', 'incident identifier', 'incident #', 'incident number', 'incident_id'] },
  { key: 'issueStatus', label: 'Issue Status', canonical: 'issue status', synonyms: ['status', 'issue state'] },
  { key: 'issueCategory', label: 'Issue Category', canonical: 'issue category', synonyms: ['category', 'issue type'] },
  { key: 'issueDescription', label: 'Issue Description', canonical: 'issue description', synonyms: ['description', 'issue details'] },
  { key: 'priority', label: 'Priority', canonical: 'priority', synonyms: ['priority level'] },
  { key: 'issueOwner', label: 'Issue Owner', canonical: 'issue owner', synonyms: ['owner', 'assigned to', 'issue responsible'] },
  { key: 'recurrence', label: 'Recurrence', canonical: 'recurrence', synonyms: ['recurring', 'repeat occurrence', 'recurrence status'] },
  { key: 'impact', label: 'Impact', canonical: 'impact', synonyms: ['impact level', 'business impact'] },
  { key: 'severity', label: 'Severity', canonical: 'severity', synonyms: ['severity level'] },
  { key: 'urgency', label: 'Urgency', canonical: 'urgency', synonyms: ['urgency level', 'urgency status'] },
  { key: 'escalatedTo', label: 'Escalated To', canonical: 'escalated to', synonyms: ['escalation', 'escalate to', 'escalation contact'] },
  { key: 'causes', label: 'Causes', canonical: 'causes', synonyms: ['cause', 'cause of issue', 'contributing cause'] },
  { key: 'ncStatus', label: 'Non-Conformity Status', canonical: 'non conformity status', synonyms: ['nc status', 'non-conformity status'] },
  { key: 'response', label: 'Response', canonical: 'response', synonyms: ['response action', 'response details', 'response plan'] },
  { key: 'closureCriteria', label: 'Closure Criteria', canonical: 'closure criteria', synonyms: ['closure verification', 'closure conditions'] },
  { key: 'finalResolution', label: 'Final Resolution', canonical: 'final resolution', synonyms: ['resolution', 'final action', 'resolution details'] },
  { key: 'closedUpToDate', label: 'Closed Up To Date', canonical: 'closed up to date', synonyms: ['closure status', 'closed to date'] },
  { key: 'mirReportIssue', label: 'MIR Report Issue', canonical: 'mir report issue', synonyms: ['mir report', 'major incident report'] },
  { key: 'incidentType', label: 'Incident Type', canonical: 'incident type', synonyms: ['type of incident'] },
  { key: 'dateTimeReported', label: 'Date and Time Reported', canonical: 'date and time reported', synonyms: ['reported date', 'reported date time', 'date reported', 'reported on', 'reported date & time'] },
  { key: 'reportedBy', label: 'Reported By', canonical: 'reported by', synonyms: ['raised by', 'logged by'] },
  { key: 'rootCause', label: 'Root Cause', canonical: 'root cause', synonyms: ['root cause summary'] },
  { key: 'closedDateTime', label: 'Closed Date Time', canonical: 'closed date time', synonyms: ['closure date', 'closed date', 'date closed'] },
  { key: 'plannedRemark', label: 'Planned Remark', canonical: 'planned remark', synonyms: ['planned remarks', 'remark', 'planned action remark'] },
]

// ─── File Reading ────────────────────────────────────────────────────────────

async function readWorkbook(file) {
  const buf = await file.arrayBuffer()
  return XLSX.read(buf, { type: 'array', cellDates: true })
}

async function readHeaderRow(file, sheetName) {
  const ext = getExt(file.name)
  if (ext === 'xlsx' || ext === 'xls') {
    const wb = await readWorkbook(file)
    const targetSheet = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0]
    const sheet = wb.Sheets[targetSheet]
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
    if (!rows || rows.length === 0) return { sheetName: targetSheet, headerRow: [], empty: true }
    return { sheetName: targetSheet, headerRow: rows[0].map(c => String(c ?? '').trim()), empty: false }
  }
  if (ext === 'csv') {
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
    if (lines.length === 0) return { sheetName: null, headerRow: [], empty: true }
    const line = lines[0]
    const out = []
    let cur = '', inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') { inQuotes = !inQuotes; continue }
      if (c === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue }
      cur += c
    }
    out.push(cur.trim())
    return { sheetName: null, headerRow: out, empty: false }
  }
  return { sheetName: null, headerRow: [], unsupported: true }
}

// ─── Candidate Detection (spec §5, §14) ─────────────────────────────────────

function scoreCandidateName(name) {
  const n = normalizeText(name)
  if (n.includes('irp issue log') || n.includes('issue log')) return 100
  if (n.includes('issue register') || n.includes('issue_register')) return 90
  if (n.includes('irp issues') || n.includes('irp_issues')) return 85
  if (n.includes('problem register') || n.includes('problem log')) return 60
  if (n.includes('issues')) return 55
  return 0
}

// Scans every file under the IRP folder (any depth) for a name or, for
// workbooks, a sheet-name match — never relies on an exact filename.
// Returns every match found (not just the best one), scored and sorted so
// the strongest match is first without discarding the rest.
export async function findIssueLogCandidates(files) {
  const candidates = []
  for (const entry of files) {
    const ext = getExt(entry.name)
    const nameScore = scoreCandidateName(entry.name)
    let sheetMatch = null
    let readError = false

    if (ext === 'xlsx' || ext === 'xls') {
      try {
        const file = await entry.getFile()
        const wb = await readWorkbook(file)
        sheetMatch = wb.SheetNames.find(s => nameMatchesKeywords(s, ISSUE_LOG_NAME_KEYWORDS)) || null
      } catch (_) {
        readError = true
      }
    }

    const isSupportedFormat = TABULAR_EXTS.includes(ext) || NON_TABULAR_EXTS.includes(ext)
    const matchedByName = nameScore > 0 || nameMatchesKeywords(entry.name, ISSUE_LOG_NAME_KEYWORDS)
    if (!isSupportedFormat || (!matchedByName && !sheetMatch)) continue

    candidates.push({
      entry,
      fileName: entry.name,
      fileType: ext.toUpperCase(),
      path: entry.path.join('/') || '(root)',
      sheetName: sheetMatch,
      score: Math.max(nameScore, sheetMatch ? 80 : 0),
      matchSource: sheetMatch ? 'sheet name' : 'file name',
      readError,
      tabular: TABULAR_EXTS.includes(ext),
    })
  }
  // Highest score first; ties broken by more-recently-modified file (best
  // effort — File.lastModified is not always meaningful for uploads, but is
  // a reasonable, documented tiebreaker over arbitrary array order).
  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

// ─── Header Validation (spec §6-9) ──────────────────────────────────────────

function classifyHeaderStatus(fieldResults) {
  const missing = fieldResults.filter(f => f.status === 'MISSING').length
  if (missing === 0) return 'FULLY AVAILABLE'
  if (missing === fieldResults.length) return 'MISSING'
  return 'PARTIALLY AVAILABLE'
}

async function validateHeaders(candidate) {
  const ext = getExt(candidate.fileName)

  if (NON_TABULAR_EXTS.includes(ext)) {
    return {
      headerValidationPossible: false,
      headerStatus: 'HEADER VALIDATION NOT POSSIBLE',
      fieldResults: ISSUE_LOG_FIELDS.map(f => ({
        field: f.label, expected: f.label, detectedHeader: null, status: 'NOT CHECKED',
        remarks: 'No text-extraction capability for this file format (PDF/Word) — header validation not possible from filename/keyword detection alone.',
      })),
      missingColumns: [], sheetName: null,
    }
  }

  let file
  try {
    file = await candidate.entry.getFile()
  } catch (e) {
    return {
      headerValidationPossible: false, headerStatus: 'READ ERROR',
      fieldResults: ISSUE_LOG_FIELDS.map(f => ({ field: f.label, expected: f.label, detectedHeader: null, status: 'READ ERROR', remarks: `Could not read file: ${e.message}` })),
      missingColumns: [], sheetName: null,
    }
  }

  let headerInfo
  try {
    headerInfo = await readHeaderRow(file, candidate.sheetName)
  } catch (e) {
    return {
      headerValidationPossible: false, headerStatus: 'READ ERROR',
      fieldResults: ISSUE_LOG_FIELDS.map(f => ({ field: f.label, expected: f.label, detectedHeader: null, status: 'READ ERROR', remarks: `Could not parse file: ${e.message}` })),
      missingColumns: [], sheetName: null,
    }
  }

  if (headerInfo.empty) {
    return {
      headerValidationPossible: false, headerStatus: 'HEADER VALIDATION NOT POSSIBLE',
      fieldResults: ISSUE_LOG_FIELDS.map(f => ({ field: f.label, expected: f.label, detectedHeader: null, status: 'NOT CHECKED', remarks: 'Document has no rows — header row could not be located.' })),
      missingColumns: [], sheetName: headerInfo.sheetName,
    }
  }

  const mapping = matchFieldsExclusive(headerInfo.headerRow, ISSUE_LOG_FIELDS)
  const fieldResults = ISSUE_LOG_FIELDS.map(f => {
    const m = mapping[f.key]
    const found = m.columnIndex !== -1
    return {
      field: f.label, expected: f.label,
      detectedHeader: found ? m.matchedHeader : null,
      status: found ? 'AVAILABLE' : 'MISSING',
      remarks: found ? `${m.matchType} in header row` : 'No equivalent column found in the header row',
    }
  })
  const missingColumns = fieldResults.filter(f => f.status === 'MISSING').map(f => f.field)

  return {
    headerValidationPossible: true,
    headerStatus: classifyHeaderStatus(fieldResults),
    fieldResults, missingColumns, sheetName: headerInfo.sheetName,
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

// `files`: the file list (with .path/.getFile as produced by
// folderScanUtils) already scoped to the IRP Practice Area folder.
// `context`: optional { auditId, practiceArea, folderPath } for traceability
// stamping (spec §13) — this module itself is audit-context-agnostic.
// Never throws.
export async function checkIrpIssueLog(files, context = {}) {
  const validationTimestamp = new Date().toISOString()
  const traceability = { auditId: context.auditId ?? null, practiceArea: context.practiceArea ?? 'IRP', folderPath: context.folderPath ?? null, validationTimestamp }

  if (!files || files.length === 0) {
    return {
      documentStatus: 'NO DOCUMENT FOUND',
      candidates: [], primary: null,
      headerValidationPossible: false, headerStatus: 'NOT CHECKED',
      fieldResults: [], missingColumns: [],
      ...traceability,
    }
  }

  const candidates = await findIssueLogCandidates(files)
  if (candidates.length === 0) {
    return {
      documentStatus: 'MISSING',
      candidates: [], primary: null,
      headerValidationPossible: false, headerStatus: 'NOT CHECKED',
      fieldResults: [], missingColumns: [],
      ...traceability,
    }
  }

  const primary = candidates[0]
  const candidateSummaries = candidates.map((c, i) => ({
    fileName: c.fileName, fileType: c.fileType, path: c.path, sheetName: c.sheetName,
    matchSource: c.matchSource, readError: c.readError,
    role: i === 0 ? 'PRIMARY CANDIDATE' : 'SECONDARY/OLD CANDIDATE',
  }))

  if (primary.readError) {
    return {
      documentStatus: 'AVAILABLE',
      candidates: candidateSummaries, primary: candidateSummaries[0],
      headerValidationPossible: false, headerStatus: 'READ ERROR',
      fieldResults: ISSUE_LOG_FIELDS.map(f => ({ field: f.label, expected: f.label, detectedHeader: null, status: 'READ ERROR', remarks: 'The primary Issue Log candidate could not be opened/read.' })),
      missingColumns: [],
      ...traceability,
    }
  }

  const headerResult = await validateHeaders(primary)

  return {
    documentStatus: 'AVAILABLE',
    fileName: primary.fileName, fileType: primary.fileType, filePath: primary.path,
    candidates: candidateSummaries, primary: candidateSummaries[0],
    ...headerResult,
    ...traceability,
  }
}
