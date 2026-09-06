// ─── Folder-Based Keyword & Evidence Scan Engine ───────────────────────────
//
// Scans a *parent* folder containing many project subfolders (e.g.
// Project_Documents/Project_Alpha, Project_Documents/Project_Beta, …) and,
// independently per project, classifies every supported document's content
// against the 4 Practice Area keyword lists in evidenceKeywords.js
// (IRP/PLAN/RSK/RDM). This is a different scan shape from
// auditPackageEngine.js (which validates a SINGLE project's PA-named folder
// tree for availability only) — this engine works off the same `scan`
// object produced by folderScanUtils.js (source-agnostic: local folder,
// GitHub, SharePoint, Google Drive all normalize to it), but groups by
// top-level folder = project instead of by PA-named folder.
//
// Split into pure/testable logic (matchKeywordsInText, classifyEvidence
// Status, assignPracticeArea, groupFilesByProject) + a thin I/O orchestrator
// (runEvidenceScan) — mirrors the existing textMatch.js (pure) vs.
// irpIssueLogEngine.js (I/O) split already used in this codebase.

import { extractDocumentText, terminateOcrWorker, getExt } from './documentTextExtraction'
import { EVIDENCE_KEYWORDS, EVIDENCE_SCAN_PA_CODES, EVIDENCE_FILENAME_HINTS } from './evidenceKeywords'
import { EXPECTED_PRACTICE_AREAS } from './practiceAreaRegistry'

export const SUPPORTED_EVIDENCE_EXTS = ['xlsx', 'xls', 'docx', 'pdf', 'png', 'jpg', 'jpeg']

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Case-insensitive, word-boundary keyword search — avoids "RCA" matching
// inside an unrelated longer word. Pure, no I/O.
export function matchKeywordsInText(text, keywords) {
  const normalized = text || ''
  const found = []
  const missing = []
  for (const kw of keywords || []) {
    const pattern = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i')
    if (pattern.test(normalized)) found.push(kw)
    else missing.push(kw)
  }
  return { found, missing }
}

export function classifyEvidenceStatus(found, expected) {
  if (!expected || expected.length === 0) return 'MISSING'
  if (!found || found.length === 0) return 'MISSING'
  if (found.length === expected.length) return 'FOUND'
  return 'PARTIAL'
}

// Picks the single best-matching Practice Area for a document: content
// (keyword hit count) is the primary signal per spec; filename is only a
// supporting/tie-break signal, never primary. Returns 'UNCLASSIFIED' when
// neither content nor filename gives any signal — the document is still
// reported (never silently dropped), just with no Practice Area assigned.
export function assignPracticeArea(fileName, text) {
  const matchesPerPA = {}
  for (const code of EVIDENCE_SCAN_PA_CODES) {
    matchesPerPA[code] = matchKeywordsInText(text, EVIDENCE_KEYWORDS[code]).found
  }

  const maxCount = Math.max(...EVIDENCE_SCAN_PA_CODES.map(c => matchesPerPA[c].length))
  const contentCandidates = EVIDENCE_SCAN_PA_CODES.filter(c => matchesPerPA[c].length === maxCount && maxCount > 0)

  if (contentCandidates.length === 1) {
    return { code: contentCandidates[0], matchesPerPA, source: 'content' }
  }

  // No single content winner — either a genuine tie among contentCandidates,
  // or zero hits everywhere (maxCount === 0). Fall back to a filename hint,
  // restricted to the tied candidates when there was a real content tie.
  const hintPool = contentCandidates.length > 1 ? contentCandidates : EVIDENCE_SCAN_PA_CODES
  const nameLower = (fileName || '').toLowerCase()
  const hinted = hintPool.find(code => (EVIDENCE_FILENAME_HINTS[code] || []).some(h => nameLower.includes(h)))
  if (hinted) return { code: hinted, matchesPerPA, source: 'filename' }

  if (contentCandidates.length > 1) return { code: contentCandidates[0], matchesPerPA, source: 'content-tie' }

  return { code: 'UNCLASSIFIED', matchesPerPA, source: 'none' }
}

export function practiceAreaDisplayName(code) {
  const pa = EXPECTED_PRACTICE_AREAS.find(p => p.code === code)
  return pa ? pa.name : code
}

// Groups scan.files by top-level folder segment = project. Top-level
// folders with zero files anywhere underneath (e.g. an empty Project_Beta)
// still get their own group via scan.folderPaths, with an empty files list
// — this is what makes an empty project independent of, and non-breaking
// for, other projects' results. A file with no folder segment at all (the
// user pointed the picker directly at a single project folder rather than
// its parent) is grouped under scan.rootName, treating the picked folder
// itself as the one project.
export function groupFilesByProject(scan) {
  const groups = new Map()
  const ensure = (name) => {
    if (!groups.has(name)) groups.set(name, { projectName: name, files: [] })
    return groups.get(name)
  }

  for (const p of scan.folderPaths || []) {
    const segments = p.split('/')
    if (segments.length === 1) ensure(segments[0])
  }

  for (const f of scan.files || []) {
    const projectName = f.path.length > 0 ? f.path[0] : (scan.rootName || 'Project')
    ensure(projectName).files.push(f)
  }

  return [...groups.values()]
}

