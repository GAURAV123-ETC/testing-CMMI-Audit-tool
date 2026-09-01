// ─── AFR (Audit Findings Report) Generation — four sheets ──────────────────
//
// TAB 1: Audit Info            — Project Name, Date of Audit, Auditor Name,
//                                 Auditee Names only.
// TAB 2: PA Level Findings     — one summary row: Required (Core + selected
//                                 Domain + IRP) vs Available vs Missing
//                                 Practice Areas.
// TAB 3: Detailed Findings     — one row per real finding, consolidated
//                                 where the source itself consolidates
//                                 (never fabricated), collected from five
//                                 real sources:
//
//   Source 1 — PA-level availability (pkgAvailability, Stage 1, from
//     auditPackageEngine.js, lifted to App level).
//   Source 2 — Header/document-level compliance (paReports, Stage 2, from
//     validationEngine.js), consolidated to one finding per document.
//   Source 3 — IRP Incident Log data-row validation (irpDataValidation, from
//     irpDataValidation.js — Report Date vs Closure Date ordering,
//     duplicate Incident ID), consolidated to one finding per rule.
//   Source 4 — Full IRP Incident/RCA audit (irpAuditResult, from
//     incidentEngine.js/rcaEngine.js/irpAudit.js — Closed Date/Time, Issue
//     Category, Priority Matrix mismatch, Response/Resolution SLA breach,
//     RCA-missing-on-breach, RCA traceability), one row per finding, each
//     carrying its own Incident ID.
//   Source 5 — IRP Issue Log required-header compliance (irpIssueLog, from
//     irpIssueLogEngine.js's checkIrpIssueLog() — the exact same
//     fieldResults the PA Validation page's "Required Field / Detected
//     Header / Status / Remarks" table renders for IRP), consolidated to
//     one finding listing every missing header.
//
// Every Detailed Findings row carries an "Incident ID" column ('-' when
// not applicable) so IRP incident-level gaps are always traceable to the
// affected incident.
//
// TAB 4: Evidence Scan         — one row per document from the Folder-Based
//                                 Keyword & Evidence Scan (evidenceScanRows,
//                                 from evidenceScanEngine.js's
//                                 runEvidenceScan(), lifted from the
//                                 "Evidence Scan" tab to App level exactly
//                                 like pkgAvailability/paReports). Optional —
//                                 defaults to empty so every existing caller
//                                 keeps working unchanged (§ Requirement:
//                                 "Keep the existing QMM/CMMI functionality
//                                 unchanged"). Auto-included on every AFR
//                                 generation once a scan has run — no extra
//                                 trigger needed.
//
// Domain → Practice Area mapping (paCodesForSelection/paDisplayName) is
// imported from domainData.js — the same single source of truth already
// used by the PA Validation UI and Dashboard — never a second, hand-typed
// mapping. `docx` is imported dynamically (only when downloadAFRWord is
// actually called) to avoid bundling it into the initial page load.

import * as XLSX from 'xlsx'
import { paDisplayName, paCodesForSelection } from './domainData'
import { formatDateTime } from './irpDataValidation'
import { getIrpIncidentFindings } from './irpAudit'

export function sanitizeFilename(s) {
  const cleaned = String(s || '').trim().replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim()
  return cleaned || 'Untitled'
}

function metaValues(meta = {}) {
  return {
    projectName: meta.projectName || 'Not specified',
    auditDate: meta.auditDate || new Date().toLocaleDateString(),
    auditorsName: meta.auditorsName || 'Not specified',
    auditeesName: meta.auditeesName || 'Not specified',
  }
}

function auditInfoRows(meta) {
  const m = metaValues(meta)
  return [
    ['Project Name', m.projectName],
    ['Date of Audit', m.auditDate],
    ['Auditor Name', m.auditorsName],
    ['Auditee Names', m.auditeesName],
  ]
}

function metaCols(meta) {
  const m = metaValues(meta)
  return { 'Project Name': m.projectName, 'Date of Audit': m.auditDate, 'Auditor Name': m.auditorsName, 'Auditee Name': m.auditeesName, 'Incident ID': '-' }
}

