// ─── Gap Report Export (PDF + Excel) ───────────────────────────────────────
//
// Generic, config-driven: works for any Practice Area result produced by
// validationEngine.validatePracticeArea — no PA-specific code here.

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import { getRecommendationDetail } from './validationEngine'
import { daysBetween } from './ncEngine'
import { getIrpIncidentFindings } from './irpAudit'

const PALETTE = {
  red:        { text: [163, 45, 45],  bg: [252, 234, 234] },
  yellow:     { text: [122, 77, 15],  bg: [254, 243, 226] },
  blue:       { text: [24, 95, 165],  bg: [235, 243, 252] },
  green:      { text: [61, 107, 20],  bg: [235, 245, 224] },
  gray:       { text: [92, 92, 89],   bg: [244, 244, 242] },
}

function statusPalette(status) {
  if (status === 'Compliant') return PALETTE.green
  if (status === 'Partially Compliant') return PALETTE.yellow
  return PALETTE.red
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function ensureSpace(doc, y, needed, margin) {
  const pageHeight = doc.internal.pageSize.getHeight()
  if (y + needed > pageHeight - 50) {
    doc.addPage()
    return 40
  }
  return y
}

// Draws one Practice Area's full report onto the CURRENT page of `doc`,
// starting at y=40. Does not create the document, add pages up front, stamp
// footers, or save — callers own that so this can be reused standalone
// (single-PA export) or looped (combined multi-PA export).
function renderPAReportBody(doc, result, meta = {}) {
  const {
    auditName = 'CMMI Audit',
    projectName = 'CMMI Audit Project',
    auditorsName = 'Unassigned',
    auditeesName = 'Unassigned',
    auditDate = new Date().toLocaleDateString(),
  } = meta

  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 40
  let y = 40

  // ── Header: logo placeholder + title ──────────────────────────────────
  doc.setDrawColor(190); doc.setLineWidth(1)
  doc.rect(margin, y, 56, 56)
  doc.setFontSize(7); doc.setTextColor(150)
  doc.text('LOGO', margin + 28, y + 31, { align: 'center' })

  doc.setTextColor(20)
  doc.setFontSize(15); doc.setFont(undefined, 'bold')
  doc.text('CMMI Practice Area Gap Analysis Report', margin + 70, y + 18)
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
  doc.text(`${result.paCode} — ${result.paName}`, margin + 70, y + 34)
  doc.text('Prepared for CMMI Appraisal Readiness Review', margin + 70, y + 48)

  y += 74
  doc.setDrawColor(220); doc.setLineWidth(0.5)
  doc.line(margin, y, pageWidth - margin, y)
  y += 18

  // ── Metadata table ─────────────────────────────────────────────────────
  const metaRows = [
    ['Audit Name', auditName],
    ['Auditors Name', auditorsName],
    ['Auditees Name', auditeesName],
    ['Audit Date', auditDate],
    ['Project Name', projectName],
    ['Practice Area', `${result.paCode} — ${result.paName}`],
    ['Document Name', result.fileName || 'N/A'],
    ['Document Status', result.documentFound ? 'Found' : 'Missing Document'],
    ['Compliance %', `${result.compliancePct}%`],
    ['Overall Status', result.overallStatus],
  ]
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', textColor: [90, 90, 90], cellWidth: 130 }, 1: { textColor: [20, 20, 20] } },
    body: metaRows,
  })
  y = doc.lastAutoTable.finalY + 14

  // ── Executive summary ──────────────────────────────────────────────────
  doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('Executive Summary', margin, y); y += 14
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(60)
  const summaryText = result.documentFound
    ? `The ${result.documentLabel} for ${result.paCode} was reviewed against ${result.totalRequired} mandatory CMMI header fields, validated against the document's header row. ${result.foundCount} field(s) were found and ${result.missingCount} field(s) are missing, resulting in an overall compliance of ${result.compliancePct}% (${result.overallStatus}). ${result.missingCount > 0 ? 'Refer to the Detailed Gap Analysis and Recommendations sections below to close the identified gaps.' : 'No further action is required for this Practice Area at this time.'}`
    : `The required document "${result.documentLabel}" was not found in the ${result.paCode} Practice Area folder. Header-level field validation could not be performed as a result. This is recorded as a critical documentation gap that must be remediated before re-assessment.`
  const summaryLines = doc.splitTextToSize(summaryText, pageWidth - margin * 2)
  doc.text(summaryLines, margin, y)
  y += summaryLines.length * 11 + 14

  // ── Gap summary boxes ───────────────────────────────────────────────────
  const boxes = [
    ['Critical Gap Summary', result.criticalCount, PALETTE.red],
    ['Major Gap Summary', result.majorCount, PALETTE.yellow],
    ['Minor Gap Summary', result.minorCount, PALETTE.blue],
  ]
  const gap = 10
  const boxWidth = (pageWidth - margin * 2 - gap * 2) / 3
  const boxHeight = 48
  y = ensureSpace(doc, y, boxHeight + 10, margin)
  boxes.forEach(([label, count, palette], i) => {
    const bx = margin + i * (boxWidth + gap)
    doc.setFillColor(...palette.bg)
    doc.roundedRect(bx, y, boxWidth, boxHeight, 4, 4, 'F')
    doc.setTextColor(...palette.text)
    doc.setFontSize(17); doc.setFont(undefined, 'bold')
    doc.text(String(count), bx + boxWidth / 2, y + 22, { align: 'center' })
    doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
    doc.text(label, bx + boxWidth / 2, y + 38, { align: 'center' })
  })
  y += boxHeight + 20

  // ── Detailed Gap Analysis Table ─────────────────────────────────────────
  y = ensureSpace(doc, y, 30, margin)
  doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('Detailed Gap Analysis Table', margin, y)
  y += 8

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Field Name', 'Expected', 'Found', 'Severity', 'Status']],
    body: (result.headers || []).map(h => [h.name, h.expected, h.found, h.severity, h.status]),
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [24, 95, 165], textColor: 255, fontStyle: 'bold' },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 4) {
        const val = data.cell.raw
        const p = val === 'PASS' ? PALETTE.green : PALETTE.red
        data.cell.styles.textColor = p.text
        data.cell.styles.fontStyle = 'bold'
      }
      if (data.section === 'body' && data.row.raw[4] === 'FAIL') {
        data.cell.styles.fillColor = PALETTE.red.bg
      }
    },
  })
  y = doc.lastAutoTable.finalY + 18

  // ── Recommendations ─────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 30, margin)
  doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('Recommendations', margin, y)
  y += 14

  if (result.recommendations.length === 0) {
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(60)
    doc.text('All required headers are present. No recommendations are necessary.', margin, y)
    y += 16
  } else {
    result.recommendations.forEach((rec, i) => {
      const lines = doc.splitTextToSize(`${i + 1}. [${rec.severity.toUpperCase()}] ${rec.field} — ${rec.text}`, pageWidth - margin * 2)
      y = ensureSpace(doc, y, lines.length * 11 + 8, margin)
      doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(60)
      doc.text(lines, margin, y)
      y += lines.length * 11 + 8
    })
  }
  y += 10

  // ── Overall Audit Conclusion ────────────────────────────────────────────
  y = ensureSpace(doc, y, 50, margin)
  doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('Overall Audit Conclusion', margin, y)
  y += 14
  const palette = statusPalette(result.overallStatus)
  doc.setFillColor(...palette.bg)
  const conclusion = result.overallStatus === 'Compliant'
    ? `${result.paCode} is fully compliant with the mandatory CMMI header checklist. This Practice Area is considered audit-ready.`
    : result.overallStatus === 'Partially Compliant'
    ? `${result.paCode} is partially compliant (${result.compliancePct}%). Address the ${result.missingCount} outstanding gap(s) — prioritising Critical severity items — before the formal appraisal.`
    : `${result.paCode} is non-compliant (${result.compliancePct}%). Immediate remediation is required across ${result.missingCount} gap(s) to meet CMMI appraisal readiness.`
  const conclusionLines = doc.splitTextToSize(conclusion, pageWidth - margin * 2 - 16)
  const boxH = conclusionLines.length * 12 + 16
  doc.roundedRect(margin, y, pageWidth - margin * 2, boxH, 4, 4, 'F')
  doc.setTextColor(...palette.text)
  doc.setFontSize(9); doc.setFont(undefined, 'normal')
  doc.text(conclusionLines, margin + 10, y + 16)
}

