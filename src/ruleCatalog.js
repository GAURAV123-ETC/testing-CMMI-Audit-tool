// Versioned, browser-side normalisation of the CMMI master workbook.
// The workbook remains an import source; scan code consumes this stable shape
// rather than hard-coding sheet positions or column indexes.
import * as XLSX from 'xlsx'

const PA_ALIASES = {
  VER: 'VV', VAL: 'VV', MC: 'MPM', SAM: 'SUP', SSS: 'SUP', PPL: 'OT',
}

const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const text = value => String(value || '').replace(/\s+/g, ' ').trim()
const unique = values => [...new Set(values.filter(Boolean))]

function words(value) {
  return unique(String(value || '')
    .split(/[;,\n]/)
    .map(item => text(item))
    .filter(item => item.length > 1))
}

function documentKey(name) {
  return norm(String(name || '').replace(/^\s*\d+\s*[.)-]?\s*/, '').replace(/\/+\s*$/, ''))
}

function findHeaderRow(rows, requiredHeader) {
  return rows.findIndex(row => row.some(cell => norm(cell) === norm(requiredHeader)))
}

function columnIndex(header, name) {
  const index = header.findIndex(cell => norm(cell) === norm(name))
  return index < 0 ? undefined : index
}

function parsePracticeAreas(value, knownCodes) {
  const raw = String(value || '').toUpperCase()
  const direct = raw.match(/\b[A-Z]{2,5}\b/g) || []
  const mapped = direct.map(code => PA_ALIASES[code] || code).filter(code => knownCodes.has(code))
  return unique(mapped)
}

function domainFromRow(row) {
  const joined = row.map(text).join(' ')
  const match = joined.match(/\(([A-Z]{2,5})\)/)
  return match ? match[1] : ''
}

function parseRules(sheet, issues) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false })
  const headerAt = findHeaderRow(rows, 'Rule ID')
  if (headerAt < 0) {
    issues.errors.push('MASTER sheet is missing the Rule ID header.')
    return []
  }
  const header = rows[headerAt]
  const levelAt = columnIndex(header, 'Level')
  const ruleAt = columnIndex(header, 'Rule ID')
  const checkAt = columnIndex(header, 'Audit Check (What the auditor looks for and verifies)')
  const gapAt = columnIndex(header, 'If NO: Finding and Implication')
  if ([levelAt, ruleAt, checkAt, gapAt].some(index => index === undefined)) {
    issues.errors.push('MASTER sheet is missing one or more required rule columns.')
    return []
  }

  const rules = []
  const ruleIds = new Set()
  let domain = ''
  for (const row of rows.slice(headerAt + 1)) {
    const candidateDomain = domainFromRow(row)
    if (candidateDomain) domain = candidateDomain
    const ruleId = text(row[ruleAt])
    if (!/^[A-Z0-9]+-[A-Z0-9]+/i.test(ruleId)) continue
    if (ruleIds.has(ruleId)) {
      issues.errors.push(`Duplicate Rule ID in MASTER: ${ruleId}.`)
      continue
    }
    ruleIds.add(ruleId)
    const level = text(row[levelAt])
    rules.push({
      ruleId,
      domain,
      practiceArea: ruleId.split('-')[0].toUpperCase(),
      level,
      isGate: /^L1-Gate$/i.test(level),
      isBlock: /^L2-Block$/i.test(level),
      isCheck: /^L3-Check$/i.test(level),
      isProbe: /^L4-Probe$/i.test(level),
      auditCheck: text(row[checkAt]),
      gapText: text(row[gapAt]),
    })
  }
  if (!rules.length) issues.errors.push('MASTER sheet contains no valid audit rules.')
  return rules
}

function addDocument(documents, source, knownCodes) {
  const name = text(source.documentType)
  const key = documentKey(name)
  if (!key) return
  const current = documents.get(key) || {
    id: key,
    documentType: name.replace(/\/+\s*$/, ''),
    aliases: [],
    practiceAreas: [],
    keywords: [],
    expectedEvidence: '',
    primaryPurpose: '',
    sources: [],
  }
  current.aliases = unique([...current.aliases, name, ...name.split('/').map(text)])
  current.practiceAreas = unique([...current.practiceAreas, ...parsePracticeAreas(source.practiceAreas, knownCodes)])
  current.keywords = unique([...current.keywords, ...words(source.keywords)])
  current.expectedEvidence = current.expectedEvidence || text(source.expectedEvidence)
  current.primaryPurpose = current.primaryPurpose || text(source.primaryPurpose)
  current.sources = unique([...current.sources, source.source])
  documents.set(key, current)
}

