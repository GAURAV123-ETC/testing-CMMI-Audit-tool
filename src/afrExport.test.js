// Regression test for the Issue Category gap-propagation bug report: proves
// the REAL exported downloadAFRExcel() function (not a re-implementation of
// its internal row-building logic) produces one Detailed Findings row per
// affected Issue ID when the Incident Log has blank/null Issue Category
// values. Exercises the full real path:
//   IRP Excel -> validateIncidentLog (incidentEngine.js)
//   -> validateIRPAudit (irpAudit.js) -> getIrpIncidentFindings
//   -> downloadAFRExcel (afrExport.js) -> real generated .xlsx bytes
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { validateIRPAudit, getIrpIncidentFindings } from './irpAudit'
import { checkIrpIssueLog, ISSUE_LOG_FIELDS } from './irpIssueLogEngine'
import { downloadAFRExcel, buildDetailedFindingsRows } from './afrExport'

function makeXlsxFile(name, sheetName, rows) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return { name, arrayBuffer: async () => buf }
}

const HEADERS = ['Issue ID', 'Status', 'Issue Category', 'Description', 'Priority', 'Impact', 'Urgency', 'Report Date & Time']
function dataRow({ id = 'INC-000', category = 'Software Errors' } = {}) {
  return [id, 'Open', category, `Description for ${id || 'row'}`, 'P3', 'Medium', 'Medium', '01-Jan-2026 09:00']
}

// downloadAFRExcel() triggers a real browser download (document.createElement
// + URL.createObjectURL). This test environment has no DOM, so we stub just
// enough to let the function run to completion and capture the real Blob it
// builds, then parse that Blob back with XLSX to inspect the actual sheet
// the user would download.
let capturedBlob = null
let originalDocument, originalURL

beforeEach(() => {
  capturedBlob = null
  originalDocument = globalThis.document
  originalURL = globalThis.URL
  globalThis.document = {
    createElement: () => ({ href: '', download: '', click() {} }),
    body: { appendChild() {}, removeChild() {} },
  }
  globalThis.URL = {
    ...originalURL,
    createObjectURL: (blob) => { capturedBlob = blob; return 'blob:mock-url' },
    revokeObjectURL: () => {},
  }
})

afterEach(() => {
  globalThis.document = originalDocument
  globalThis.URL = originalURL
})

async function readDetailedFindingsRows(blob) {
  const buf = await blob.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheet = wb.Sheets['Detailed Findings']
  return XLSX.utils.sheet_to_json(sheet, { defval: '' })
}

