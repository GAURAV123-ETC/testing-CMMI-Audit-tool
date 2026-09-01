// ─── Risk / Issue SLA Validation Engine ────────────────────────────────────
//
// Supplements the Risk Template Label Validation (IRO_FIELDS in App.jsx).
// Reads the actual data rows of the Risk Register / Issue Log (not just the
// header row), performs intelligent (semantic, format-insensitive) header
// mapping, and checks every closed record against its priority-based SLA
// window. Read-only — never modifies the source file.
//
// NOTE: levenshtein/singularize/headersAreEquivalent below are intentionally
// duplicated (not imported) from src/textMatch.js, which was extracted later
// for irpEngine.js. Left as private copies here to avoid any risk to this
// already-working engine — see textMatch.js for the shared versions.

import * as XLSX from 'xlsx'
import { normalizeHeader } from './validationEngine'

// ─── Intelligent Header Mapping ─────────────────────────────────────────────
//
// Each required field is matched against the sheet's first-row headers using
// semantic (meaning-based) matching rather than exact text comparison. A
// header counts as an Exact Match when it equals the field's canonical name
// (ignoring case/spacing/punctuation/underscores/hyphens); an Equivalent
// Match when it matches one of the field's known synonyms, or is close
// enough (substring, singular/plural, minor spelling variance) to one; or is
// reported as a Missing Header otherwise.

const FIELDS = [
  { key: 'id', label: 'Issue ID', canonical: 'issue id',
    synonyms: ['risk id', 'issue number', 'risk number', 'risk ref', 'reference id', 'ticket id', 'defect id', 'id'] },
  { key: 'priority', label: 'Priority', canonical: 'priority',
    synonyms: ['severity', 'criticality', 'risk level', 'priority level'] },
  { key: 'status', label: 'Status', canonical: 'status',
    synonyms: ['current status', 'issue status', 'risk status', 'resolution status'] },
  { key: 'dateRaised', label: 'Date Raised', canonical: 'date raised',
    synonyms: ['raised date', 'created date', 'opened date', 'logged date', 'issue date'] },
  { key: 'closedDate', label: 'Closed Date', canonical: 'closed date',
    synonyms: ['resolution date', 'date closed', 'closed on', 'completed date', 'resolved on'] },
  { key: 'reason', label: 'SLA Breach Reason', canonical: 'sla breach reason',
    synonyms: ['delay reason', 'reason', 'remarks', 'comments', 'justification', 'root cause'] },
]

// Only these block SLA calculation when missing (Issue ID / Breach Reason are
// informational and never block).
const MANDATORY_FIELD_KEYS = ['priority', 'status', 'dateRaised', 'closedDate']

function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[m][n]
}

// Strip a trailing plural 's' (but not 'ss') so "Remarks" ~ "Remark".
function singularize(s) {
  return s.length > 3 && s.endsWith('s') && !s.endsWith('ss') ? s.slice(0, -1) : s
}

// True if two normalized header strings mean the same thing: identical,
// singular/plural variants, one contains the other, or within a small edit
// distance (tolerates minor spelling mistakes without changing meaning).
function headersAreEquivalent(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (singularize(a) === singularize(b)) return true
  if (a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a))) return true
  const maxLen = Math.max(a.length, b.length)
  if (maxLen >= 4) {
    const threshold = maxLen <= 6 ? 1 : 2
    if (levenshtein(a, b) <= threshold) return true
  }
  return false
}

function matchField(normalizedHeaders, rawHeaders, field) {
  const canonical = normalizeHeader(field.canonical)

  // Exact Match: header equals the field's own canonical name.
  for (let i = 0; i < normalizedHeaders.length; i++) {
    const h = normalizedHeaders[i]
    if (!h) continue
    if (h === canonical || singularize(h) === singularize(canonical)) {
      return { columnIndex: i, matchedHeader: rawHeaders[i], matchType: 'Exact Match' }
    }
  }

  // Equivalent Match: header resembles the canonical name or a known synonym.
  const candidates = [canonical, ...field.synonyms.map(normalizeHeader)]
  for (let i = 0; i < normalizedHeaders.length; i++) {
    const h = normalizedHeaders[i]
    if (!h) continue
    if (candidates.some(c => headersAreEquivalent(h, c))) {
      return { columnIndex: i, matchedHeader: rawHeaders[i], matchType: 'Equivalent Match' }
    }
  }

  return { columnIndex: -1, matchedHeader: null, matchType: 'Missing Header' }
}