// Page 1 of the combined, all-Practice-Area report: audit metadata only.
function renderAuditInfoPage(doc, paReportsMap, meta = {}) {
  const {
    auditName = 'CMMI Audit',
    projectName = 'CMMI Audit Project',
    auditorsName = 'Unassigned',
    auditeesName = 'Unassigned',
    auditDate = new Date().toLocaleDateString(),
  } = meta
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 40
  let y = 40

  doc.setDrawColor(190); doc.setLineWidth(1)
  doc.rect(margin, y, 56, 56)
  doc.setFontSize(7); doc.setTextColor(150)
  doc.text('LOGO', margin + 28, y + 31, { align: 'center' })

  doc.setTextColor(20)
  doc.setFontSize(16); doc.setFont(undefined, 'bold')
  doc.text('CMMI Gap Analysis — Consolidated Report', margin + 70, y + 20)
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
  doc.text(`All validated Practice Areas as of ${auditDate}`, margin + 70, y + 38)
  doc.text('Prepared for CMMI Appraisal Readiness Review', margin + 70, y + 52)

  y += 80
  doc.setDrawColor(220); doc.setLineWidth(0.5)
  doc.line(margin, y, pageWidth - margin, y)
  y += 18

  doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('Audit Info', margin, y)
  y += 8

  const metaRows = [
    ['Audit Name', auditName],
    ['Auditors Name', auditorsName],
    ['Auditees Name', auditeesName],
    ['Audit Date', auditDate],
    ['Project Name', projectName],
    ['Practice Areas Validated', String(Object.keys(paReportsMap).length)],
  ]
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', textColor: [90, 90, 90], cellWidth: 160 }, 1: { textColor: [20, 20, 20] } },
    body: metaRows,
  })
}