describe('AFR regression: real downloadAFRExcel() must contain per-Issue-ID Issue Category findings', () => {
  it('1) validation engine creates the finding for a blank-category row', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-001', category: 'Software Errors' }), dataRow({ id: 'INC-002', category: '' })]
    const irpAuditResult = await validateIRPAudit([makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)])
    const catFinding = irpAuditResult.incident.findings.find(f => f.field === 'Issue Category' && f.record === 'INC-002')
    expect(catFinding).toBeTruthy()
    expect(catFinding.meta.validationStatus).toBe('Gap')
  })

  it('2) getIrpIncidentFindings() returns it', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-002', category: '' })]
    const irpAuditResult = await validateIRPAudit([makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)])
    const findings = getIrpIncidentFindings(irpAuditResult)
    expect(findings.some(f => f.field === 'Issue Category' && f.record === 'INC-002')).toBe(true)
  })

  it('3-5) two blank-category Issue IDs -> the REAL generated AFR Excel Detailed Findings sheet contains exactly two separate, per-Issue-ID rows (never one generic gap)', async () => {
    const rows = [
      HEADERS,
      dataRow({ id: 'INC-001', category: 'Software Errors' }),
      dataRow({ id: 'INC-002', category: '' }),
      dataRow({ id: 'INC-003', category: 'Network Outages' }),
      dataRow({ id: 'INC-004', category: '' }),
    ]
    const irpAuditResult = await validateIRPAudit([makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)])

    downloadAFRExcel({ irpAuditResult, selectedDomains: [], meta: { projectName: 'Test Project', auditDate: '2026-08-11' } })

    expect(capturedBlob).toBeTruthy()
    const detailedRows = await readDetailedFindingsRows(capturedBlob)

    const categoryRows = detailedRows.filter(r => String(r['Findings']).includes('Issue Category is missing/blank'))
    expect(categoryRows).toHaveLength(2)

    const byIncident = Object.fromEntries(categoryRows.map(r => [r['Incident ID'], r['Findings']]))
    expect(byIncident['INC-002']).toBe('Issue ID INC-002: Issue Category is missing/blank. Please update the Issue Category for this incident.')
    expect(byIncident['INC-004']).toBe('Issue ID INC-004: Issue Category is missing/blank. Please update the Issue Category for this incident.')

    // Never collapsed into one generic document-level gap.
    expect(detailedRows.some(r => /issue category missing in irp document/i.test(r['Findings']))).toBe(false)

    // Every IRP row in the real exported sheet is independently actionable,
    // and its Recommendation names the Issue ID and the corrective action.
    categoryRows.forEach(r => {
      expect(r['CMMI Practice Areas']).toBe('IRP')
      expect(r['Incident ID']).not.toBe('-')
      expect(r['Recommendations']).toContain(`Issue ID ${r['Incident ID']}`)
      expect(r['Recommendations']).toMatch(/update the issue category/i)
    })
  })

  it('buildDetailedFindingsRows() — the same builder consumed by the on-screen AFR report tab — carries the real, non-fabricated Severity for the Issue Category findings', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-002', category: '' }), dataRow({ id: 'INC-006', category: 'Database Issue' })]
    const irpAuditResult = await validateIRPAudit([makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)])

    const detailedRows = buildDetailedFindingsRows(null, {}, null, irpAuditResult, [], {})
    const missing = detailedRows.find(r => r['Incident ID'] === 'INC-002')
    const invalid = detailedRows.find(r => r['Incident ID'] === 'INC-006')

    // Matches the real severity already assigned by validateIssueCategory()
    // in incidentEngine.js (both 'Major') — never invented at the AFR layer.
    expect(missing.Severity).toBe('Major')
    expect(invalid.Severity).toBe('Major')
  })

  it('downloadAFRWord() also reaches the same per-Issue-ID findings via the same getIrpIncidentFindings source (no divergent AFR path)', async () => {
    // downloadAFRWord builds its Detailed Findings rows from the exact same
    // buildDetailedFindingsRows()/irpAuditFindingsRows() helpers as
    // downloadAFRExcel — verified by reading afrExport.js: both call
    // buildDetailedFindingsRows(..., irpAuditResult, ...) directly. Excel is
    // the representative, fully-verified path above; this assertion pins
    // that no second/divergent finding-selection mechanism exists for Word.
    const src = await import('node:fs/promises').then(fs => fs.readFile('./src/afrExport.js', 'utf8'))
    const excelCall = src.match(/export function downloadAFRExcel[\s\S]*?buildDetailedFindingsRows\(([^)]*)\)/)[1]
    const wordCall = src.match(/export async function downloadAFRWord[\s\S]*?buildDetailedFindingsRows\(([^)]*)\)/)[1]
    expect(wordCall.replace(/\s/g, '')).toBe(excelCall.replace(/\s/g, ''))
  })
})

// PA Validation -> Requirement-Level Gap -> AFR Detailed Findings: proves
// that a required header/field the PA Validation page's IRP Issue Log table
// reports as "Missing" (via checkIrpIssueLog() -> fieldResults) is the exact
// same source of truth that flows into AFR's Detailed Findings, using the
// REAL engine (irpIssueLogEngine.js) and the REAL exported downloadAFRExcel()
// — never a re-implementation or a separate hardcoded missing-header list.
function makeIssueLogFile(name, sheetName, headerRow, dataRows = []) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows])
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const file = { name, arrayBuffer: async () => buf }
  return { name, path: ['IRP'], getFile: async () => file }
}

