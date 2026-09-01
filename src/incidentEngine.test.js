// Verifies IRP Issue Category gap propagation: a blank/null/whitespace/
// invalid Issue Category on a row with a valid Issue ID must produce a
// dedicated, per-Issue-ID incident-level gap (never a single generic
// document-level gap) — see validateIssueCategory() in incidentEngine.js.
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validateIncidentLog, ALLOWED_ISSUE_CATEGORIES } from './incidentEngine'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Minimal File-like object — incidentEngine only needs .name and .arrayBuffer().
function makeXlsxFile(name, sheetName, rows) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return { name, arrayBuffer: async () => buf }
}

const HEADERS = ['Issue ID', 'Status', 'Issue Category', 'Description', 'Priority', 'Impact', 'Urgency', 'Report Date & Time']

// Status is intentionally 'Open' (not 'Closed') in this minimal fixture —
// a 'Closed' status would additionally require a Close Date/Time column
// (a separate, unrelated checklist rule) which these Issue-Category-focused
// tests don't include.
function dataRow({ id = 'INC-000', category = 'Software Errors' } = {}) {
  return [id, 'Open', category, `Description for ${id || 'row'}`, 'P3', 'Medium', 'Medium', '01-Jan-2026 09:00']
}

function categoryFindings(findings) {
  return findings.filter(f => f.field === 'Issue Category')
}

describe('validateIssueCategory gap propagation', () => {
  it('edge case 1/2: blank or empty Issue Category with a valid Issue ID produces a Gap', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-001', category: 'Software Errors' }), dataRow({ id: 'INC-002', category: '' })]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings).toHaveLength(1)
    expect(catFindings[0].record).toBe('INC-002')
    expect(catFindings[0].severity).toBe('Major')
    expect(catFindings[0].meta.gapType).toBe('Issue Category Missing')
    expect(catFindings[0].meta.validationStatus).toBe('Gap')
    expect(catFindings[0].finding).toBe('Issue ID INC-002: Issue Category is missing/blank. Please update the Issue Category for this incident.')
    expect(catFindings[0].recommendation).toContain('Issue ID INC-002')
  })

  it('edge case 3: whitespace-only Issue Category is treated as blank -> Gap', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-006', category: '   ' })]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings).toHaveLength(1)
    expect(catFindings[0].record).toBe('INC-006')
    expect(catFindings[0].meta.gapType).toBe('Issue Category Missing')
  })

  it('edge case 4: invalid/undefined Issue Category with a valid Issue ID produces a Gap (distinct gapType)', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-007', category: 'Database Issue' })]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings).toHaveLength(1)
    expect(catFindings[0].record).toBe('INC-007')
    expect(catFindings[0].meta.gapType).toBe('Invalid Issue Category')
    expect(catFindings[0].actual).toBe('Database Issue')
    expect(catFindings[0].meta.allowedCategories).toEqual(ALLOWED_ISSUE_CATEGORIES)
  })

  it('edge case 5: each of the four defined categories is a Pass (no Issue Category finding)', async () => {
    const rows = [
      HEADERS,
      ...ALLOWED_ISSUE_CATEGORIES.map((category, i) => dataRow({ id: `INC-0${i + 1}0`, category })),
    ]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    expect(categoryFindings(result.findings)).toHaveLength(0)
  })

  it('edge case 6: multiple blank-category rows each get their own separate gap, keyed by their own Issue ID', async () => {
    const rows = [
      HEADERS,
      dataRow({ id: 'INC-001', category: 'Software Errors' }),
      dataRow({ id: 'INC-002', category: '' }),
      dataRow({ id: 'INC-003', category: 'Network Outages' }),
      dataRow({ id: 'INC-004', category: '' }),
    ]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings).toHaveLength(2)
    const ids = catFindings.map(f => f.record).sort()
    expect(ids).toEqual(['INC-002', 'INC-004'])
    // Never collapsed into one generic document-level gap.
    expect(result.findings.some(f => /issue category missing in irp document/i.test(f.finding))).toBe(false)
  })

  it('edge case 7: a row without an Issue ID follows the existing missing-Issue-ID rule and is never fabricated an ID, but Issue Category is still evaluated', async () => {
    const rows = [HEADERS, dataRow({ id: '', category: '' })]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const idFinding = result.findings.find(f => f.field === 'Incident ID')
    expect(idFinding).toBeTruthy()
    expect(idFinding.severity).toBe('Critical')

    const catFindings = categoryFindings(result.findings)
    expect(catFindings).toHaveLength(1)
    // Labeled by row position, never fabricated as a real Issue ID like "INC-xxx".
    expect(catFindings[0].record).toMatch(/^Row \d+$/)
    expect(catFindings[0].record).not.toMatch(/^INC-/)
  })

  it('edge case 8: existing four-category validation (impact/urgency/priority/status) still runs without regression', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-001', category: 'Software Errors' })]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    // A fully valid row produces zero row-level findings besides header gaps
    // for the columns intentionally omitted from this minimal fixture.
    const rowLevelFindings = result.findings.filter(f => f.level === 'row' && f.record === 'INC-001')
    expect(rowLevelFindings).toHaveLength(0)
  })

  it('real IRP_dummy_data.xlsx fixture: 3 distinct blank/null/whitespace rows plus 1 invalid row each produce their own Gap', async () => {
    const buf = readFileSync(join(__dirname, '..', 'reference_documents', 'IRP_dummy_data.xlsx'))
    const file = { name: 'IRP_dummy_data.xlsx', arrayBuffer: async () => buf }
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    // INC-002 (blank), INC-004 (blank/"null"), INC-005 (whitespace) -> missing; INC-006 -> invalid.
    const missing = catFindings.filter(f => f.meta.gapType === 'Issue Category Missing')
    const invalid = catFindings.filter(f => f.meta.gapType === 'Invalid Issue Category')
    // Includes 'Row 10' — the fixture's last row has neither Issue ID nor
    // Issue Category; it still gets its own Issue Category gap (labeled by
    // row position per the existing missing-Issue-ID rule, never a
    // fabricated Issue ID) alongside the Incident ID gap for that row.
    expect(missing.map(f => f.record).sort()).toEqual(['INC-002', 'INC-004', 'INC-005', 'Row 10'])
    expect(invalid.map(f => f.record)).toEqual(['INC-006'])
    // INC-001, INC-003, INC-007, INC-008 are valid categories -> no findings for them.
    expect(catFindings.some(f => ['INC-001', 'INC-003', 'INC-007', 'INC-008'].includes(f.record))).toBe(false)
  })
})