// Page 2: one row per validated Practice Area so a reader can see every PA's
// standing before the Combined Findings detail that follows.
function renderSummaryPage(doc, paReportsMap) {
  const margin = 40
  let y = 40

  doc.setFontSize(15); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('Summary', margin, y)
  y += 10
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
  doc.text('Practice Area Summary', margin, y)
  y += 14

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['PA Code', 'Practice Area', 'Document', 'Critical', 'Major', 'Minor', 'Compliance %', 'Status']],
    body: Object.values(paReportsMap).map(r => [
      r.paCode, r.paName, r.documentFound ? 'Found' : 'Missing',
      r.criticalCount, r.majorCount, r.minorCount, `${r.compliancePct}%`, r.overallStatus,
    ]),
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [24, 95, 165], textColor: 255, fontStyle: 'bold' },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 7) {
        const p = statusPalette(data.cell.raw)
        data.cell.styles.textColor = p.text
        data.cell.styles.fontStyle = 'bold'
      }
    },
  })
}

// Page 3+: ONE continuous Combined Findings table spanning every validated
// Practice Area instead of a separate full page per PA.
// `Finding Type` (the PA code) distinguishes records; `Practice Area` — the
// same CMMI V3.0 name already produced by validatePracticeArea() — is always
// the last column.
function renderCombinedFindingsPage(doc, paReportsMap) {
  const margin = 40
  let y = 40

  doc.setFontSize(15); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('Combined Findings', margin, y)
  y += 10
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
  doc.text('All validated Practice Area findings, in one table.', margin, y)
  y += 14

  const rows = []
  Object.keys(paReportsMap).forEach(code => {
    const r = paReportsMap[code]
    const recByField = Object.fromEntries((r.recommendations || []).map(rec => [rec.field, rec.text]))
    ;(r.headers || []).forEach(h => {
      rows.push([
        code, h.name, h.severity, h.expected, h.found, h.status,
        h.status === 'FAIL' ? (recByField[h.name] || '') : '',
        `${code} — ${r.paName}`,
      ])
    })
  })

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Finding Type', 'Header Name', 'Severity', 'Expected', 'Found', 'Gap Status', 'Recommendation', 'Practice Area']],
    body: rows,
    styles: { fontSize: 7, cellPadding: 4 },
    headStyles: { fillColor: [24, 95, 165], textColor: 255, fontStyle: 'bold' },
    columnStyles: { 6: { cellWidth: 150 } },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 5) {
        const p = data.cell.raw === 'PASS' ? PALETTE.green : PALETTE.red
        data.cell.styles.textColor = p.text
        data.cell.styles.fontStyle = 'bold'
      }
      if (data.section === 'body' && data.row.raw[5] === 'FAIL') data.cell.styles.fillColor = PALETTE.red.bg
    },
  })
}

