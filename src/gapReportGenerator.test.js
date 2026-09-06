import { describe, expect, it } from 'vitest'
import { generateGapReport } from './gapReportGenerator'

function file(name, status) {
  return {
    originalFileName: name,
    detectedDocType: 'Risk Register',
    confidence: 'High',
    practiceAreas: ['RSK'],
    totalRulesChecked: 1,
    foundCount: status === 'FOUND' ? 1 : 0,
    partialCount: status === 'PARTIAL' ? 1 : 0,
    missingCount: status === 'MISSING' ? 1 : 0,
    unknownCount: 0,
    status: 'OK',
    results: [{
      ruleId: 'RSK-1', practiceArea: 'RSK', level: 'L3-Check',
      auditCheck: 'Are risks monitored?', status,
      foundEvidence: status === 'FOUND' ? ['risk'] : [],
      missingEvidence: status === 'FOUND' ? [] : ['risk'],
      gapText: 'Risk evidence is incomplete.', recommendation: 'Provide evidence.',
      originalFileName: name, detectedDocType: 'Risk Register',
    }],
  }
}

describe('generateGapReport', () => {
  it('evaluates a rule once at project scope using the strongest accepted supporting document', () => {
    const report = generateGapReport([file('draft.xlsx', 'MISSING'), file('approved.xlsx', 'FOUND')])
    expect(report.evidenceGapReport).toEqual([])
    expect(report.gapSummary).toMatchObject({ totalRulesChecked: 1, totalFound: 1, totalGaps: 0 })
    expect(report.gapSummary.byPracticeArea.RSK).toMatchObject({ total: 1, found: 1 })
  })
})
