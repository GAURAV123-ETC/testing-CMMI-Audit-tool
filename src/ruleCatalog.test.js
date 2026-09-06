import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { normalizeMasterWorkbook } from './ruleCatalog'

function sheet(rows) {
  return XLSX.utils.aoa_to_sheet(rows)
}

describe('normalizeMasterWorkbook', () => {
  it('normalizes workbook rules and evidence dictionaries without using sheet positions', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet([
      ['CMMI master'],
      ['#', 'Level', 'Rule ID', 'Gate / Artefact', 'Audit Check (What the auditor looks for and verifies)', 'Conformance', 'If NO: Finding and Implication'],
      ['DOMAIN A: DEVELOPMENT (DEV)'],
      [1, 'L1-Gate', 'RSK-G1', 'Artefact Gate', 'Locate the Risk Register.', '', 'Risk register is missing.'],
      [2, 'L3-Check', 'RSK-1', '', 'Are risk owners and mitigations recorded?', '', 'Risk controls are incomplete.'],
    ]), 'MASTER')
    XLSX.utils.book_append_sheet(workbook, sheet([
      ['S. No.', 'Domain Name', 'Practice Area Name', 'Related Document Name', 'Main Keywords', 'Example Evidence / Example Document'],
      [1, 'Development', 'Risk and Opportunity Management (RSK)', 'Risk Register', 'Risk ID, Probability, Impact, Owner, Mitigation, Status', 'Current project risk register'],
    ]), 'Sheet2')
    XLSX.utils.book_append_sheet(workbook, sheet([
      ['Sr. No.', 'Document / Evidence', 'Related Practice Area', 'What to Check / Key Points', 'Expected Evidence'],
      [1, 'Risk Register', 'RSK', 'Risk ID, Probability, Impact, Owner, Mitigation', 'Updated risk register'],
    ]), 'Sheet5')
    XLSX.utils.book_append_sheet(workbook, sheet([
      ['Document / Evidence', 'Primary Purpose'],
      ['Risk Register', 'Manage project risks'],
    ]), 'Sheet6')

    const { catalog, validation } = normalizeMasterWorkbook(workbook, 'master.xlsx')

    expect(validation.errors).toEqual([])
    expect(catalog.rules).toHaveLength(2)
    expect(catalog.rules[0]).toMatchObject({ ruleId: 'RSK-G1', practiceArea: 'RSK', domain: 'DEV', isGate: true })
    expect(catalog.documentTypes).toHaveLength(1)
    expect(catalog.documentTypes[0]).toMatchObject({ documentType: 'Risk Register', practiceAreas: ['RSK'], primaryPurpose: 'Manage project risks' })
    expect(catalog.documentTypes[0].keywords).toContain('Mitigation')
  })

  it('rejects a master workbook with duplicate rule IDs', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet([
      ['Level', 'Rule ID', 'Audit Check (What the auditor looks for and verifies)', 'If NO: Finding and Implication'],
      ['L1-Gate', 'RDM-G1', 'Locate requirements.', 'Missing requirements.'],
      ['L3-Check', 'RDM-G1', 'Check requirements.', 'Incomplete requirements.'],
    ]), 'MASTER')

    const { validation } = normalizeMasterWorkbook(workbook)
    expect(validation.errors.join(' ')).toMatch(/Duplicate Rule ID/)
  })
})