// Page 4 (when present): IRP incident-level findings — Closed Date/Time,
// Issue Category, Priority Matrix mismatch, Response/Resolution SLA
// breach, RCA-missing-on-breach, RCA traceability. Reuses the exact same
// irpAuditResult findings (via getIrpIncidentFindings — see irpAudit.js)
// already surfaced on the Dashboard, the on-screen Gap Analysis section,
// and the AFR — never a second, independently-derived validation pass.
function renderIrpIncidentFindingsPage(doc, irpAuditResult) {
  const findings = getIrpIncidentFindings(irpAuditResult)
  if (findings.length === 0) return

  const margin = 40
  let y = 40

  doc.setFontSize(15); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
  doc.text('IRP Incident Findings', margin, y)
  y += 10
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
  doc.text('Incident/RCA-level gaps from the IRP Incident Log and RCA register — Priority, SLA, RCA, Closed Date/Time, Issue Category.', margin, y)
  y += 14

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Incident ID', 'Gap Type', 'Finding', 'Actual', 'Expected', 'Severity', 'Status', 'Document/Sheet', 'Recommendation']],
    body: findings.map(f => [
      f.record || '-', f.meta?.gapType || f.field, f.finding, f.actual ?? '-', f.expected ?? '-', f.severity, 'Gap',
      f.sheet && f.sheet !== f.evidence ? `${f.evidence} / ${f.sheet}` : (f.evidence || '-'),
      f.recommendation || '-',
    ]),
    styles: { fontSize: 7, cellPadding: 4 },
    headStyles: { fillColor: [24, 95, 165], textColor: 255, fontStyle: 'bold' },
    columnStyles: { 2: { cellWidth: 130 }, 8: { cellWidth: 100 } },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 5) {
        const val = data.cell.raw
        const p = val === 'Critical' ? PALETTE.red : val === 'Major' ? PALETTE.yellow : PALETTE.blue
        data.cell.styles.textColor = p.text
        data.cell.styles.fontStyle = 'bold'
      }
      if (data.section === 'body' && data.column.index === 6) {
        data.cell.styles.textColor = PALETTE.red.text
        data.cell.styles.fontStyle = 'bold'
      }
    },
  })
}

function stampFooters(doc) {
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 40
  const totalPages = doc.internal.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    const pageHeight = doc.internal.pageSize.getHeight()
    doc.setDrawColor(220); doc.line(margin, pageHeight - 34, pageWidth - margin, pageHeight - 34)
    doc.setFontSize(8); doc.setTextColor(140)
    doc.text('CMMI Audit Platform — Confidential', margin, pageHeight - 20)
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 20, { align: 'right' })
  }
}

export function downloadGapReportPDF(result, meta = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  renderPAReportBody(doc, result, meta)
  stampFooters(doc)
  doc.save(`${result.paCode}_Gap_Analysis_Report_${todayStr()}.pdf`)
}

// Combined report: a cover summary page followed by one full page (or more,
// if content overflows) per validated Practice Area. Used by the Dashboard's
// "Download Report" button, which covers every PA validated so far.
// `irpAuditResult` (optional, backward compatible) adds a 4th page of
// incident-level IRP findings when present — see renderIrpIncidentFindingsPage.
export function downloadCombinedGapReportPDF(paReportsMap, meta = {}, irpAuditResult = null) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  renderAuditInfoPage(doc, paReportsMap, meta)
  doc.addPage()
  renderSummaryPage(doc, paReportsMap)
  doc.addPage()
  renderCombinedFindingsPage(doc, paReportsMap)
  if (getIrpIncidentFindings(irpAuditResult).length > 0) {
    doc.addPage()
    renderIrpIncidentFindingsPage(doc, irpAuditResult)
  }
  stampFooters(doc)
  doc.save(`CMMI_Gap_Analysis_Report_${todayStr()}.pdf`)
}

