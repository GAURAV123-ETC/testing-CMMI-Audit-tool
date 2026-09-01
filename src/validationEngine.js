// ─── Config-Driven Practice Area Validation Engine ─────────────────────────
//
// This module contains NO practice-area-specific logic. Everything it does
// is driven entirely by the PA_CHECKLISTS config (see checklists.js). Adding
// a new Practice Area never requires touching this file.

import * as XLSX from 'xlsx'
import { PA_CHECKLISTS } from './checklists'

const BINARY_EXTS = ['xlsx', 'xls', 'pdf', 'docx', 'doc', 'pptx', 'ppt']

export function getFileExt(name) {
  return name.split('.').pop().toLowerCase()
}

// Boundary-safe folder/code matcher (e.g. "CAR", "CAR_Folder" match "CAR";
// "Cargo" does not).
function matchesCode(name, code) {
  const upper = (name || '').toUpperCase().replace(/[_\-\s.]/g, '')
  return (
    upper === code ||
    upper.startsWith(code + '(') ||
    (upper.length > code.length && upper.startsWith(code) && !/[A-Z]/.test(upper[code.length]))
  )
}

// Identify which configured Practice Area a folder name belongs to.
export function classifyFolderToPA(folderName) {
  if (!folderName) return null
  for (const code of Object.keys(PA_CHECKLISTS)) {
    if (matchesCode(folderName, code)) return code
  }
  const lower = folderName.toLowerCase()
  for (const code of Object.keys(PA_CHECKLISTS)) {
    const kws = PA_CHECKLISTS[code].folderKeywords || []
    if (kws.some(k => lower.includes(k))) return code
  }
  return null
}

// Locate the one required document for a Practice Area among a set of files.
export function findRequiredDocumentFile(paCode, files) {
  const cfg = PA_CHECKLISTS[paCode]
  if (!cfg) return null
  const keywords = cfg.requiredDocument.keywords
  for (const f of files) {
    const lower = f.name.toLowerCase()
    if (keywords.some(k => lower.includes(k))) return f
  }
  return null
}

