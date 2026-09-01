// Tests for the Folder-Based Keyword & Evidence Scan engine. Pure functions
// (matchKeywordsInText, classifyEvidenceStatus, assignPracticeArea,
// groupFilesByProject) are tested directly. runEvidenceScan is tested
// end-to-end with documentTextExtraction's extractDocumentText mocked (via
// vi.importActual for the real getExt/terminateOcrWorker) so the test never
// needs real xlsx/docx/pdf binaries or OCR — matching the existing
// afrExport.test.js convention of exercising the real orchestrator with only
// its I/O boundary stubbed.
import { describe, it, expect, vi } from 'vitest'
import {
  matchKeywordsInText, classifyEvidenceStatus, assignPracticeArea,
  groupFilesByProject, runEvidenceScan,
} from './evidenceScanEngine'

vi.mock('./documentTextExtraction', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    extractDocumentText: vi.fn(),
    terminateOcrWorker: vi.fn(async () => {}),
  }
})
import { extractDocumentText } from './documentTextExtraction'

function entry(path, name, text) {
  return {
    path, name,
    getFile: async () => ({ name, text }),
  }
}

describe('matchKeywordsInText', () => {
  it('finds keywords present with a word boundary', () => {
    const { found, missing } = matchKeywordsInText('SLA breach, RCA completed, Priority P1', ['SLA', 'RCA', 'Priority'])
    expect(found).toEqual(['SLA', 'RCA', 'Priority'])
    expect(missing).toEqual([])
  })

  it('does not match a keyword that only appears as a substring of another word', () => {
    const { found, missing } = matchKeywordsInText('The orca were spotted offshore', ['RCA'])
    expect(found).toEqual([])
    expect(missing).toEqual(['RCA'])
  })

  it('is case-insensitive', () => {
    const { found } = matchKeywordsInText('the risk register lists owner and impact', ['Risk', 'Impact', 'Owner'])
    expect(found.sort()).toEqual(['Impact', 'Owner', 'Risk'])
  })

  it('handles empty text without throwing', () => {
    const { found, missing } = matchKeywordsInText('', ['Risk', 'Impact'])
    expect(found).toEqual([])
    expect(missing).toEqual(['Risk', 'Impact'])
  })
})

describe('classifyEvidenceStatus', () => {
  it('is FOUND when every expected keyword is present', () => {
    expect(classifyEvidenceStatus(['Risk', 'Impact'], ['Risk', 'Impact'])).toBe('FOUND')
  })
  it('is PARTIAL when some but not all expected keywords are present', () => {
    expect(classifyEvidenceStatus(['Risk'], ['Risk', 'Impact', 'Owner'])).toBe('PARTIAL')
  })
  it('is MISSING when none are present', () => {
    expect(classifyEvidenceStatus([], ['Risk', 'Impact'])).toBe('MISSING')
  })
  it('is MISSING when there is nothing expected', () => {
    expect(classifyEvidenceStatus([], [])).toBe('MISSING')
  })
})

describe('assignPracticeArea', () => {
  it('picks the Practice Area with the most content keyword hits', () => {
    const { code, source } = assignPracticeArea('Risk_Register.xlsx', 'Risk Impact Owner identified for this release')
    expect(code).toBe('RSK')
    expect(source).toBe('content')
  })

  it('falls back to a filename hint when content gives no signal', () => {
    const { code, source } = assignPracticeArea('SOW.docx', 'This document has no relevant terms at all')
    expect(code).toBe('RDM')
    expect(source).toBe('filename')
  })

  it('returns UNCLASSIFIED when neither content nor filename gives a signal', () => {
    const { code, source } = assignPracticeArea('notes.docx', 'nothing relevant here')
    expect(code).toBe('UNCLASSIFIED')
    expect(source).toBe('none')
  })

  it('prefers content over a conflicting filename hint', () => {
    // Filename hints at RSK ("risk"), but content only has PLAN keywords.
    const { code, source } = assignPracticeArea('risk_notes.docx', 'Planning Schedule Milestone review')
    expect(code).toBe('PLAN')
    expect(source).toBe('content')
  })
})