// Comprehensive single-PA audit report used by the PA Validation page's
// "Export Report" button. Includes the Audit Findings / Non-Conformity
// material that the simpler downloadGapReportPDF does not — Executive
// Summary, PA Information, Compliance Summary, Gap Summary, Audit Findings
// Summary, NC Summary, Open/Closed NC lists, Detailed Gap Table,
// structured Recommendations, Auditor Remarks, and Overall Conclusion.
export function downloadAuditFindingsReportPDF(result, ncRecords = [], meta = {}) {
  const {
    auditName = 'CMMI Audit',
    projectName = 'CMMI Audit Project',
    auditorsName = 'Unassigned',
    auditeesName = 'Unassigned',
    auditDate = new Date().toLocaleDateString(),
    auditorRemarks = '',
  } = meta

  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 40
  let y = 40

  const openNC = ncRecords.filter(r => r.status === 'Open')
  const closedNC = ncRecords.filter(r => r.status === 'Closed')
  const criticalNC = ncRecords.filter(r => r.severity === 'critical').length
  const majorNC = ncRecords.filter(r => r.severity === 'major').length
  const minorNC = ncRecords.filter(r => r.severity === 'minor').length

  const heading = (title) => {
    y = ensureSpace(doc, y, 30, margin)
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
    doc.text(title, margin, y)
    y += 12
  }
  const paragraph = (text) => {
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(60)
    const lines = doc.splitTextToSize(text, pageWidth - margin * 2)
    y = ensureSpace(doc, y, lines.length * 11 + 8, margin)
    doc.text(lines, margin, y)
    y += lines.length * 11 + 14
  }
  const statBoxRow = (boxes) => {
    const gap = 8
    const boxWidth = (pageWidth - margin * 2 - gap * (boxes.length - 1)) / boxes.length
    const boxHeight = 42
    y = ensureSpace(doc, y, boxHeight + 10, margin)
    boxes.forEach(([label, count, palette], i) => {
      const bx = margin + i * (boxWidth + gap)
      doc.setFillColor(...palette.bg)
      doc.roundedRect(bx, y, boxWidth, boxHeight, 4, 4, 'F')
      doc.setTextColor(...palette.text)
      doc.setFontSize(14); doc.setFont(undefined, 'bold')
      doc.text(String(count), bx + boxWidth / 2, y + 19, { align: 'center' })
      doc.setFontSize(7); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
      doc.text(label, bx + boxWidth / 2, y + 33, { align: 'center' })
    })
    y += boxHeight + 18
  }

  // ── Header ───────────────────────────────────────────────────────────
  doc.setDrawColor(190); doc.setLineWidth(1)
  doc.rect(margin, y, 56, 56)
  doc.setFontSize(7); doc.setTextColor(150)
  doc.text('LOGO', margin + 28, y + 31, { align: 'center' })
  doc.setTextColor(20)
  doc.setFontSize(15); doc.setFont(undefined, 'bold')
  doc.text('CMMI V3.0 Audit Findings Report', margin + 70, y + 18)
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(90)
  doc.text(`${result.paCode} — ${result.paName}`, margin + 70, y + 34)
  doc.text('Findings, Non-Conformities & Recommendations', margin + 70, y + 48)
  y += 74
  doc.setDrawColor(220); doc.setLineWidth(0.5)
  doc.line(margin, y, pageWidth - margin, y)
  y += 18

  // ── Audit & Practice Area Information ───────────────────────────────────
  heading('Practice Area Information')
  autoTable(doc, {
    startY: y, margin: { left: margin, right: margin }, theme: 'plain',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', textColor: [90, 90, 90], cellWidth: 150 }, 1: { textColor: [20, 20, 20] } },
    body: [
      ['Audit Name', auditName],
      ['Auditors Name', auditorsName],
      ['Auditees Name', auditeesName],
      ['Audit Date', auditDate],
      ['Project Name', projectName],
      ['Practice Area', `${result.paCode} — ${result.paName}`],
      ['Required Document', result.documentLabel],
      ['Document Name', result.fileName || 'N/A'],
      ['Document Status', result.documentFound ? 'Found' : 'Missing Document'],
    ],
  })
  y = doc.lastAutoTable.finalY + 16

  // ── Executive Summary ───────────────────────────────────────────────────
  heading('Executive Summary')
  paragraph(result.documentFound
    ? `The ${result.documentLabel} for ${result.paCode} was reviewed against ${result.totalRequired} mandatory CMMI header fields. ${result.foundCount} field(s) were found and ${result.missingCount} field(s) are missing, resulting in an overall compliance of ${result.compliancePct}% (${result.overallStatus}). This audit raised ${ncRecords.length} Non-Conformit${ncRecords.length === 1 ? 'y' : 'ies'} against this Practice Area, of which ${openNC.length} remain open and ${closedNC.length} have been closed.`
    : `The required document "${result.documentLabel}" was not found in the ${result.paCode} Practice Area folder. All ${result.totalRequired} mandatory header fields are recorded as open Non-Conformities pending upload of the required document.`)

  // ── Compliance Summary ──────────────────────────────────────────────────
  heading('Compliance Summary')
  autoTable(doc, {
    startY: y, margin: { left: margin, right: margin }, theme: 'plain',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', textColor: [90, 90, 90], cellWidth: 150 }, 1: { textColor: [20, 20, 20] } },
    body: [
      ['Total Required Headers', String(result.totalRequired)],
      ['Headers Found', String(result.foundCount)],
      ['Headers Missing', String(result.missingCount)],
      ['Compliance %', `${result.compliancePct}%`],
      ['Overall Status', result.overallStatus],
    ],
  })
  y = doc.lastAutoTable.finalY + 16

  // ── Gap Summary ──────────────────────────────────────────────────────────
  heading('Gap Summary')
  statBoxRow([
    ['Critical Gaps', result.criticalCount, PALETTE.red],
    ['Major Gaps', result.majorCount, PALETTE.yellow],
    ['Minor Gaps', result.minorCount, PALETTE.blue],
  ])

  // ── Audit Findings Summary ──────────────────────────────────────────────
  heading('Audit Findings Summary')
  statBoxRow([
    ['Total Findings', ncRecords.length, PALETTE.gray],
    ['Total NC', ncRecords.length, PALETTE.gray],
    ['Open NC', openNC.length, PALETTE.red],
    ['Closed NC', closedNC.length, PALETTE.green],
  ])
  statBoxRow([
    ['Critical NC', criticalNC, PALETTE.red],
    ['Major NC', majorNC, PALETTE.yellow],
    ['Minor NC', minorNC, PALETTE.blue],
    ['Compliance %', `${result.compliancePct}%`, statusPalette(result.overallStatus)],
  ])

  // ── NC Summary ───────────────────────────────────────────────────────────
  heading('NC Summary')
  autoTable(doc, {
    startY: y, margin: { left: margin, right: margin },
    head: [['NC ID', 'Field Name', 'Severity', 'Status', 'Owner', 'Target Date']],
    body: ncRecords.map(r => [r.ncId, r.fieldName, r.severity, r.status, r.owner, new Date(r.targetDate).toLocaleDateString()]),
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [24, 95, 165], textColor: 255, fontStyle: 'bold' },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 3) {
        const p = data.cell.raw === 'Open' ? PALETTE.red : PALETTE.green
        data.cell.styles.textColor = p.text
        data.cell.styles.fontStyle = 'bold'
      }
    },
  })
  y = ncRecords.length ? doc.lastAutoTable.finalY + 16 : y + 4

  // ── Open NC List ─────────────────────────────────────────────────────────
  heading('Open Non-Conformities')
  if (openNC.length === 0) {
    paragraph('No open Non-Conformities.')
  } else {
    autoTable(doc, {
      startY: y, margin: { left: margin, right: margin },
      head: [['NC ID', 'Missing Field', 'Severity', 'Owner', 'Target Date', 'Days Pending']],
      body: openNC.map(r => [r.ncId, r.fieldName, r.severity, r.owner, new Date(r.targetDate).toLocaleDateString(), String(daysBetween(r.firstDetectedAt))]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [163, 45, 45], textColor: 255, fontStyle: 'bold' },
    })
    y = doc.lastAutoTable.finalY + 16
  }

  // ── Closed NC List ───────────────────────────────────────────────────────
  heading('Closed Non-Conformities')
  if (closedNC.length === 0) {
    paragraph('No closed Non-Conformities.')
  } else {
    autoTable(doc, {
      startY: y, margin: { left: margin, right: margin },
      head: [['NC ID', 'Resolved Field', 'Severity', 'Closed By', 'Closed Date']],
      body: closedNC.map(r => [r.ncId, r.fieldName, r.severity, r.closedBy, r.closedAt ? new Date(r.closedAt).toLocaleDateString() : '']),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [61, 107, 20], textColor: 255, fontStyle: 'bold' },
    })
    y = doc.lastAutoTable.finalY + 16
  }

  // ── Detailed Gap Table ───────────────────────────────────────────────────
  if (result.documentFound) {
    heading('Detailed Gap Table')
    autoTable(doc, {
      startY: y, margin: { left: margin, right: margin },
      head: [['Field Name', 'Expected', 'Found', 'Severity', 'Status']],
      body: (result.headers || []).map(h => [h.name, h.expected, h.found, h.severity, h.status]),
      styles: { fontSize: 8, cellPadding: 5 },
      headStyles: { fillColor: [24, 95, 165], textColor: 255, fontStyle: 'bold' },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 4) {
          const p = data.cell.raw === 'PASS' ? PALETTE.green : PALETTE.red
          data.cell.styles.textColor = p.text
          data.cell.styles.fontStyle = 'bold'
        }
        if (data.section === 'body' && data.row.raw[4] === 'FAIL') data.cell.styles.fillColor = PALETTE.red.bg
      },
    })
    y = doc.lastAutoTable.finalY + 16
  }

  // ── Recommendations (structured: why / action / evidence) ──────────────
  heading('Recommendations')
  if (result.recommendations.length === 0) {
    paragraph('All required headers are present. No recommendations are necessary.')
  } else {
    result.recommendations.forEach((rec, i) => {
      const detail = getRecommendationDetail(result.paCode, rec.field) || {}
      y = ensureSpace(doc, y, 20, margin)
      doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(20)
      doc.text(`${i + 1}. ${rec.field}  [${rec.severity.toUpperCase()}]`, margin, y)
      y += 12
      const rows = [
        ['Why (CMMI)', detail.why || ''],
        ['Corrective Action', detail.correctiveAction || ''],
        ['Expected Evidence', detail.expectedEvidence || ''],
      ]
      rows.forEach(([label, text]) => {
        doc.setFontSize(8); doc.setFont(undefined, 'bold'); doc.setTextColor(90)
        const lines = doc.splitTextToSize(text, pageWidth - margin * 2 - 100)
        y = ensureSpace(doc, y, lines.length * 10 + 4, margin)
        doc.text(label + ':', margin + 8, y)
        doc.setFont(undefined, 'normal'); doc.setTextColor(60)
        doc.text(lines, margin + 100, y)
        y += lines.length * 10 + 4
      })
      y += 8
    })
  }

  // ── Auditor Remarks ──────────────────────────────────────────────────────
  heading('Auditor Remarks')
  paragraph(auditorRemarks?.trim()
    ? auditorRemarks
    : `No additional remarks recorded by the auditor. Findings above reflect an automated header-row validation against the CMMI ${result.paCode} checklist.`)

  // ── Overall Conclusion ───────────────────────────────────────────────────
  heading('Overall Conclusion')
  const palette = statusPalette(result.overallStatus)
  const conclusion = result.overallStatus === 'Compliant'
    ? `${result.paCode} is fully compliant with the mandatory CMMI header checklist. All Non-Conformities are closed. This Practice Area is considered audit-ready.`
    : result.overallStatus === 'Partially Compliant'
    ? `${result.paCode} is partially compliant (${result.compliancePct}%). ${openNC.length} Non-Conformit${openNC.length === 1 ? 'y remains' : 'ies remain'} open — prioritise Critical severity items before the formal appraisal.`
    : `${result.paCode} is non-compliant (${result.compliancePct}%). ${openNC.length} Non-Conformit${openNC.length === 1 ? 'y is' : 'ies are'} open. Immediate remediation is required to meet CMMI appraisal readiness.`
  const conclusionLines = doc.splitTextToSize(conclusion, pageWidth - margin * 2 - 16)
  const boxH = conclusionLines.length * 12 + 16
  y = ensureSpace(doc, y, boxH, margin)
  doc.setFillColor(...palette.bg)
  doc.roundedRect(margin, y, pageWidth - margin * 2, boxH, 4, 4, 'F')
  doc.setTextColor(...palette.text)
  doc.setFontSize(9); doc.setFont(undefined, 'normal')
  doc.text(conclusionLines, margin + 10, y + 16)

  stampFooters(doc)
  doc.save(`${result.paCode}_Audit_Report_${todayStr()}.pdf`)
}