// Maps every required field against the sheet's raw header row. Returns the
// per-field mapping plus a PASS/FAIL summary gated on the mandatory fields.
function mapHeaders(rawHeaders) {
  const normalizedHeaders = rawHeaders.map(normalizeHeader)
  const mapping = FIELDS.map(field => {
    const { columnIndex, matchedHeader, matchType } = matchField(normalizedHeaders, rawHeaders, field)
    return { key: field.key, field: field.label, matchedHeader, matchType, columnIndex }
  })

  const mappedCount = mapping.filter(m => m.matchType !== 'Missing Header').length
  const missingMandatory = mapping.filter(m => MANDATORY_FIELD_KEYS.includes(m.key) && m.matchType === 'Missing Header')

  return {
    mapping,
    mappedCount,
    totalCount: FIELDS.length,
    status: missingMandatory.length === 0 ? 'PASS' : 'FAIL',
    missingMandatory: missingMandatory.map(m => m.field),
  }
}

// ─── SLA Rules ───────────────────────────────────────────────────────────────

const CLOSED_STATUS_KEYWORDS = ['closed', 'resolved', 'completed', 'done']
const OPEN_STATUS_KEYWORDS = ['open', 'in progress', 'pending', 'assigned', 'under review', 'new', 'reopen']

const PRIORITY_BUCKETS = {
  high: { keywords: ['high', 'critical', 'p1', 'urgent'], allowedDays: 1, label: '1 Day' },
  medium: { keywords: ['medium', 'med', 'moderate', 'p2'], allowedDays: 2, label: '2 Days' },
  low: { keywords: ['low', 'minor', 'p3'], allowedDays: 3, label: '3 Days' },
}

function classifyPriority(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  for (const [bucket, cfg] of Object.entries(PRIORITY_BUCKETS)) {
    if (cfg.keywords.some(k => v === k || v.includes(k))) return bucket
  }
  return null
}

function classifyStatus(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (CLOSED_STATUS_KEYWORDS.some(k => v.includes(k))) return 'closed'
  if (OPEN_STATUS_KEYWORDS.some(k => v.includes(k))) return 'open'
  return null
}

// Accepts a JS Date (from XLSX cellDates), an Excel serial number, or a
// string in common formats (DD-Mon-YYYY, YYYY-MM-DD, DD/MM/YYYY, etc.).
function parseDateValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw instanceof Date && !isNaN(raw)) return raw
  if (typeof raw === 'number') {
    const parsed = XLSX.SSF ? XLSX.SSF.parse_date_code(raw) : null
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0)
    return null
  }
  const str = String(raw).trim()
  if (!str) return null
  const direct = new Date(str)
  if (!isNaN(direct)) return direct
  const m = str.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,}|\d{1,2})[-\/\s](\d{2,4})/)
  if (m) {
    const day = parseInt(m[1], 10)
    const monthToken = m[2]
    const year = parseInt(m[3].length === 2 ? '20' + m[3] : m[3], 10)
    const month = isNaN(monthToken)
      ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
          .indexOf(monthToken.toLowerCase().slice(0, 3))
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

function formatDuration(days) {
  const rounded = Math.round(days * 10) / 10
  const whole = Number.isInteger(rounded)
  return `${whole ? rounded : rounded.toFixed(1)} Day${rounded === 1 ? '' : 's'}`
}

// Read every row of the sheet as an array of cells (not just the header row).
async function readAllRows(file) {
  const name = file.name || ''
  const ext = name.split('.').pop().toLowerCase()
  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array', cellDates: true })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
  }
  if (ext === 'csv') {
    const text = await file.text()
    return text
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
  }
  return null // Unsupported format for row-level SLA parsing (needs tabular data).
}