describe('groupFilesByProject', () => {
  it('groups files by top-level folder and includes empty project folders', () => {
    const scan = {
      rootName: 'Project_Documents',
      folderPaths: ['Project_Alpha', 'Project_Beta', 'Project_Alpha/Images'],
      files: [
        { path: ['Project_Alpha'], name: 'IRP.xlsx' },
        { path: ['Project_Alpha', 'Images'], name: 'scan1.png' },
      ],
    }
    const groups = groupFilesByProject(scan)
    const byName = Object.fromEntries(groups.map(g => [g.projectName, g]))

    expect(byName['Project_Alpha'].files.length).toBe(2)
    expect(byName['Project_Beta'].files.length).toBe(0)
  })

  it('keeps an empty project fully independent of a populated one', () => {
    const scanWithBeta = {
      rootName: 'Project_Documents',
      folderPaths: ['Project_Alpha', 'Project_Beta'],
      files: [{ path: ['Project_Alpha'], name: 'IRP.xlsx' }],
    }
    const scanWithoutBeta = {
      rootName: 'Project_Documents',
      folderPaths: ['Project_Alpha'],
      files: [{ path: ['Project_Alpha'], name: 'IRP.xlsx' }],
    }
    const alphaWithBeta = groupFilesByProject(scanWithBeta).find(g => g.projectName === 'Project_Alpha')
    const alphaWithoutBeta = groupFilesByProject(scanWithoutBeta).find(g => g.projectName === 'Project_Alpha')
    expect(alphaWithBeta.files).toEqual(alphaWithoutBeta.files)
  })
})

describe('runEvidenceScan', () => {
  it('produces one row per document, classifies each, and reports an empty project without affecting the populated one', async () => {
    extractDocumentText.mockImplementation(async (e) => {
      if (e.name === 'IRP.xlsx') return { text: 'SLA breach RCA completed Priority P1', method: 'text-layer', ocrUsed: false }
      if (e.name === 'Risk_Register.xlsx') return { text: 'Risk Impact identified for this project', method: 'text-layer', ocrUsed: false }
      return { text: '', method: 'text-layer', ocrUsed: false }
    })

    const scan = {
      rootName: 'Project_Documents',
      folderPaths: ['Project_Alpha', 'Project_Beta'],
      files: [
        entry(['Project_Alpha'], 'IRP.xlsx'),
        entry(['Project_Alpha'], 'Risk_Register.xlsx'),
      ],
    }

    const { rows } = await runEvidenceScan(scan)
    expect(rows.length).toBe(3) // IRP.xlsx + Risk_Register.xlsx + Project_Beta placeholder

    const irpRow = rows.find(r => r.document === 'IRP.xlsx')
    expect(irpRow.project).toBe('Project_Alpha')
    expect(irpRow.practiceArea).toBe('IRP')
    expect(irpRow.keywordsFound.sort()).toEqual(['Priority', 'RCA', 'SLA'])
    expect(irpRow.evidenceStatus).toBe('FOUND')

    const riskRow = rows.find(r => r.document === 'Risk_Register.xlsx')
    expect(riskRow.practiceArea).toBe('RSK')
    expect(riskRow.keywordsFound.sort()).toEqual(['Impact', 'Risk'])
    expect(riskRow.keywordsMissing).toEqual(['Owner'])
    expect(riskRow.evidenceStatus).toBe('PARTIAL')

    const betaRow = rows.find(r => r.project === 'Project_Beta')
    expect(betaRow.document).toBe('(none)')
    expect(betaRow.evidenceStatus).toBe('MISSING')
    expect(betaRow.note).toMatch(/no documents found/i)
  })

  it('reports a per-file extraction error as a traceable row instead of throwing', async () => {
    extractDocumentText.mockImplementation(async (e) => {
      if (e.name === 'broken.pdf') return { text: '', method: 'error', ocrUsed: false, error: 'Could not parse PDF' }
      return { text: 'Risk Impact Owner', method: 'text-layer', ocrUsed: false }
    })

    const scan = {
      rootName: 'Project_Documents',
      folderPaths: ['Project_Alpha'],
      files: [
        entry(['Project_Alpha'], 'broken.pdf'),
        entry(['Project_Alpha'], 'Risk_Register.xlsx'),
      ],
    }

    const { rows } = await runEvidenceScan(scan)
    expect(rows.length).toBe(2)
    const brokenRow = rows.find(r => r.document === 'broken.pdf')
    expect(brokenRow.evidenceStatus).toBe('MISSING')
    expect(brokenRow.note).toMatch(/could not read file/i)
    // The sibling file's own result is unaffected by the broken one.
    const riskRow = rows.find(r => r.document === 'Risk_Register.xlsx')
    expect(riskRow.evidenceStatus).toBe('FOUND')
  })
})
