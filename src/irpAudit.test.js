// Verifies that Issue Category gaps flow through the SAME shared pipeline
// consumed by both the PA Validation page (IrpIncidentFindingsPanel in
// App.jsx, via getIrpIncidentFindings) and the AFR report (afrExport.js's
// irpAuditFindingsRows, which also calls getIrpIncidentFindings) — one row
// per affected Issue ID, included in the overall gap count, never collapsed
// into a single generic IRP-level gap.
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { validateIRPAudit, getIrpIncidentFindings } from './irpAudit'

function makeXlsxFile(name, sheetName, rows) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return { name, arrayBuffer: async () => buf }
}

const HEADERS = ['Issue ID', 'Status', 'Issue Category', 'Description', 'Priority', 'Impact', 'Urgency', 'Report Date & Time']

// Status is intentionally 'Open' (not 'Closed') — a 'Closed' status would
// additionally require a Close Date/Time column, an unrelated checklist
// rule not exercised by this Issue-Category-focused fixture.
function dataRow({ id = 'INC-000', category = 'Software Errors' } = {}) {
  return [id, 'Open', category, `Description for ${id || 'row'}`, 'P3', 'Medium', 'Medium', '01-Jan-2026 09:00']
}

// Mirrors afrExport.js's irpAuditFindingsRows() row shape exactly, since
// that private helper isn't exported — this proves what AFR's Detailed
// Findings sheet will contain without duplicating the validation logic
// itself (it only reads the same shared findings array).
function toAfrDetailedFindingsRows(irpAuditResult) {
  return getIrpIncidentFindings(irpAuditResult).map(f => ({
    'Incident ID': f.record || '-',
    'Findings': f.finding,
    'CMMI Practice Areas': 'IRP',
    'Recommendations': f.recommendation || '-',
  }))
}

describe('PA Validation + AFR: Issue Category gap propagation via getIrpIncidentFindings', () => {
  it('3 rows with blank Issue Category + distinct Issue IDs -> 3 separate gaps on PA Validation and in AFR, gap count +3', async () => {
    const baselineRows = [
      HEADERS,
      dataRow({ id: 'INC-001', category: 'Software Errors' }),
      dataRow({ id: 'INC-003', category: 'Network Outages' }),
      dataRow({ id: 'INC-007', category: 'Hardware Failures' }),
    ]
    const withBlanksRows = [
      HEADERS,
      dataRow({ id: 'INC-001', category: 'Software Errors' }),
      dataRow({ id: 'INC-002', category: '' }),
      dataRow({ id: 'INC-003', category: 'Network Outages' }),
      dataRow({ id: 'INC-004', category: '' }),
      dataRow({ id: 'INC-005', category: '   ' }),
      dataRow({ id: 'INC-007', category: 'Hardware Failures' }),
    ]

    const baseline = await validateIRPAudit([makeXlsxFile('Incident Log.xlsx', 'Incident Log', baselineRows)])
    const withBlanks = await validateIRPAudit([makeXlsxFile('Incident Log.xlsx', 'Incident Log', withBlanksRows)])

    // PA Validation page gap count (App.jsx's IrpIncidentFindingsPanel reads
    // findings.length off this exact array; irpAudit.js's summary.totalGaps
    // is the number shown elsewhere on the page).
    const baselinePaFindings = getIrpIncidentFindings(baseline)
    const withBlanksPaFindings = getIrpIncidentFindings(withBlanks)
    expect(withBlanksPaFindings.length - baselinePaFindings.length).toBe(3)
    expect(withBlanks.summary.totalGaps - baseline.summary.totalGaps).toBe(3)
    expect(withBlanks.summary.majorGaps - baseline.summary.majorGaps).toBe(3)

    const newCategoryFindings = withBlanksPaFindings.filter(f => f.field === 'Issue Category')
    expect(newCategoryFindings.map(f => f.record).sort()).toEqual(['INC-002', 'INC-004', 'INC-005'])
    newCategoryFindings.forEach(f => {
      expect(f.meta.validationStatus).toBe('Gap')
      expect(f.meta.gapType).toBe('Issue Category Missing')
    })

    // Same array feeds AFR's Detailed Findings sheet -> exactly 3 new,
    // independently-actionable rows, one per Issue ID.
    const baselineAfrRows = toAfrDetailedFindingsRows(baseline)
    const withBlanksAfrRows = toAfrDetailedFindingsRows(withBlanks)
    expect(withBlanksAfrRows.length - baselineAfrRows.length).toBe(3)

    const newAfrRows = withBlanksAfrRows.filter(r => !baselineAfrRows.some(b => b['Incident ID'] === r['Incident ID']))
    expect(newAfrRows.map(r => r['Incident ID']).sort()).toEqual(['INC-002', 'INC-004', 'INC-005'])
    newAfrRows.forEach(r => {
      expect(r['Findings']).toMatch(/Issue ID (INC-002|INC-004|INC-005): Issue Category is missing\/blank\. Please update the Issue Category for this incident\./)
    })

    // No single generic IRP-level gap ever replaces the per-incident findings.
    expect(withBlanksAfrRows.some(r => /issue category missing in irp document/i.test(r['Findings']))).toBe(false)
    expect(withBlanksPaFindings.some(f => /issue category missing in irp document/i.test(f.finding))).toBe(false)
  })

  it('invalid Issue Category with a valid Issue ID also produces one gap, distinct from blank/missing', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-009', category: 'Some Unlisted Category' })]
    const result = await validateIRPAudit([makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)])
    const findings = getIrpIncidentFindings(result).filter(f => f.field === 'Issue Category')
    expect(findings).toHaveLength(1)
    expect(findings[0].record).toBe('INC-009')
    expect(findings[0].meta.gapType).toBe('Invalid Issue Category')
  })
})
