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

function emptyPaTally() {
  return { found: 0, partial: 0, missing: 0, total: 0 }
}

function buildGapSummary(allValidationResults) {
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
    summary.totalRulesChecked += fileResult.totalRulesChecked
    summary.totalFound += fileResult.foundCount
    summary.totalPartial += fileResult.partialCount
    summary.totalMissing += fileResult.missingCount
    summary.totalUnknown += fileResult.unknownCount

    const gapCount = fileResult.partialCount + fileResult.missingCount
    summary.byFile[fileResult.originalFileName] = {
      detectedType: fileResult.detectedDocType,
      found: fileResult.foundCount,
      partial: fileResult.partialCount,
      missing: fileResult.missingCount,
      gapCount,
      status: fileResult.status === 'ERROR' ? 'ERROR' : 'OK',
    }

    for (const r of fileResult.results) {
      if (!summary.byPracticeArea[r.practiceArea]) summary.byPracticeArea[r.practiceArea] = emptyPaTally()
      const tally = summary.byPracticeArea[r.practiceArea]
      tally.total += 1
      if (r.status === 'FOUND') tally.found += 1
      else if (r.status === 'PARTIAL') tally.partial += 1
      else if (r.status === 'MISSING') tally.missing += 1
    }
  }

  summary.totalGaps = summary.totalPartial + summary.totalMissing
  return summary
}

// Returns { classificationReport, evidenceGapReport, gapSummary }.
export function generateGapReport(allValidationResults) {
  return {
    classificationReport: allValidationResults.map(buildClassificationRow),
    evidenceGapReport: allValidationResults.flatMap(buildEvidenceGapRows),
    gapSummary: buildGapSummary(allValidationResults),
  }
}