// Regression coverage for the "blank cells not detected correctly" bug
// report: every real-world shape a blank Issue Category cell can take in an
// uploaded Excel file — a truly empty cell, an empty string, spaces-only,
// non-breaking-spaces-only, and the literal text "Blank" (any case/spacing)
// — must all be normalized to the same missing-category Gap, each keyed by
// its own Issue ID, while properly populated categories are left untouched.
describe('Issue Category blank-detection: empty cell, empty string, spaces, non-breaking spaces, literal "Blank"', () => {
  // Note: `category: undefined` is deliberately never used as a fixture
  // value here — dataRow()'s destructuring default (`category = 'Software
  // Errors'`) would silently substitute a valid category for `undefined`,
  // which does not represent a real Excel scenario anyway (a truly empty
  // cell round-trips through XLSX as `null`/`''`, verified separately).
  const NBSP = ' '
  const BLANK_VARIANTS = [
    { id: 'INC-101', category: null, label: 'empty cell / null value' },
    { id: 'INC-102', category: '', label: 'empty string' },
    { id: 'INC-103', category: '   ', label: 'normal spaces only' },
    { id: 'INC-104', category: NBSP + NBSP + NBSP, label: 'non-breaking spaces only' },
    { id: 'INC-105', category: '  ' + NBSP + ' ' + NBSP + '  ', label: 'mixed normal + non-breaking spaces (whitespace-only)' },
    { id: 'INC-106', category: 'Blank', label: 'literal text "Blank"' },
    { id: 'INC-107', category: 'BLANK', label: 'literal text "BLANK" (uppercase)' },
    { id: 'INC-108', category: '  blank  ', label: 'literal text " blank " (lowercase, padded)' },
  ]

  it.each(BLANK_VARIANTS)('$label ($id) is normalized and detected as missing Issue Category', async ({ id, category }) => {
    const rows = [HEADERS, dataRow({ id, category })]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings).toHaveLength(1)
    expect(catFindings[0].record).toBe(id)
    expect(catFindings[0].meta.gapType).toBe('Issue Category Missing')
    expect(catFindings[0].finding).toBe(`Issue ID ${id}: Issue Category is missing/blank. Please update the Issue Category for this incident.`)
    expect(catFindings[0].recommendation).toContain(`Issue ID ${id}`)
    expect(catFindings[0].recommendation).toMatch(/update the issue category/i)
  })

  it('all blank variants in one uploaded log each produce their own Gap, keyed by their own Issue ID — no collapsing, no false negatives', async () => {
    const rows = [HEADERS, ...BLANK_VARIANTS.map(v => dataRow({ id: v.id, category: v.category }))]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings.map(f => f.record).sort()).toEqual(BLANK_VARIANTS.map(v => v.id).sort())
    catFindings.forEach(f => expect(f.meta.gapType).toBe('Issue Category Missing'))
  })

  it('properly populated categories (Network Outages, Software Errors, Hardware Failures) never produce a finding, even alongside blank rows', async () => {
    const rows = [
      HEADERS,
      dataRow({ id: 'INC-201', category: 'Network Outages' }),
      dataRow({ id: 'INC-202', category: 'Software Errors' }),
      dataRow({ id: 'INC-203', category: 'Hardware Failures' }),
      dataRow({ id: 'INC-204', category: 'User-reported Problems' }),
      dataRow({ id: 'INC-205', category: '' }),
      dataRow({ id: 'INC-206', category: 'Blank' }),
    ]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings.map(f => f.record).sort()).toEqual(['INC-205', 'INC-206'])
    expect(catFindings.some(f => ['INC-201', 'INC-202', 'INC-203', 'INC-204'].includes(f.record))).toBe(false)
  })

  it('a literal "Blank" value is reported as missing, never as an "unrecognized category" gap', async () => {
    const rows = [HEADERS, dataRow({ id: 'INC-301', category: 'Blank' })]
    const file = makeXlsxFile('Incident Log.xlsx', 'Incident Log', rows)
    const result = await validateIncidentLog([file])

    const catFindings = categoryFindings(result.findings)
    expect(catFindings).toHaveLength(1)
    expect(catFindings[0].meta.gapType).toBe('Issue Category Missing')
    expect(catFindings[0].meta.gapType).not.toBe('Invalid Issue Category')
  })
})