const ALL_ISSUE_LOG_HEADERS = ISSUE_LOG_FIELDS.map(f => f.label)

describe('PA Validation -> AFR Detailed Findings: IRP Issue Log missing required headers', () => {
  it('a header the PA Validation table marks MISSING appears in a consolidated AFR Detailed Findings row (Gap Description names it, Recommendation tells what to add, PA Mapping = IRP)', async () => {
    const missingLabels = ['Escalated To', 'Causes', 'Non-Conformity Status']
    const presentHeaders = ALL_ISSUE_LOG_HEADERS.filter(h => !missingLabels.includes(h))

    const irpIssueLog = await checkIrpIssueLog([makeIssueLogFile('IRP Issue Log.xlsx', 'Issue Log', presentHeaders)])

    // Same fact the PA Validation page's "Required Field / Detected Header /
    // Status / Remarks" table would render for these three fields.
    missingLabels.forEach(label => {
      const fr = irpIssueLog.fieldResults.find(f => f.field === label)
      expect(fr.status).toBe('MISSING')
    })

    const detailedRows = buildDetailedFindingsRows(null, {}, null, null, [], {}, irpIssueLog)
    const headerGapRows = detailedRows.filter(r => /missing from the IRP Issue Log/i.test(r['Findings']))

    // Consolidated into exactly one finding, not one row per header.
    expect(headerGapRows).toHaveLength(1)
    const row = headerGapRows[0]
    missingLabels.forEach(label => {
      expect(row['Findings']).toContain(label)
      expect(row['Recommendations']).toContain(label)
    })
    expect(row['CMMI Practice Areas']).toBe('IRP')
    expect(row['Severity']).toBe('Major')

    // Valid/present headers must not themselves generate findings.
    presentHeaders.forEach(label => {
      expect(row['Findings']).not.toMatch(new RegExp(`\\b${label}\\b.*missing`, 'i'))
    })
  })

  it('produces no IRP Issue Log header finding when every required header is present', async () => {
    const irpIssueLog = await checkIrpIssueLog([makeIssueLogFile('IRP Issue Log.xlsx', 'Issue Log', ALL_ISSUE_LOG_HEADERS)])
    expect(irpIssueLog.fieldResults.every(f => f.status === 'AVAILABLE')).toBe(true)

    const detailedRows = buildDetailedFindingsRows(null, {}, null, null, [], {}, irpIssueLog)
    expect(detailedRows.some(r => /missing from the IRP Issue Log/i.test(r['Findings']))).toBe(false)
  })

  it('the real downloadAFRExcel() export contains the missing-header finding (full PA Validation -> AFR path, not just the in-memory builder)', async () => {
    const irpIssueLog = await checkIrpIssueLog([makeIssueLogFile('IRP Issue Log.xlsx', 'Issue Log', ALL_ISSUE_LOG_HEADERS.filter(h => h !== 'Root Cause'))])

    downloadAFRExcel({ irpIssueLog, selectedDomains: [], meta: { projectName: 'Test Project', auditDate: '2026-08-12' } })

    expect(capturedBlob).toBeTruthy()
    const detailedRows = await readDetailedFindingsRows(capturedBlob)
    const row = detailedRows.find(r => /missing from the IRP Issue Log/i.test(r['Findings']))
    expect(row).toBeTruthy()
    expect(row['Findings']).toContain('Root Cause')
    expect(row['CMMI Practice Areas']).toBe('IRP')
    expect(row['Recommendations']).toContain('Root Cause')
  })

  it('does not duplicate the IRP Issue Log header gap with irpAuditResult\'s incident-log header findings (Source 4 excludes level==="header")', async () => {
    const rows = [ALL_ISSUE_LOG_HEADERS.filter(h => h !== 'Escalated To')]
    const irpIssueLog = await checkIrpIssueLog([makeIssueLogFile('IRP Issue Log.xlsx', 'Issue Log', rows[0])])
    const irpAuditResult = await validateIRPAudit([makeXlsxFile('IRP Issue Log.xlsx', 'Issue Log', rows)])

    const detailedRows = buildDetailedFindingsRows(null, {}, null, irpAuditResult, [], {}, irpIssueLog)
    const escalatedToMentions = detailedRows.filter(r => /escalated to/i.test(r['Findings']))
    expect(escalatedToMentions).toHaveLength(1)
  })
})

