// ─── Audit Folder & Document Availability Validation — Orchestrator ───────
//
// First-stage gate for the Audit Information / Validation page, run before
// any detailed Practice Area audit validation starts. Ties together:
//   - folderScanUtils   (recursive folder/file scan — any depth, any
//                         upload mechanism)
//   - practiceAreaRegistry (configurable expected-PA list)
//   - irpIssueLogEngine (IRP Issue Log detection + header availability)
//
// This module performs AVAILABILITY checks only (folders/documents/headers
// exist or don't) — no row-level data validation (SLA, RCA, 5-Why,
// priority/severity calculation, closure, etc.), per spec.

import { findFolderPathsForCode, filesUnderFolderPath } from './folderScanUtils'
import { EXPECTED_PRACTICE_AREAS } from './practiceAreaRegistry'
import { checkIrpIssueLog } from './irpIssueLogEngine'

// Step 3/4 — identify expected Practice Areas, check each recursively
// (any depth, never assumed to be root-only) against the scanned tree.
export function checkPracticeAreaAvailability(scan) {
  return EXPECTED_PRACTICE_AREAS.map(pa => {
    const matches = findFolderPathsForCode(scan, pa.code)
    const matched = matches[0] || null
    return {
      code: pa.code,
      name: pa.name,
      expectedFolder: pa.code,
      status: matched ? 'AVAILABLE' : 'MISSING',
      path: matched ? '/' + matched : null,
      allMatchedPaths: matches.map(m => '/' + m),
    }
  })
}

export function summarizePracticeAreaAvailability(paResults) {
  const total = paResults.length
  const available = paResults.filter(r => r.status === 'AVAILABLE').length
  const missing = total - available
  return {
    total, available, missing,
    availabilityPct: total ? Math.round((available / total) * 100) : 0,
    availableList: paResults.filter(r => r.status === 'AVAILABLE').map(r => r.code),
    missingList: paResults.filter(r => r.status === 'MISSING').map(r => r.code),
  }
}

// Step 6/7 — auditor-triggered (or, for IRP, automatic) recursive scan of
// one Practice Area's folder + generic evidence-availability check.
// Distinguishes an available-but-empty folder (§15: "Folder Status =
// AVAILABLE, Evidence Status = NO DOCUMENT FOUND") from a missing one.
export function drillDownPracticeArea(scan, paResult) {
  if (paResult.status !== 'AVAILABLE') {
    return { code: paResult.code, folderStatus: 'MISSING', evidenceStatus: null, fileCount: 0, files: [] }
  }
  const files = filesUnderFolderPath(scan, paResult.path.slice(1))
  return {
    code: paResult.code,
    folderStatus: 'AVAILABLE',
    evidenceStatus: files.length > 0 ? 'DOCUMENTS FOUND' : 'NO DOCUMENT FOUND',
    fileCount: files.length,
    files: files.map(f => ({ name: f.name, path: f.path.join('/') || '(root)' })),
  }
}

// Steps 3-13 combined: full first-stage audit package check. IRP's Issue
// Log + header validation is computed eagerly (alongside PA availability)
// since it's expected to be visible immediately on the initial dashboard;
// other Practice Areas use the on-demand drillDownPracticeArea() above when
// the auditor selects them.
export async function runAuditPackageCheck(scan, context = {}) {
  const practiceAreas = checkPracticeAreaAvailability(scan)
  const summary = summarizePracticeAreaAvailability(practiceAreas)

  const irpPA = practiceAreas.find(r => r.code === 'IRP')
  const irpFolder = irpPA ? drillDownPracticeArea(scan, irpPA) : { code: 'IRP', folderStatus: 'MISSING', evidenceStatus: null, fileCount: 0, files: [] }

  let irpIssueLog = null
  if (irpFolder.folderStatus === 'AVAILABLE') {
    const rawFiles = filesUnderFolderPath(scan, irpPA.path.slice(1))
    irpIssueLog = await checkIrpIssueLog(rawFiles, {
      auditId: context.auditId, practiceArea: 'IRP', folderPath: irpPA.path,
    })
  }

  return {
    folder: { rootName: scan.rootName, totalFolders: scan.totalFolders, totalFiles: scan.totalFiles, scanStatus: 'SCANNED' },
    practiceAreas,
    summary,
    irp: { ...irpFolder, issueLog: irpIssueLog },
  }
}