// Sheet 3: one row per checklist header-field per validated Practice Area
// (across all configured PAs), combined into a single "Combined Findings"
// sheet instead of one sheet per PA. `Finding Type` (the PA code) tells the
// records apart; `Practice Area` — the existing per-PA name from
// validatePracticeArea(), the same CMMI V3.0 Practice Area mapping used
// everywhere else in the app — is always the LAST column.
function buildCombinedFindingsRows(paReportsMap, meta) {
  const { auditorsName = 'Unassigned', auditeesName = 'Unassigned', auditDate = new Date().toLocaleDateString(), projectName = 'CMMI Audit Project' } = meta
  const rows = []
  Object.keys(paReportsMap).forEach(code => {
    const r = paReportsMap[code]
    const recByField = Object.fromEntries((r.recommendations || []).map(rec => [rec.field, rec.text]))
    ;(r.headers || []).forEach((h, i) => {
      rows.push({
        'Finding Type': code,
        'Auditors Name': auditorsName,
        'Auditees Name': auditeesName,
        'Audit Date': auditDate,
        'Project Name': projectName,
        'Header Name': h.name,
        'Severity': h.severity,
        'Expected': h.expected,
        'Found': h.found,
        'Gap Status': h.status,
        'Recommendation': h.status === 'FAIL' ? (recByField[h.name] || '') : '',
        'Compliance %': i === 0 ? `${r.compliancePct}% (${r.overallStatus})` : '',
        'Practice Area': `${code} — ${r.paName}`,
      })
    })
  })
  return rows
}

