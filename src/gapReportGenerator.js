// ─── Gap Report Generator ───────────────────────────────────────────────────
//
// Rolls up an array of per-file validateEvidence() results (see
// evidenceValidationEngine.js) — optionally enriched with a
// `confidenceScore` field by the orchestrator (evidenceScanOrchestrator.js),
// since validateEvidence()'s own return shape only carries the confidence
// label, not the numeric score — into three reports: one row per file
// (classificationReport), one row per open finding (evidenceGapReport), and
// one aggregate summary (gapSummary).

function buildClassificationRow(fileResult) {
  const gapCount = fileResult.partialCount + fileResult.missingCount
  return {
    originalFileName: fileResult.originalFileName,
    detectedType: fileResult.detectedDocType,
    confidence: fileResult.confidence,
    confidenceScore: fileResult.confidenceScore,
    classificationReason: fileResult.classificationReason || '',
    documentRole: fileResult.documentRole || '',
    practiceAreas: fileResult.practiceAreas,
    totalRulesChecked: fileResult.totalRulesChecked,
    foundCount: fileResult.foundCount,
    partialCount: fileResult.partialCount,
    missingCount: fileResult.missingCount,
    unknownCount: fileResult.unknownCount,
    gapCount,
    // Weak classification, not evidence completeness, is what should send
    // a file back for manual review — a well-classified file with many
    // content gaps still gets a real gap report, not a "go re-check this".
    reviewRequired: fileResult.status === 'ERROR' || fileResult.detectedDocType === 'Unknown / Review Required' || fileResult.confidence === 'Low',
    status: fileResult.status === 'ERROR' ? 'ERROR' : 'OK',
    errorReason: fileResult.status === 'ERROR' ? fileResult.errorReason : '',
  }
}

// A file that failed extraction (status: 'ERROR') never ran validateEvidence
// (no rules to check against), but it must still be visible in the Evidence
// Gap Report — not just the Classification tab — so it can't be missed
// during review. It gets exactly one row, status ERROR, carrying the reason.
function buildEvidenceGapRows(fileResult) {
  if (fileResult.status === 'ERROR') {
    return [{
      originalFileName: fileResult.originalFileName,
      detectedDocType: 'ERROR',
      practiceArea: '-',
      ruleId: '-',
      level: '-',
      auditCheck: 'File could not be read/parsed',
      status: 'ERROR',
      foundEvidence: [],
      missingEvidence: [],
      gapText: fileResult.errorReason,
      recommendation: 'Re-upload a valid, parsable file (see error reason) so it can be classified and validated.',
    }]
  }

  return fileResult.results
    .filter(r => r.status === 'PARTIAL' || r.status === 'MISSING')
    .map(r => ({
      originalFileName: r.originalFileName,
      detectedDocType: r.detectedDocType,
      practiceArea: r.practiceArea,
      ruleId: r.ruleId,
      level: r.level,
      auditCheck: r.auditCheck,
      status: r.status,
      foundEvidence: r.foundEvidence,
      missingEvidence: r.missingEvidence,
      gapText: r.gapText,
      recommendation: r.recommendation,
    }))
}

// A rule is evaluated at project scope, not once per file. Multiple documents
// can jointly support an assertion, and a weak/empty copy of an artefact must
// not turn a control into a false gap when another accepted copy supports it.
function buildProjectRuleResults(allValidationResults) {
  const errors = allValidationResults.filter(result => result.status === 'ERROR').flatMap(buildEvidenceGapRows)
  const candidates = new Map()
  const rank = { NOT_APPLICABLE: -1, MISSING: 0, PARTIAL: 1, FOUND: 2 }

  for (const fileResult of allValidationResults) {
    if (fileResult.status === 'ERROR') continue
    for (const result of fileResult.results || []) {
      const current = candidates.get(result.ruleId)
      const score = rank[result.status] ?? -1
      if (!current) {
        candidates.set(result.ruleId, { ...result, sourceFiles: [result.originalFileName], sourceTypes: [result.detectedDocType], _rank: score })
        continue
      }
      current.sourceFiles = [...new Set([...current.sourceFiles, result.originalFileName])]
      current.sourceTypes = [...new Set([...current.sourceTypes, result.detectedDocType])]
      if (score > current._rank) {
        const provenance = { sourceFiles: current.sourceFiles, sourceTypes: current.sourceTypes }
        Object.assign(current, result, provenance, { _rank: score })
      }
    }
  }

  const rules = [...candidates.values()]
  const gateByPa = new Map(rules.filter(rule => rule.level === 'L1-Gate').map(rule => [rule.practiceArea, rule.status]))
  for (const rule of rules) {
    if (rule.level === 'L1-Gate' || !['MISSING', 'NOT_APPLICABLE'].includes(gateByPa.get(rule.practiceArea))) continue
    rule.status = 'BLOCKED'
    rule.foundEvidence = []
    rule.missingEvidence = ['Required gate artefact']
    rule.gapText = `Blocked: ${rule.gapText || 'The required gate artefact was not accepted.'}`
    rule.recommendation = 'Provide and classify the required gate artefact before assessing this downstream control.'
  }

  const normalized = rules.map(rule => ({
    ...rule,
    originalFileName: rule.sourceFiles.join('; '),
    detectedDocType: rule.sourceTypes.join('; '),
  }))
  return { rules: normalized, errors }
}

function emptyPaTally() {
  return { found: 0, partial: 0, missing: 0, total: 0 }
}

function buildGapSummary(allValidationResults, projectRules = []) {
  const summary = {
    totalFiles: allValidationResults.length,
    totalRulesChecked: 0,
    totalFound: 0,
    totalPartial: 0,
    totalMissing: 0,
    totalUnknown: 0,
    totalGaps: 0,
    byPracticeArea: {},
    byFile: {},
  }

  for (const fileResult of allValidationResults) {
    const gapCount = fileResult.partialCount + fileResult.missingCount
    summary.byFile[fileResult.originalFileName] = {
      detectedType: fileResult.detectedDocType,
      found: fileResult.foundCount,
      partial: fileResult.partialCount,
      missing: fileResult.missingCount,
      gapCount,
      status: fileResult.status === 'ERROR' ? 'ERROR' : 'OK',
    }

  }

  for (const rule of projectRules) {
    if (!summary.byPracticeArea[rule.practiceArea]) summary.byPracticeArea[rule.practiceArea] = emptyPaTally()
    const tally = summary.byPracticeArea[rule.practiceArea]
    tally.total += 1
    summary.totalRulesChecked += 1
    if (rule.status === 'FOUND') { tally.found += 1; summary.totalFound += 1 }
    else if (rule.status === 'PARTIAL') { tally.partial += 1; summary.totalPartial += 1 }
    else if (rule.status === 'MISSING' || rule.status === 'BLOCKED') { tally.missing += 1; summary.totalMissing += 1 }
    else if (rule.status === 'UNKNOWN') summary.totalUnknown += 1
  }

  summary.totalGaps = summary.totalPartial + summary.totalMissing
  return summary
}

// Returns { classificationReport, evidenceGapReport, gapSummary }.
export function generateGapReport(allValidationResults) {
  const projectEvaluation = buildProjectRuleResults(allValidationResults)
  return {
    classificationReport: allValidationResults.map(buildClassificationRow),
    evidenceGapReport: [
      ...projectEvaluation.errors,
      ...projectEvaluation.rules.filter(rule => ['PARTIAL', 'MISSING', 'BLOCKED'].includes(rule.status)),
    ],
    gapSummary: buildGapSummary(allValidationResults, projectEvaluation.rules),
  }
}