// Required Practice Areas = Core Practice Areas + selected Domain(s)'
// Practice Areas (reusing paCodesForSelection — the exact same domain
// filter already used by the PA Validation page and Dashboard) + IRP, which
// is always in scope regardless of domain (consistent with its existing
// domain-independent treatment throughout the app — see domainData.js).
function requiredPACodes(selectedDomains) {
  return new Set([...paCodesForSelection(selectedDomains), 'IRP'])
}

function joinWithAnd(items) {
  const arr = [...items]
  if (arr.length === 0) return ''
  if (arr.length === 1) return arr[0]
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`
}

// ── PA Level Findings — a single summary row. Available Practice Areas
// come strictly from the actual Stage-1 scan (pkgAvailability) — never
// fabricated. When nothing has been scanned yet, Available/Missing say so
// explicitly rather than falsely declaring everything "Missing".
export function buildPALevelFindingsRow(pkgAvailability, selectedDomains, meta) {
  const m = metaValues(meta)
  const required = [...requiredPACodes(selectedDomains)].sort()
  const label = (code) => `${code} — ${paDisplayName(code)}`
  const scanned = pkgAvailability !== null && pkgAvailability !== undefined
  const available = scanned ? required.filter(code => pkgAvailability[code] === 'AVAILABLE') : []
  const missing = scanned ? required.filter(code => pkgAvailability[code] !== 'AVAILABLE') : []
  return {
    'Project Name': m.projectName,
    'Required Practice Areas': required.map(label).join(', ') || 'None',
    'Available Practice Areas': scanned ? (available.map(label).join(', ') || 'None') : 'Not yet assessed — no folder scanned',
    'Missing Practice Areas': scanned ? (missing.map(label).join(', ') || 'None') : 'Not yet assessed — no folder scanned',
    'Date of Audit': m.auditDate,
    'Auditee Name': m.auditeesName,
    'Auditor Name': m.auditorsName,
  }
}

// ── Detailed Findings, Source 1 — a required Practice Area's folder wasn't
// found at all (Stage-1 pkgAvailability), scoped to this audit's Required
// set only.
function paMissingFindingsRows(pkgAvailability, selectedDomains, meta) {
  if (!pkgAvailability) return []
  return [...requiredPACodes(selectedDomains)]
    .filter(code => pkgAvailability[code] !== 'AVAILABLE')
    .map(code => ({
      ...metaCols(meta),
      'Findings': `Required Practice Area ${code} is not available in the audited project repository.`,
      'CMMI Practice Areas': code,
      'Recommendations': `Provide and maintain the required ${code} evidence in the designated project repository.`,
      // Extra field, not part of DETAILED_FINDINGS_COLUMNS (ignored by the
      // Excel/Word export, whose fixed 8-column schema is unchanged) — used
      // only by the on-screen AFR report tab. A required Practice Area being
      // entirely absent is Critical everywhere else in this codebase (e.g.
      // "IRP folder not found", "Incident Log not found" — see irpAudit.js /
      // incidentEngine.js), so the same convention applies here.
      'Severity': 'Critical',
    }))
}

// ── Detailed Findings, Source 2 — document/header-level compliance
// (Stage 2 paReports). All missing headers for the same document are
// consolidated into ONE finding, never one row per header.
// Real severity, never fabricated: a wholly-missing document is Critical
// (same convention as paMissingFindingsRows above); a set of missing headers
// takes the highest severity actually present among them (each header's
// severity comes from the real checklist config — see validationEngine.js).
function highestHeaderSeverity(headers) {
  const sevs = new Set(headers.map(h => h.severity))
  if (sevs.has('critical')) return 'Critical'
  if (sevs.has('major')) return 'Major'
  return 'Minor'
}

function paHeaderGapFindingsRows(paReports, selectedDomains, meta) {
  const rows = []
  requiredPACodes(selectedDomains).forEach(code => {
    const report = paReports && paReports[code]
    if (!report) return
    if (!report.documentFound) {
      rows.push({
        ...metaCols(meta),
        'Findings': `Required document "${report.documentLabel}" was not found for Practice Area ${code}.`,
        'CMMI Practice Areas': code,
        'Recommendations': `Provide and maintain the required ${report.documentLabel} for ${code} and ensure it is available for audit verification.`,
        'Severity': 'Critical',
      })
      return
    }
    const missingHeaders = (report.headers || []).filter(h => h.status === 'FAIL')
    if (missingHeaders.length > 0) {
      rows.push({
        ...metaCols(meta),
        'Findings': `The following required headers are missing from the ${report.documentLabel}: ${joinWithAnd(missingHeaders.map(h => h.name))}.`,
        'CMMI Practice Areas': code,
        'Recommendations': `Add and maintain all required ${report.documentLabel} headers and ensure the updated document is available for audit verification.`,
        'Severity': highestHeaderSeverity(missingHeaders),
      })
    }
  })
  return rows
}

// ── Detailed Findings, Source 5 — IRP Issue Log required-header compliance
// (irpIssueLog.fieldResults, from irpIssueLogEngine.js's checkIrpIssueLog()
// Stage-1 header validation — the same data source of truth already
// rendered by the PA Validation page's "Required Field / Detected Header /
// Status / Remarks" table for IRP). Only fields whose Status is MISSING
// become findings (never AVAILABLE/NOT CHECKED/READ ERROR, which are not
// "missing header" gaps). All missing headers for the document are
// consolidated into ONE finding, mirroring paHeaderGapFindingsRows above.
// Severity: irpIssueLogEngine.js does not track a per-field severity (unlike
// the PA_CHECKLISTS header config consumed by Source 2), so a missing field
// on an otherwise-present document is rated Major — consistent with this
// file's own convention that only a wholly missing document/PA is Critical
// (see paMissingFindingsRows/highestHeaderSeverity above). Note: this is the
// sole surface for IRP header-presence gaps in AFR — irpAuditFindingsRows()
// (Source 4) deliberately excludes level==='header' findings from
// incidentEngine.js/rcaEngine.js to avoid duplicating this exact gap.
function irpIssueLogHeaderFindingsRows(irpIssueLog, selectedDomains, meta) {
  if (!irpIssueLog) return []
  if (!requiredPACodes(selectedDomains).has('IRP')) return []
  const missing = (irpIssueLog.fieldResults || []).filter(f => f.status === 'MISSING')
  if (missing.length === 0) return []
  const fieldNames = missing.map(f => f.field)
  return [{
    ...metaCols(meta),
    'Findings': `The following required headers are missing from the IRP Issue Log: ${joinWithAnd(fieldNames)}.`,
    'CMMI Practice Areas': 'IRP',
    'Recommendations': `Add and maintain the following required IRP Issue Log header(s) and ensure the updated document is available for audit verification: ${joinWithAnd(fieldNames)}.`,
    'Severity': 'Major',
  }]
}

// ── Detailed Findings, Source 3 — IRP Incident Log data-row validation
// (irpDataValidation.js). Multiple violations of the SAME rule are
// consolidated into one finding; the two rules stay as separate findings
// since they represent genuinely different issues (per spec).
function irpDataFindingsRows(irpDataValidation, selectedDomains, meta) {
  const rows = []
  if (!irpDataValidation || !irpDataValidation.supported) return rows
  if (!requiredPACodes(selectedDomains).has('IRP')) return rows

  const { dateOrderViolations = [], duplicateIds = [], invalidDateIds = [] } = irpDataValidation

  // Severities below match the same gap categories' severities elsewhere in
  // this codebase (incidentEngine.js): duplicate ID = Critical, invalid/
  // missing date = Major.
  if (dateOrderViolations.length === 1) {
    const v = dateOrderViolations[0]
    rows.push({
      ...metaCols(meta), 'Incident ID': v.id,
      'Findings': `Incident ID ${v.id} has a Closure Date earlier than its Report Date. Report Date is ${formatDateTime(v.reportDt)}, whereas Closure Date is ${formatDateTime(v.closureDt)}.`,
      'CMMI Practice Areas': 'IRP',
      'Recommendations': 'Verify and correct the Closure Date so that it is equal to or later than the Report Date and ensure accurate incident lifecycle dates are maintained.',
      'Severity': 'Major',
    })
  } else if (dateOrderViolations.length > 1) {
    rows.push({
      ...metaCols(meta), 'Incident ID': dateOrderViolations.map(v => v.id).join(', '),
      'Findings': `The following Incident IDs have a Closure Date earlier than their Report Date: ${joinWithAnd(dateOrderViolations.map(v => v.id))}.`,
      'CMMI Practice Areas': 'IRP',
      'Recommendations': 'Verify and correct the Closure Date for each listed incident so that it is equal to or later than its Report Date and ensure accurate incident lifecycle dates are maintained.',
      'Severity': 'Major',
    })
  }

  if (duplicateIds.length === 1) {
    rows.push({
      ...metaCols(meta), 'Incident ID': duplicateIds[0],
      'Findings': `Incident ID ${duplicateIds[0]} is duplicated in the Incident Log. Incident IDs are required to be unique.`,
      'CMMI Practice Areas': 'IRP',
      'Recommendations': 'Review the duplicate Incident ID entries, assign unique identifiers where applicable, and ensure Incident IDs remain unique across the Incident Log.',
      'Severity': 'Critical',
    })
  } else if (duplicateIds.length > 1) {
    rows.push({
      ...metaCols(meta), 'Incident ID': duplicateIds.join(', '),
      'Findings': `The following Incident IDs are duplicated in the Incident Log: ${joinWithAnd(duplicateIds)}.`,
      'CMMI Practice Areas': 'IRP',
      'Recommendations': 'Review the duplicate Incident ID entries, assign unique identifiers where applicable, and ensure Incident IDs remain unique across the Incident Log.',
      'Severity': 'Critical',
    })
  }

  if (invalidDateIds.length > 0) {
    const unique = [...new Set(invalidDateIds)]
    rows.push({
      ...metaCols(meta), 'Incident ID': unique.join(', '),
      'Findings': unique.length === 1
        ? `Incident ID ${unique[0]} has a missing or invalid Report Date / Closure Date value and could not be evaluated for date-order compliance.`
        : `The following Incident IDs have a missing or invalid Report Date / Closure Date value and could not be evaluated for date-order compliance: ${joinWithAnd(unique)}.`,
      'CMMI Practice Areas': 'IRP',
      'Recommendations': 'Ensure Report Date and Closure Date are populated with valid date/time values for every incident to enable accurate lifecycle validation.',
      'Severity': 'Major',
    })
  }

  return rows
}

// ── Detailed Findings, Source 4 — full IRP Incident/RCA audit
// (irpAuditResult, from incidentEngine.js/rcaEngine.js/irpAudit.js): Closed
// Date/Time, Issue Category, Priority Matrix mismatch, Response/Resolution
// SLA breach, RCA-missing-on-breach, and RCA traceability gaps. Excludes
// pure header-presence findings (level === 'header') since those duplicate
// the IRP Issue Log's own Stage-1 header-availability gap already
// surfaced via pkgAvailability/irpIssueLog. One row per finding — unlike
// Sources 1-3, these are inherently per-incident, and the spec requires the
// Incident ID to always be present so each row is independently actionable.
function irpAuditFindingsRows(irpAuditResult, selectedDomains, meta) {
  const rows = []
  if (!requiredPACodes(selectedDomains).has('IRP')) return rows

  const findings = getIrpIncidentFindings(irpAuditResult)

  findings.forEach(f => {
    rows.push({
      ...metaCols(meta), 'Incident ID': f.record || '-',
      'Findings': f.finding,
      'CMMI Practice Areas': 'IRP',
      'Recommendations': f.recommendation || '-',
      'Severity': f.severity,
    })
  })

  return rows
}

// Exported so the on-screen AFR report tab (App.jsx) can render the exact
// same real, per-finding rows the Excel/Word export downloads — reusing
// this single builder rather than a second, divergent finding-selection
// mechanism.
export function buildDetailedFindingsRows(pkgAvailability, paReportsMap, irpDataValidation, irpAuditResult, selectedDomains, meta, irpIssueLog = null) {
  return [
    ...paMissingFindingsRows(pkgAvailability, selectedDomains, meta),
    ...paHeaderGapFindingsRows(paReportsMap, selectedDomains, meta),
    ...irpIssueLogHeaderFindingsRows(irpIssueLog, selectedDomains, meta),
    ...irpDataFindingsRows(irpDataValidation, selectedDomains, meta),
    ...irpAuditFindingsRows(irpAuditResult, selectedDomains, meta),
  ]
}

// ── Evidence Scan sheet/section — formats evidenceScanEngine.js's
// runEvidenceScan() rows (keywordsExpected/Found/Missing as arrays) into
// the flat, joined-string shape the Excel/Word export needs. Exported so
// the on-screen AFR report tab (App.jsx) can render the exact same rows.
const EVIDENCE_SCAN_COLUMNS = ['Project', 'Document', 'Document Type', 'Practice Area', 'Keywords Expected', 'Keywords Found', 'Keywords Missing', 'Evidence Status']

export function buildEvidenceScanExportRows(evidenceScanRows = []) {
  return evidenceScanRows.map(r => ({
    'Project': r.project,
    'Document': r.document,
    'Document Type': r.documentType,
    'Practice Area': r.practiceArea,
    'Keywords Expected': (r.keywordsExpected || []).join(', '),
    'Keywords Found': (r.keywordsFound || []).join(', '),
    'Keywords Missing': (r.keywordsMissing || []).join(', '),
    'Evidence Status': r.evidenceStatus,
  }))
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const DETAILED_FINDINGS_COLUMNS = ['Project Name', 'Date of Audit', 'Auditor Name', 'Auditee Name', 'Incident ID', 'Findings', 'CMMI Practice Areas', 'Recommendations']

// Always generates and downloads a real .xlsx file — never a no-op. With
// zero findings it still produces a valid three-sheet workbook containing
// the real audit information and a clearly labeled "No findings available"
// notice — never fabricated data. Exactly three sheets: "Audit Info",
// "PA Level Findings", "Detailed Findings".
export function downloadAFRExcel(ctx = {}) {
  const { paReportsMap = {}, meta = {}, pkgAvailability = null, irpIssueLog = null, irpDataValidation = null, irpAuditResult = null, selectedDomains = [], evidenceScanRows = [] } = ctx
  const m = metaValues(meta)

  const paLevelRow = buildPALevelFindingsRow(pkgAvailability, selectedDomains, meta)
  const detailedRows = buildDetailedFindingsRows(pkgAvailability, paReportsMap, irpDataValidation, irpAuditResult, selectedDomains, meta, irpIssueLog)

  const wb = XLSX.utils.book_new()

  const infoSheet = XLSX.utils.aoa_to_sheet(auditInfoRows(meta))
  infoSheet['!cols'] = [18, 40].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, infoSheet, 'Audit Info')

  const paLevelSheet = XLSX.utils.json_to_sheet([paLevelRow])
  paLevelSheet['!cols'] = [20, 60, 60, 60, 16, 24, 20].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, paLevelSheet, 'PA Level Findings')

  // Explicit `header` option so every row renders the exact same column set
  // in the same order, regardless of which finding source(s) contributed
  // rows (some sources don't set every column — e.g. Incident ID defaults
  // to '-' for non-incident findings via metaCols()).
  const detailedSheet = detailedRows.length
    ? XLSX.utils.json_to_sheet(detailedRows, { header: DETAILED_FINDINGS_COLUMNS })
    : XLSX.utils.aoa_to_sheet([DETAILED_FINDINGS_COLUMNS, [m.projectName, m.auditDate, m.auditorsName, m.auditeesName, '-', 'No findings available for this audit.', '-', '-']])
  detailedSheet['!cols'] = [20, 16, 20, 20, 16, 70, 20, 60].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, detailedSheet, 'Detailed Findings')

  const evidenceScanExportRows = buildEvidenceScanExportRows(evidenceScanRows)
  const evidenceSheet = evidenceScanExportRows.length
    ? XLSX.utils.json_to_sheet(evidenceScanExportRows, { header: EVIDENCE_SCAN_COLUMNS })
    : XLSX.utils.aoa_to_sheet([EVIDENCE_SCAN_COLUMNS, ['No folder scanned yet.', '-', '-', '-', '-', '-', '-', '-']])
  evidenceSheet['!cols'] = [20, 28, 14, 14, 40, 40, 40, 16].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, evidenceSheet, 'Evidence Scan')

  const wbArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const blob = new Blob([wbArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  triggerBlobDownload(blob, `AFR_${sanitizeFilename(m.projectName)}_${sanitizeFilename(m.auditDate)}.xlsx`)
  return true
}

// Always generates and downloads a real .docx file — never a no-op. Mirrors
// the Excel structure: "Audit Info", "PA Level Findings", "Detailed
// Findings" as three top-level sections (docx has no literal "tab"
// concept — three headings are the direct equivalent).
export async function downloadAFRWord(ctx = {}) {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, WidthType } = await import('docx')

  const { paReportsMap = {}, meta = {}, pkgAvailability = null, irpIssueLog = null, irpDataValidation = null, irpAuditResult = null, selectedDomains = [], evidenceScanRows = [] } = ctx
  const m = metaValues(meta)

  const paLevelRow = buildPALevelFindingsRow(pkgAvailability, selectedDomains, meta)
  const detailedRows = buildDetailedFindingsRows(pkgAvailability, paReportsMap, irpDataValidation, irpAuditResult, selectedDomains, meta, irpIssueLog)
  const evidenceScanExportRows = buildEvidenceScanExportRows(evidenceScanRows)

  const kvTable = (rows) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([k, v]) => new TableRow({
      children: [
        new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: k, bold: true })] })] }),
        new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE }, children: [new Paragraph(String(v ?? ''))] }),
      ],
    })),
  })
  const headerRow = (cells) => new TableRow({
    tableHeader: true,
    children: cells.map(c => new TableCell({ shading: { fill: '185FA5' }, children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, color: 'FFFFFF' })] })] })),
  })
  const dataRow = (cells) => new TableRow({ children: cells.map(c => new TableCell({ children: [new Paragraph(String(c ?? ''))] })) })
  const noDataParagraph = (text) => new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text, italics: true })] })
  const gridTable = (columns, rows) => rows.length
    ? new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow(columns), ...rows.map(r => dataRow(columns.map(c => r[c])))] })
    : noDataParagraph('No findings available for this audit.')

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'CMMI Audit Findings Report (AFR)', heading: HeadingLevel.TITLE }),

        new Paragraph({ text: 'Audit Info', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
        kvTable(auditInfoRows(meta)),

        new Paragraph({ text: 'PA Level Findings', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
        kvTable([
          ['Project Name', paLevelRow['Project Name']],
          ['Required Practice Areas', paLevelRow['Required Practice Areas']],
          ['Available Practice Areas', paLevelRow['Available Practice Areas']],
          ['Missing Practice Areas', paLevelRow['Missing Practice Areas']],
          ['Date of Audit', paLevelRow['Date of Audit']],
          ['Auditee Name', paLevelRow['Auditee Name']],
          ['Auditor Name', paLevelRow['Auditor Name']],
        ]),

        new Paragraph({ text: 'Detailed Findings', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
        gridTable(DETAILED_FINDINGS_COLUMNS, detailedRows),

        new Paragraph({ text: 'Evidence Scan', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
        gridTable(EVIDENCE_SCAN_COLUMNS, evidenceScanExportRows),
      ],
    }],
  })

  const blob = await Packer.toBlob(doc)
  triggerBlobDownload(blob, `AFR_${sanitizeFilename(m.projectName)}_${sanitizeFilename(m.auditDate)}.docx`)
  return true
}