// Sheet 4: one row per IRP incident-level finding (Closed Date/Time, Issue
// Category, Priority Matrix mismatch, Response/Resolution SLA breach,
// RCA-missing-on-breach, RCA traceability) — reuses getIrpIncidentFindings
// (irpAudit.js), the same filter already used by the Dashboard, on-screen
// Gap Analysis section, and the AFR, so all surfaces stay consistent.
function buildIrpIncidentFindingsRows(irpAuditResult, meta) {
  const { auditorsName = 'Unassigned', auditeesName = 'Unassigned', auditDate = new Date().toLocaleDateString(), projectName = 'CMMI Audit Project' } = meta
  return getIrpIncidentFindings(irpAuditResult).map(f => ({
    'Incident ID': f.record || '-',
    'Auditors Name': auditorsName,
    'Auditees Name': auditeesName,
    'Audit Date': auditDate,
    'Project Name': projectName,
    'Gap Type': f.meta?.gapType || f.field,
    'Finding': f.finding,
    'Actual': f.actual ?? '-',
    'Expected': f.expected ?? '-',
    'Severity': f.severity,
    'Status': 'Gap',
    'Document/Sheet': f.sheet && f.sheet !== f.evidence ? `${f.evidence} / ${f.sheet}` : (f.evidence || '-'),
    'Recommendation': f.recommendation || '-',
    'Practice Area': 'IRP',
  }))
}