// Main entry point. Returns { supported, ... } — never throws.
export async function validateRiskSLA(file) {
  const rows = await readAllRows(file)
  if (!rows || rows.length < 2) {
    return {
      supported: false,
      fileName: file.name,
      templateStatus: 'Incomplete Template',
      reason: 'Could not read tabular rows from this file (upload as .xlsx or .csv for SLA validation).',
    }
  }

  const rawHeaders = rows[0].map(c => String(c ?? '').trim())
  const { mapping: headerMapping, mappedCount, totalCount, status: headerStatus, missingMandatory } = mapHeaders(rawHeaders)
  const headerValidation = { mappedCount, totalCount, status: headerStatus }

  const byKey = Object.fromEntries(headerMapping.map(m => [m.key, m]))

  if (headerStatus === 'FAIL') {
    return {
      supported: false,
      fileName: file.name,
      templateStatus: 'Incomplete Template',
      headerMapping,
      headerValidation,
      missingMandatory,
      reason: `Missing mandatory header(s): ${missingMandatory.join(', ')}. SLA calculation skipped to avoid generating incorrect results.`,
    }
  }

  const colIdx = {
    id: byKey.id.columnIndex,
    priority: byKey.priority.columnIndex,
    status: byKey.status.columnIndex,
    dateRaised: byKey.dateRaised.columnIndex,
    closedDate: byKey.closedDate.columnIndex,
    reason: byKey.reason.columnIndex,
  }

  let totalClosed = 0
  let slaCompliant = 0
  let slaBreached = 0
  let missingReasonCount = 0
  const findings = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every(c => String(c ?? '').trim() === '')) continue // blank row — ignore

    const statusRaw = row[colIdx.status]
    const status = classifyStatus(statusRaw)
    if (status !== 'closed') continue // only completed records are SLA-checked

    const priorityBucket = classifyPriority(row[colIdx.priority])
    const raisedDate = parseDateValue(row[colIdx.dateRaised])
    const closedDate = parseDateValue(row[colIdx.closedDate])

    if (!priorityBucket || !raisedDate || !closedDate) continue // incomplete record — ignore

    totalClosed += 1
    const durationDays = (closedDate - raisedDate) / 86400000
    const { allowedDays, label } = PRIORITY_BUCKETS[priorityBucket]
    const breach = durationDays > allowedDays

    if (breach) {
      slaBreached += 1
      const reasonRaw = colIdx.reason !== -1 ? String(row[colIdx.reason] ?? '').trim() : ''
      const reasonAvailable = !!reasonRaw
      if (!reasonAvailable) missingReasonCount += 1

      findings.push({
        issueId: colIdx.id !== -1 ? String(row[colIdx.id] ?? '').trim() || `Row ${r + 1}` : `Row ${r + 1}`,
        priority: priorityBucket.charAt(0).toUpperCase() + priorityBucket.slice(1),
        raisedDate: formatDate(raisedDate),
        closedDate: formatDate(closedDate),
        slaAllowed: label,
        actualDuration: formatDuration(durationDays),
        status: String(statusRaw ?? '').trim(),
        result: reasonAvailable ? 'SLA Breach' : 'SLA Breach — Missing Reason',
        reasonAvailable: reasonAvailable ? 'Yes' : 'No',
      })
    } else {
      slaCompliant += 1
    }
  }

  const observation = slaBreached === 0
    ? null
    : `Risk Register available. SLA validation detected ${slaBreached} breached issue${slaBreached === 1 ? '' : 's'}${missingReasonCount > 0 ? ` (${missingReasonCount} without documented breach reason)` : ''}.`

  return {
    supported: true,
    fileName: file.name,
    headerMapping,
    headerValidation,
    hasReasonColumn: colIdx.reason !== -1,
    totalClosed,
    slaCompliant,
    slaBreached,
    missingReasonCount,
    findings,
    observation,
  }
}