// Regression coverage for the "blank cells not detected correctly from the
// uploaded Excel file" bug report, exercised through the REAL, full export
// path (uploaded .xlsx -> validateIRPAudit -> getIrpIncidentFindings ->
// downloadAFRExcel -> real generated .xlsx bytes) rather than the in-memory
// builder alone, covering every real-world blank shape called out in the
// report: empty cell/null, empty string, spaces-only, non-breaking-spaces-
// only, and the literal text "Blank" — while confirming properly populated
// categories (Network Outages, Software Errors, Hardware Failures) are
// completely unaffected.
describe('AFR export with an uploaded Issue Log containing every blank-cell shape (empty, spaces, non-breaking spaces, "Blank")', () => {
  const NBSP = ' '

  it('every blank/"Blank" row produces its own AFR Detailed Findings row naming its Issue ID, and valid rows produce none', async () => {
    const rows = [
      HEADERS,
      dataRow({ id: 'INC-001', category: 'Network Outages' }),
      dataRow({ id: 'INC-002', category: null }),                          // empty cell / null
      dataRow({ id: 'INC-003', category: 'Software Errors' }),
      dataRow({ id: 'INC-004', category: '' }),                            // empty string
      dataRow({ id: 'INC-005', category: '   ' }),                         // normal spaces only
      dataRow({ id: 'INC-006', category: `${NBSP}${NBSP}${NBSP}` }),       // non-breaking spaces only
      dataRow({ id: 'INC-007', category: 'Hardware Failures' }),
      dataRow({ id: 'INC-008', category: 'Blank' }),                       // literal text "Blank"
      dataRow({ id: 'INC-009', category: '  BLANK  ' }),                   // literal text, mixed case + padding
    ]
    const irpAuditResult = await validateIRPAudit([makeXlsxFile('IRP Issue Log.xlsx', 'Incident Log', rows)])

    downloadAFRExcel({ irpAuditResult, selectedDomains: [], meta: { projectName: 'Test Project', auditDate: '2026-08-12' } })

    expect(capturedBlob).toBeTruthy()
    const detailedRows = await readDetailedFindingsRows(capturedBlob)
    const categoryRows = detailedRows.filter(r => String(r['Findings']).includes('Issue Category is missing/blank'))

    const expectedBlankIds = ['INC-002', 'INC-004', 'INC-005', 'INC-006', 'INC-008', 'INC-009']
    expect(categoryRows.map(r => r['Incident ID']).sort()).toEqual(expectedBlankIds)

    categoryRows.forEach(r => {
      const id = r['Incident ID']
      expect(r['Findings']).toBe(`Issue ID ${id}: Issue Category is missing/blank. Please update the Issue Category for this incident.`)
      expect(r['Recommendations']).toContain(`Issue ID ${id}`)
      expect(r['Recommendations']).toMatch(/update the issue category/i)
      expect(r['CMMI Practice Areas']).toBe('IRP')
    })

    // Properly populated categories never produce a finding.
    const validIds = ['INC-001', 'INC-003', 'INC-007']
    expect(detailedRows.some(r => validIds.includes(r['Incident ID']))).toBe(false)
  })
})
