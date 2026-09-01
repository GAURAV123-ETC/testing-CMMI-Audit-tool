// ─── IRP Incident Log — Data-Row Validation Engine ─────────────────────────
//
// This is the "later stage" that irpIssueLogEngine.js's own comment
// explicitly reserves for "detailed data-level rules" (row-level content,
// as opposed to that module's header-row-only AVAILABILITY check). It never
// duplicates irpIssueLogEngine.js's candidate-detection or field config —
// it imports and reuses findIssueLogCandidates()/ISSUE_LOG_FIELDS directly,
// so "which file is the Issue Log" and "which required fields exist" always
// come from the exact same single source of truth as the Stage-1 panel.
//
// Two real, data-driven rules, run against the actual data rows (not just
// the header row):
//
//   Rule 1 — Closure Date must be >= Report Date (compared as full date+time
//     values, not just calendar date).
//   Rule 2 — Incident ID must be unique across the Incident Log.
//
// Read-only, never throws — mirrors irpIssueLogEngine.js's error-handling
// conventions (unreadable/unsupported files are reported via `supported:
// false` + a reason, never silently treated as "no gap").

import * as XLSX from 'xlsx'
import { findIssueLogCandidates, ISSUE_LOG_FIELDS } from './irpIssueLogEngine'
import { matchFieldsExclusive } from './textMatch'

const TABULAR_EXTS = ['xlsx', 'xls', 'csv']
function getExt(name) { return (name || '').split('.').pop().toLowerCase() }
function raw(v) { return String(v ?? '').trim() }

async function readAllRows(file) {
  const ext = getExt(file.name)
  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array', cellDates: true })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
  }
  if (ext === 'csv') {
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
    return lines.map(line => {
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
  }
  return null
}

// Best-effort date+time parser — real Date objects come through as-is
// (XLSX cellDates:true already converts genuine Excel date cells); string
// cells (CSV, or text-formatted Excel columns) fall back to native Date
// parsing. Returns null (never a default/guessed date) when unparseable —
// callers must NOT treat null as "valid"/"no gap".
function parseDateTime(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value
  const s = raw(value)
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

export function formatDateTime(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return 'N/A'
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()} ${h}:${mm} ${ampm}`
}

// `files`: the file list (with .path/.getFile as produced by
// folderScanUtils) already scoped to the IRP Practice Area folder — the
// exact same input irpIssueLogEngine.checkIrpIssueLog() receives, so both
// stages always agree on which folder they're looking at.
export async function validateIrpIncidentLogData(files) {
  if (!files || files.length === 0) return { supported: false, reason: 'No files found under the IRP Practice Area folder.' }

  const candidates = await findIssueLogCandidates(files)
  if (candidates.length === 0) return { supported: false, reason: 'No IRP Issue Log candidate was found.' }

  const primary = candidates[0]
  if (primary.readError) return { supported: false, reason: `The primary Issue Log candidate ("${primary.fileName}") could not be read.` }
  if (!TABULAR_EXTS.includes(getExt(primary.fileName))) {
    return { supported: false, reason: `"${primary.fileName}" is not a tabular format (.xlsx/.xls/.csv) — data-row validation (Report Date vs Closure Date, duplicate Incident ID) is not possible for this file type.` }
  }

  let file
  try {
    file = await primary.entry.getFile()
  } catch (e) {
    return { supported: false, reason: `Could not read "${primary.fileName}": ${e.message}` }
  }

  let rows
  try {
    rows = await readAllRows(file)
  } catch (e) {
    return { supported: false, reason: `Could not parse "${primary.fileName}": ${e.message}` }
  }
  if (!rows || rows.length === 0) return { supported: false, reason: `"${primary.fileName}" has no rows.` }

  const headerRow = rows[0].map(c => raw(c))
  const dataRows = rows.slice(1)
  const mapping = matchFieldsExclusive(headerRow, ISSUE_LOG_FIELDS)
  const idCol = mapping.issueId.columnIndex
  const reportCol = mapping.dateTimeReported.columnIndex
  const closureCol = mapping.closedDateTime.columnIndex

  if (idCol === -1) {
    return { supported: false, reason: 'No Incident ID / Issue ID column was found in the Incident Log header row — duplicate-ID and date-order validation could not be performed.', fileName: primary.fileName }
  }

  const idOccurrences = new Map() // id -> count
  const dateOrderViolations = []
  const invalidDateIds = []

  dataRows.forEach(row => {
    const id = raw(row[idCol])
    if (!id) return // fully blank row — nothing to validate
    idOccurrences.set(id, (idOccurrences.get(id) || 0) + 1)

    if (reportCol !== -1 && closureCol !== -1) {
      const reportRaw = row[reportCol]
      const closureRaw = row[closureCol]
      const reportHas = raw(reportRaw) !== '' || reportRaw instanceof Date
      const closureHas = raw(closureRaw) !== '' || closureRaw instanceof Date
      if (reportHas && closureHas) {
        const reportDt = parseDateTime(reportRaw)
        const closureDt = parseDateTime(closureRaw)
        if (reportDt && closureDt) {
          if (closureDt.getTime() < reportDt.getTime()) {
            dateOrderViolations.push({ id, reportDt, closureDt })
          }
        } else {
          // Present but unparseable — do NOT silently treat as valid.
          invalidDateIds.push(id)
        }
      }
      // Both blank: nothing to compare, not flagged either way.
    }
  })

  const duplicateIds = [...idOccurrences.entries()].filter(([, count]) => count > 1).map(([id]) => id)

  return {
    supported: true,
    fileName: primary.fileName,
    idColumnFound: true,
    dateColumnsFound: reportCol !== -1 && closureCol !== -1,
    totalDataRows: dataRows.length,
    dateOrderViolations,
    duplicateIds,
    invalidDateIds,
  }
}