async function buildDocumentRow(projectName, entry) {
  const ext = getExt(entry.name)
  const sourcePath = [...entry.path, entry.name].join('/')
  const extraction = await extractDocumentText(entry)

  if (extraction.unsupported) return null

  if (extraction.error) {
    return {
      project: projectName, document: entry.name, documentType: ext.toUpperCase(),
      practiceArea: 'UNCLASSIFIED', keywordsExpected: [], keywordsFound: [], keywordsMissing: [],
      evidenceStatus: 'MISSING', sourcePath, ocrUsed: false,
      note: `Could not read file: ${extraction.error}`,
    }
  }

  const { code } = assignPracticeArea(entry.name, extraction.text)
  const expected = code === 'UNCLASSIFIED' ? [] : EVIDENCE_KEYWORDS[code]
  const { found, missing } = matchKeywordsInText(extraction.text, expected)
  const status = code === 'UNCLASSIFIED' ? 'MISSING' : classifyEvidenceStatus(found, expected)

  return {
    project: projectName, document: entry.name, documentType: ext.toUpperCase(),
    practiceArea: code,
    keywordsExpected: expected, keywordsFound: found, keywordsMissing: missing,
    evidenceStatus: status, sourcePath, ocrUsed: !!extraction.ocrUsed,
    note: extraction.note || (code === 'UNCLASSIFIED' ? 'No Practice Area keywords detected in content or filename.' : undefined),
  }
}

// Main entry point. `scan` is the { rootName, folderPaths, files, ... }
// shape from folderScanUtils.js. `onProgress({ done, total, currentFile })`
// is called before/after each file so the UI can show a progress bar (OCR
// can take several seconds per file). Sequential (not Promise.all) so only
// one OCR job runs at a time. Never throws — a per-file failure is
// downgraded to a MISSING row with a note, rather than aborting the scan.
export async function runEvidenceScan(scan, { onProgress } = {}) {
  const groups = groupFilesByProject(scan)
  const supportedByGroup = groups.map(g => ({
    ...g, files: g.files.filter(f => SUPPORTED_EVIDENCE_EXTS.includes(getExt(f.name))),
  }))
  const total = supportedByGroup.reduce((sum, g) => sum + g.files.length, 0)
  let done = 0

  const rows = []
  for (const group of supportedByGroup) {
    if (group.files.length === 0) {
      rows.push({
        project: group.projectName, document: '(none)', documentType: '-', practiceArea: '-',
        keywordsExpected: [], keywordsFound: [], keywordsMissing: [], evidenceStatus: 'MISSING',
        sourcePath: null, ocrUsed: false, note: 'No documents found in this project folder.',
      })
      continue
    }

    for (const entry of group.files) {
      onProgress && onProgress({ done, total, currentFile: entry.name })
      try {
        const row = await buildDocumentRow(group.projectName, entry)
        if (row) rows.push(row)
      } catch (e) {
        rows.push({
          project: group.projectName, document: entry.name, documentType: getExt(entry.name).toUpperCase(),
          practiceArea: 'UNCLASSIFIED', keywordsExpected: [], keywordsFound: [], keywordsMissing: [],
          evidenceStatus: 'MISSING', sourcePath: [...entry.path, entry.name].join('/'), ocrUsed: false,
          note: `Could not process file: ${e.message}`,
        })
      }
      done += 1
      onProgress && onProgress({ done, total, currentFile: entry.name })
    }
  }

  await terminateOcrWorker()
  return { rows, scannedAt: new Date().toISOString() }
}

// ─── New MASTER-rule-based CMMI Audit Scan (Rule ID / Audit Check / Gap Text) ─
//
// Separate pipeline from runEvidenceScan() above — that one classifies
// documents against the 4-PA IRP/PLAN/RSK/RDM keyword lists in
// evidenceKeywords.js. This one classifies against the full
// DOCUMENT_TYPE_CONFIG (documentTypeConfig.js, all 33 Sheet5 document
// types) via documentClassificationEngine.js, then checks each classified
// document against the actual MASTER-sheet audit rules (ruleChecklist.js)
// via evidenceValidationEngine.js. Kept fully independent — neither engine
// nor its data files are touched by this addition.
//
// `uploadedFiles` must already be [{ fileName, text }] — text extraction
// (documentTextExtraction.js) happens upstream of this call, same as
// runEvidenceScan()'s callers extract via buildDocumentRow() above; this
// function is a thin pass-through into evidenceScanOrchestrator.js so the
// UI only needs one import site (this module) for both scan pipelines.
export async function runNewCMMIScan(uploadedFiles, projectName, ruleCatalog) {
  const { runCMMIAuditScan } = await import('./evidenceScanOrchestrator')
  return await runCMMIAuditScan(uploadedFiles, projectName, ruleCatalog)
}