// `irpAuditResult` (optional, backward compatible) adds a 4th "IRP Incident
// Findings" sheet when present — same incident-level findings surfaced on
// the Dashboard, the on-screen Gap Analysis section, and the AFR.
export function downloadGapReportExcel(paReportsMap, meta = {}, irpAuditResult = null) {
  const {
    auditName = 'CMMI Audit',
    projectName = 'CMMI Audit Project',
    auditorsName = 'Unassigned',
    auditeesName = 'Unassigned',
    auditDate = new Date().toLocaleDateString(),
  } = meta

  const wb = XLSX.utils.book_new()
  const codes = Object.keys(paReportsMap)

  // ── Sheet 1: Audit Info ────────────────────────────────────────────────
  const infoSheet = XLSX.utils.aoa_to_sheet([
    ['CMMI V3.0 Audit Findings Report'],
    [],
    ['Audit Name', auditName],
    ['Auditors Name', auditorsName],
    ['Auditees Name', auditeesName],
    ['Audit Date', auditDate],
    ['Project Name', projectName],
  ])
  infoSheet['!cols'] = [20, 40].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, infoSheet, 'Audit Info')

  // ── Sheet 2: Summary ───────────────────────────────────────────────────
  const summaryRows = codes.map(code => {
    const r = paReportsMap[code]
    return {
      'PA Code': code,
      'Practice Area': r.paName,
      'Document': r.fileName || 'N/A',
      'Document Status': r.documentFound ? 'Found' : 'Missing Document',
      'Total Required Headers': r.totalRequired,
      'Headers Found': r.foundCount,
      'Headers Missing': r.missingCount,
      'Critical Gaps': r.criticalCount,
      'Major Gaps': r.majorCount,
      'Minor Gaps': r.minorCount,
      'Compliance %': r.compliancePct,
      'Overall Status': r.overallStatus,
    }
  })
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows)
  summarySheet['!cols'] = [8, 32, 24, 16, 14, 12, 14, 12, 10, 10, 12, 18].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary')

  // ── Sheet 3: Combined Findings (all configured PAs together) ─────
  const findingsRows = buildCombinedFindingsRows(paReportsMap, { auditorsName, auditeesName, auditDate, projectName })
  const findingsSheet = XLSX.utils.json_to_sheet(findingsRows)
  findingsSheet['!cols'] = [12, 20, 20, 14, 22, 34, 10, 10, 8, 10, 80, 22, 40].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, findingsSheet, 'Combined Findings')

  // ── Sheet 4: IRP Incident Findings (only when present) ──────────────────
  const irpRows = buildIrpIncidentFindingsRows(irpAuditResult, { auditorsName, auditeesName, auditDate, projectName })
  if (irpRows.length > 0) {
    const irpSheet = XLSX.utils.json_to_sheet(irpRows)
    irpSheet['!cols'] = [16, 18, 18, 14, 22, 22, 70, 16, 16, 10, 10, 28, 50, 12].map(wch => ({ wch }))
    XLSX.utils.book_append_sheet(wb, irpSheet, 'IRP Incident Findings')
  }

  XLSX.writeFile(wb, `CMMI_Gap_Analysis_Report_${todayStr()}.xlsx`)
}

// Standalone Excel download for just the IRP Incident Findings section (used
// by the Download button on the Dashboard's IrpIncidentFindingsPanel).
// Reuses buildIrpIncidentFindingsRows — the same row builder that feeds
// Sheet 4 of downloadGapReportExcel — so the downloaded file always matches
// what's on screen. No-op when there are no findings (nothing to write).
export function downloadIrpIncidentFindingsExcel(irpAuditResult, meta = {}) {
  const irpRows = buildIrpIncidentFindingsRows(irpAuditResult, meta)
  if (irpRows.length === 0) return

  const wb = XLSX.utils.book_new()
  const irpSheet = XLSX.utils.json_to_sheet(irpRows)
  irpSheet['!cols'] = [16, 18, 18, 14, 22, 22, 70, 16, 16, 10, 10, 28, 50, 12].map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, irpSheet, 'IRP Incident Findings')

  XLSX.writeFile(wb, `IRP_Incident_Findings_${todayStr()}.xlsx`)
}
