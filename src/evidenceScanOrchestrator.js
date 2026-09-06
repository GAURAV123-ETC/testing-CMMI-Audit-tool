// ─── CMMI Audit Scan Orchestrator ───────────────────────────────────────────
//
// Top-level entry point wiring classifyDocument() (documentClassification
// Engine.js) -> validateEvidence() (evidenceValidationEngine.js) ->
// generateGapReport() (gapReportGenerator.js) across a batch of already
// text-extracted files (extraction itself is documentTextExtraction.js's
// job, upstream of this module).

import { classifyDocument } from './documentClassificationEngine'
import { validateEvidence } from './evidenceValidationEngine'
import { generateGapReport } from './gapReportGenerator'

// A file whose text extraction failed (status: 'ERROR', from
// documentTextExtraction.js via App.jsx) never reaches classifyDocument()/
// validateEvidence() — there is no content to classify or validate against.
// It still needs a fileResult of the same shape those two produce, so
// gapReportGenerator.js can fold it into all three reports untouched
// (Fix 1: no file may be silently dropped — it must show up with a red
// ERROR badge in Classification and be counted in the Gap Summary file
// total).
function buildErrorFileResult(file) {
  const errorReason = file.errorReason || 'Unknown error'
  return {
    originalFileName: file.fileName,
    // Format-level rejections (legacy .doc/.ppt) carry their own
    // detectedType/confidence ('Unsupported Format' / 'N/A') from
    // documentTextExtraction.js; every other extraction failure (corrupted
    // file, unrecognized extension, OCR failure) falls back to the generic
    // ERROR/Low pair.
    detectedDocType: file.detectedType || 'ERROR',
    confidence: file.confidence || 'Low',
    confidenceScore: 0,
    practiceAreas: [],
    totalRulesChecked: 0,
    foundCount: 0,
    partialCount: 0,
    missingCount: 0,
    unknownCount: 0,
    results: [],
    status: 'ERROR',
    errorReason,
    classificationReason: errorReason,
  }
}

// `uploadedFiles`: [{ fileName, text, structure?, status?, errorReason? }]. A file with
// status: 'ERROR' skips classification/validation entirely (see
// buildErrorFileResult above); everything else runs the normal pipeline.
// Returns { projectName, scanDate, reports: { classificationReport,
// evidenceGapReport, gapSummary } }.
export async function runCMMIAuditScan(uploadedFiles, projectName, ruleCatalog) {
  const allResults = []

  for (const file of uploadedFiles) {
    if (file.status === 'ERROR') {
      allResults.push(buildErrorFileResult(file))
      continue
    }
    const classification = classifyDocument(file.text, file.fileName, ruleCatalog, file.structure)
    const validation = validateEvidence(file.text, classification, ruleCatalog)
    // validateEvidence()'s return carries the confidence label but not the
    // numeric score — gapReportGenerator's classificationReport needs both,
    // so it's attached here rather than widening evidenceValidationEngine's
    // return shape for a field only the report layer needs.
    allResults.push({
      ...validation,
      confidenceScore: classification.confidenceScore,
      classificationReason: classification.classificationReason,
      reasonCodes: classification.reasonCodes,
      documentRole: classification.documentRole,
      status: 'OK',
    })
  }

  const reports = generateGapReport(allResults)

  return { projectName, scanDate: new Date(), ruleSetVersion: ruleCatalog?.ruleSetVersion, reports }
}