// Normalize a header string for fuzzy, case/whitespace/format-insensitive
// comparison: strips parenthetical guidance, punctuation, extra spaces.
export function normalizeHeader(h) {
  if (!h) return ''
  return String(h)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-zA-Z0-9&/ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function headerMatches(normalizedActualHeaders, headerCfg) {
  const candidates = [headerCfg.name, ...(headerCfg.synonyms || [])].map(normalizeHeader)
  return normalizedActualHeaders.some(actual =>
    candidates.some(c => actual === c || (actual.length > 2 && c.length > 2 && (actual.includes(c) || c.includes(actual))))
  )
}

function parseCsvLine(line) {
  const out = []
  let cur = '', inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { inQuotes = !inQuotes; continue }
    if (c === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  out.push(cur.trim())
  return out.filter(Boolean)
}

// Read ONLY the first row (header row) of a document — never scans data rows.
export async function readFirstRowHeaders(file) {
  const ext = getFileExt(file.name)
  try {
    if (ext === 'xlsx' || ext === 'xls') {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
      const first = (rows[0] || []).map(c => String(c ?? '').trim()).filter(Boolean)
      return { headers: first, warning: null }
    }
    if (ext === 'csv') {
      const text = await file.text()
      const firstLine = text.split(/\r?\n/).find(l => l.trim().length > 0) || ''
      return { headers: parseCsvLine(firstLine), warning: null }
    }
    // Best-effort fallback for formats without a real parser (docx/pdf/txt/etc).
    const raw = await file.text()
    const clean = raw.replace(/[^\x20-\x7E\n\r\t]/g, ' ')
    const firstLine = clean.split(/\r?\n/).find(l => l.trim().length > 0) || ''
    const cells = firstLine.split(/\t|,|\s{2,}|\|/).map(s => s.trim()).filter(Boolean)
    return {
      headers: cells,
      warning: `"${file.name}" is a .${ext} file — header extraction is best-effort. For reliable validation, upload the document as .xlsx or .csv.`,
    }
  } catch (e) {
    return { headers: [], warning: `Could not read "${file.name}": ${e.message}` }
  }
}

function defaultRecommendation(paCode, fieldName, cfg) {
  return `Add a "${fieldName}" column to the ${cfg.requiredDocument.label}. This field is part of the mandatory CMMI ${paCode} (${cfg.name}) checklist and is required as auditable evidence during a CMMI appraisal; its absence will be flagged as a gap by the appraisal team.`
}

// Structured (why / corrective action / expected evidence) form of a
// recommendation, used by the Audit Findings / Non-Conformity views. Reads
// `recommendationDetails` from the checklist config when present; otherwise
// synthesizes a generic-but-correct answer so any future Practice Area works
// without needing hand-written detail entries.
export function getRecommendationDetail(paCode, fieldName) {
  const cfg = PA_CHECKLISTS[paCode]
  if (!cfg) return null
  const detail = cfg.recommendationDetails && cfg.recommendationDetails[fieldName]
  if (detail) return detail
  return {
    why: `This field is part of the mandatory CMMI ${paCode} (${cfg.name}) checklist and is required as auditable evidence during a CMMI appraisal.`,
    correctiveAction: `Add a "${fieldName}" column to the ${cfg.requiredDocument.label} and populate it for every record.`,
    expectedEvidence: `${cfg.requiredDocument.label} header row containing a populated "${fieldName}" column.`,
  }
}

function computeOverallStatus(compliancePct) {
  if (compliancePct === 100) return 'Compliant'
  if (compliancePct >= 80) return 'Partially Compliant'
  return 'Non-Compliant'
}

// Validate a single Practice Area independently. Never mixes checklist
// logic across Practice Areas — each call is fully self-contained.
export async function validatePracticeArea(paCode, files) {
  const cfg = PA_CHECKLISTS[paCode]
  if (!cfg) throw new Error(`No checklist configured for Practice Area "${paCode}"`)

  const base = {
    paCode,
    paName: cfg.name,
    documentLabel: cfg.requiredDocument.label,
    totalRequired: cfg.headers.length,
    criticalTotal: cfg.headers.filter(h => h.severity === 'critical').length,
    majorTotal: cfg.headers.filter(h => h.severity === 'major').length,
    minorTotal: cfg.headers.filter(h => h.severity === 'minor').length,
    timestamp: new Date().toISOString(),
  }

  const docFile = findRequiredDocumentFile(paCode, files)

  if (!docFile) {
    // Document missing — do not continue field validation.
    const headers = cfg.headers.map(h => ({ name: h.name, severity: h.severity, expected: 'Yes', found: 'No', status: 'FAIL' }))
    return {
      ...base,
      documentFound: false,
      fileName: null,
      headers,
      foundCount: 0,
      missingCount: cfg.headers.length,
      criticalCount: base.criticalTotal,
      majorCount: base.majorTotal,
      minorCount: base.minorTotal,
      compliancePct: 0,
      overallStatus: 'Non-Compliant',
      recommendations: cfg.headers.map(h => ({
        field: h.name,
        severity: h.severity,
        text: cfg.recommendations[h.name] || defaultRecommendation(paCode, h.name, cfg),
      })),
      parseWarning: null,
    }
  }

  const { headers: rawHeaders, warning } = await readFirstRowHeaders(docFile)
  const normalizedActual = rawHeaders.map(normalizeHeader).filter(Boolean)

  const headerResults = cfg.headers.map(h => {
    const found = headerMatches(normalizedActual, h)
    return { name: h.name, severity: h.severity, expected: 'Yes', found: found ? 'Yes' : 'No', status: found ? 'PASS' : 'FAIL' }
  })

  const missing = headerResults.filter(h => h.status === 'FAIL')
  const foundCount = headerResults.length - missing.length
  const compliancePct = Math.round((foundCount / headerResults.length) * 100)

  return {
    ...base,
    documentFound: true,
    fileName: docFile.name,
    headers: headerResults,
    foundCount,
    missingCount: missing.length,
    criticalCount: missing.filter(h => h.severity === 'critical').length,
    majorCount: missing.filter(h => h.severity === 'major').length,
    minorCount: missing.filter(h => h.severity === 'minor').length,
    compliancePct,
    overallStatus: computeOverallStatus(compliancePct),
    recommendations: missing.map(h => ({
      field: h.name,
      severity: h.severity,
      text: cfg.recommendations[h.name] || defaultRecommendation(paCode, h.name, cfg),
    })),
    parseWarning: warning,
  }
}

// Given a top-level upload (a folder, or a folder-of-folders), bucket files
// by which Practice Area they belong to. Each PA is validated independently.
export function bucketFilesByPA(topFolderName, entries) {
  // entries: [{ file, subfolder }]  (subfolder === '' means file sits at the
  // root of the uploaded folder)
  const rootFiles = entries.filter(e => !e.subfolder).map(e => e.file)
  const bySubfolder = {}
  entries.filter(e => e.subfolder).forEach(e => {
    bySubfolder[e.subfolder] = bySubfolder[e.subfolder] || []
    bySubfolder[e.subfolder].push(e.file)
  })

  const buckets = []
  const topPA = classifyFolderToPA(topFolderName)
  if (topPA) buckets.push({ paCode: topPA, files: rootFiles.length ? rootFiles : entries.map(e => e.file) })

  Object.entries(bySubfolder).forEach(([subfolder, files]) => {
    const pa = classifyFolderToPA(subfolder)
    if (pa) buckets.push({ paCode: pa, files })
  })

  if (buckets.length === 0) {
    // Fallback: no folder name matched a known PA — try to identify the PA
    // directly from a recognisable required-document filename.
    const allFiles = entries.map(e => e.file)
    for (const code of Object.keys(PA_CHECKLISTS)) {
      if (findRequiredDocumentFile(code, allFiles)) {
        buckets.push({ paCode: code, files: allFiles })
        break
      }
    }
  }

  return buckets
}

export function isBinaryExt(name) {
  return BINARY_EXTS.includes(getFileExt(name))
}