function parseEvidenceCatalog(workbook, knownCodes, issues) {
  const documents = new Map()
  const sheet2 = workbook.Sheets.Sheet2
  if (sheet2) {
    const rows = XLSX.utils.sheet_to_json(sheet2, { header: 1, defval: '', blankrows: false })
    const headerAt = findHeaderRow(rows, 'Related Document Name')
    if (headerAt < 0) issues.warnings.push('Sheet2 was ignored because its document dictionary header was not found.')
    else {
      const header = rows[headerAt]
      const docAt = columnIndex(header, 'Related Document Name')
      const paAt = columnIndex(header, 'Practice Area Name')
      const keywordAt = columnIndex(header, 'Main Keywords')
      const evidenceAt = columnIndex(header, 'Example Evidence / Example Document')
      for (const row of rows.slice(headerAt + 1)) {
        addDocument(documents, { documentType: row[docAt], practiceAreas: row[paAt], keywords: row[keywordAt], expectedEvidence: row[evidenceAt], source: 'Sheet2' }, knownCodes)
      }
    }
  } else issues.warnings.push('Sheet2 was not found; the document-identification dictionary was not imported.')

  const sheet5 = workbook.Sheets.Sheet5
  if (sheet5) {
    const rows = XLSX.utils.sheet_to_json(sheet5, { header: 1, defval: '', blankrows: false })
    const headerAt = findHeaderRow(rows, 'Document / Evidence')
    if (headerAt < 0) issues.warnings.push('Sheet5 was ignored because its expected-evidence header was not found.')
    else {
      const header = rows[headerAt]
      const docAt = columnIndex(header, 'Document / Evidence')
      const paAt = columnIndex(header, 'Related Practice Area')
      const checkAt = columnIndex(header, 'What to Check / Key Points')
      const evidenceAt = header.findIndex((cell, index) => norm(cell) === norm('Expected Evidence') && index > checkAt)
      for (const row of rows.slice(headerAt + 1)) {
        addDocument(documents, { documentType: row[docAt], practiceAreas: row[paAt], keywords: row[checkAt], expectedEvidence: row[evidenceAt], source: 'Sheet5' }, knownCodes)
      }
    }
  } else issues.warnings.push('Sheet5 was not found; the expected-evidence catalogue was not imported.')

  const sheet6 = workbook.Sheets.Sheet6
  if (sheet6) {
    const rows = XLSX.utils.sheet_to_json(sheet6, { header: 1, defval: '', blankrows: false })
    const headerAt = findHeaderRow(rows, 'Document / Evidence')
    if (headerAt >= 0) {
      const header = rows[headerAt]
      const docAt = columnIndex(header, 'Document / Evidence')
      const purposeAt = columnIndex(header, 'Primary Purpose')
      for (const row of rows.slice(headerAt + 1)) {
        addDocument(documents, { documentType: row[docAt], primaryPurpose: row[purposeAt], source: 'Sheet6' }, knownCodes)
      }
    }
  }

  const result = [...documents.values()].filter(doc => doc.keywords.length || doc.practiceAreas.length)
  if (!result.length) issues.errors.push('No document/evidence catalogue entries could be imported from Sheet2, Sheet5 or Sheet6.')
  return result
}

export function normalizeMasterWorkbook(workbook, sourceFileName = 'CMMI master workbook') {
  const issues = { errors: [], warnings: [] }
  if (!workbook.Sheets.MASTER) issues.errors.push('The workbook must contain a MASTER sheet.')
  const rules = workbook.Sheets.MASTER ? parseRules(workbook.Sheets.MASTER, issues) : []
  const knownCodes = new Set(rules.map(rule => rule.practiceArea))
  const documentTypes = parseEvidenceCatalog(workbook, knownCodes, issues)
  const importedAt = new Date().toISOString()
  return {
    catalog: {
      ruleSetVersion: {
        id: `CMMI_EVIDENCE_RULES:${importedAt}`,
        name: 'CMMI_EVIDENCE_RULES',
        framework: 'CMMI v3.0',
        version: `Imported ${importedAt.slice(0, 10)}`,
        status: issues.errors.length ? 'DRAFT_INVALID' : 'VALIDATED',
        sourceFileName,
        importedAt,
      },
      rules,
      documentTypes,
      practiceAreas: [...knownCodes].sort(),
    },
    validation: issues,
  }
}

export async function importMasterRuleCatalog(file) {
  if (!file) throw new Error('Select the CMMI master workbook first.')
  const buffer = await file.arrayBuffer()
  let workbook
  try {
    workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  } catch (_) {
    throw new Error('The selected master workbook could not be read. Please provide a valid .xlsx or .xls file.')
  }
  const imported = normalizeMasterWorkbook(workbook, file.name)
  if (imported.validation.errors.length) throw new Error(`Rules catalogue is invalid: ${imported.validation.errors.join(' ')}`)
  return imported
}
