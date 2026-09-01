// ─── CMMI Scan Results (new MASTER-rule-based pipeline) ────────────────────
//
// Renders the output of runNewCMMIScan() (evidenceScanEngine.js ->
// evidenceScanOrchestrator.js's runCMMIAuditScan()): three tabs —
// Document Classification, Evidence Gap Report, Gap Summary — plus an
// Excel export of the Evidence Gap Report. Purely a presentation layer:
// no scan logic lives here.

import { useState, Fragment } from 'react'
import { IconDownload } from '@tabler/icons-react'
import { sanitizeFilename } from '../afrExport'

const TABS = [
  { id: 'classification', label: 'Document Classification' },
  { id: 'gaps', label: 'Evidence Gap Report' },
  { id: 'summary', label: 'Gap Summary' },
]

function ConfidenceBadge({ confidence }) {
  const cls = confidence === 'High' ? 'badge-success' : confidence === 'Medium' ? 'badge-warning' : 'badge-danger'
  return <span className={`badge ${cls}`} style={{ fontSize: 10 }}>{confidence}</span>
}

function ErrorBadge() {
  return <span className="badge badge-danger" style={{ fontSize: 10, fontWeight: 700, background: '#FEE2E2', color: '#B91C1C' }}>ERROR</span>
}

const STATUS_STYLE = {
  FOUND: { cls: 'badge-success' },
  PARTIAL: { cls: 'badge-warning' },
  MISSING: { cls: 'badge-danger' },
  UNKNOWN: { cls: 'badge', style: { color: '#6b3fa0', background: 'rgba(107,63,160,0.12)' } },
  ERROR: { cls: 'badge', style: { color: '#6b21a8', background: '#EDE9FE', fontWeight: 700 } },
}

function StatusBadge({ status }) {
  const cfg = STATUS_STYLE[status] || STATUS_STYLE.UNKNOWN
  return <span className={`badge ${cfg.cls}`} style={{ fontSize: 10, ...(cfg.style || {}) }}>{status}</span>
}

function gapCountRowBg(gapCount, status) {
  if (status === 'ERROR') return '#F3E8FF'
  if (gapCount > 20) return 'var(--color-background-danger)'
  if (gapCount >= 5) return 'var(--color-background-warning)'
  return 'var(--color-background-success)'
}

function GapCountBadge({ gapCount }) {
  const cls = gapCount > 20 ? 'badge-danger' : gapCount >= 5 ? 'badge-warning' : 'badge-success'
  return <span className={`badge ${cls}`} style={{ fontSize: 11, fontWeight: 600 }}>{gapCount}</span>
}

function EmptyState({ children }) {
  return <div className="card" style={{ fontSize: 13, color: 'var(--color-text-secondary)', textAlign: 'center', padding: '2rem 1rem' }}>{children}</div>
}

function formatScanDate(d) {
  const date = new Date(d)
  if (isNaN(date.getTime())) return '-'
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${day} ${months[date.getMonth()]} ${date.getFullYear()} ${hh}:${mm}`
}

function EvidenceChips({ items }) {
  if (!items || items.length === 0) return <span style={{ color: 'var(--color-text-tertiary)' }}>-</span>
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 260 }}>
      {items.map((k, i) => (
        <span key={i} style={{ fontSize: 10, fontWeight: 500, padding: '2px 6px', borderRadius: 999, background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{k}</span>
      ))}
    </div>
  )
}

function Th({ children }) {
  return <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{children}</th>
}

function Td({ children, style }) {
  return <td style={{ padding: '8px 10px', fontSize: 12, verticalAlign: 'top', ...style }}>{children}</td>
}

function ClassificationTab({ rows, hasScanned }) {
  const [expanded, setExpanded] = useState(null)
  if (!hasScanned) return <EmptyState>Upload a folder and click Run CMMI Audit Scan to see document classification results.</EmptyState>
  if (rows.length === 0) return <EmptyState>No files scanned.</EmptyState>
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['File Name', 'Detected Type', 'Confidence', 'Practice Areas', 'Found', 'Partial', 'Missing', 'Gap Count', ''].map(h => <Th key={h}>{h}</Th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isError = r.status === 'ERROR'
            const isExpanded = expanded === i
            return (
              <Fragment key={i}>
                <tr style={{ background: gapCountRowBg(r.gapCount, r.status), borderBottom: isExpanded ? 'none' : '0.5px solid var(--color-border-tertiary)' }}>
                  <Td style={{ fontWeight: 500, color: 'var(--color-text-primary)' }} title={isError ? r.errorReason : (r.classificationReason || '')}>{r.originalFileName}</Td>
                  <Td>{isError ? <><ErrorBadge /> {r.detectedType && r.detectedType !== 'ERROR' ? <span style={{ marginLeft: 4 }}>{r.detectedType}</span> : null}</> : r.detectedType}</Td>
                  <Td>{isError ? r.confidence || '-' : <ConfidenceBadge confidence={r.confidence} />}</Td>
                  <Td>{isError ? '-' : ((r.practiceAreas || []).join(', ') || '-')}</Td>
                  <Td>{isError ? '-' : r.foundCount}</Td>
                  <Td>{isError ? '-' : r.partialCount}</Td>
                  <Td>{isError ? '-' : r.missingCount}</Td>
                  <Td>{isError ? '-' : <GapCountBadge gapCount={r.gapCount} />}</Td>
                  <Td>
                    <button
                      onClick={() => setExpanded(isExpanded ? null : i)}
                      className="btn"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      title={isError ? r.errorReason : r.classificationReason}
                    >
                      {isExpanded ? 'Hide' : (isError ? 'Why?' : 'Why?')}
                    </button>
                  </Td>
                </tr>
                {isExpanded && (
                  <tr style={{ background: gapCountRowBg(r.gapCount, r.status), borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <Td style={{ color: isError ? '#B91C1C' : 'var(--color-text-secondary)' }} colSpan={9}>
                      {isError ? `Error Reason: ${r.errorReason}` : (r.classificationReason || 'No classification reasoning available.')}
                    </Td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function GapReportTab({ rows, hasScanned }) {
  if (!hasScanned) return <EmptyState>No gaps found yet. Run a scan to see evidence validation results.</EmptyState>

  const practiceAreas = ['All', ...new Set(rows.map(r => r.practiceArea))]
  const statuses = ['All', ...new Set(rows.map(r => r.status))]
  const fileNames = ['All', ...new Set(rows.map(r => r.originalFileName))]

  const [paFilter, setPaFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [fileFilter, setFileFilter] = useState('All')

  const filtered = rows.filter(r =>
    (paFilter === 'All' || r.practiceArea === paFilter) &&
    (statusFilter === 'All' || r.status === statusFilter) &&
    (fileFilter === 'All' || r.originalFileName === fileFilter)
  )

  const selectStyle = { fontSize: 12, padding: '6px 8px', borderRadius: 'var(--border-radius-md)', border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-primary)', color: 'var(--color-text-primary)' }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <select style={selectStyle} value={paFilter} onChange={e => setPaFilter(e.target.value)}>
          {practiceAreas.map(pa => <option key={pa} value={pa}>{pa === 'All' ? 'All Practice Areas' : pa}</option>)}
        </select>
        <select style={selectStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          {statuses.map(s => <option key={s} value={s}>{s === 'All' ? 'All Statuses' : s}</option>)}
        </select>
        <select style={selectStyle} value={fileFilter} onChange={e => setFileFilter(e.target.value)}>
          {fileNames.map(f => <option key={f} value={f}>{f === 'All' ? 'All Files' : f}</option>)}
        </select>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', alignSelf: 'center', marginLeft: 'auto' }}>{filtered.length} of {rows.length} findings</div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>No findings match the current filters.</div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['PA', 'Rule ID', 'File Name', 'Audit Check', 'Status', 'Found Evidence', 'Missing Evidence', 'Gap Description'].map(h => <Th key={h}>{h}</Th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                  <Td>{r.practiceArea}</Td>
                  <Td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{r.ruleId}</Td>
                  <Td>{r.originalFileName}</Td>
                  <Td
                    title={r.auditCheck}
                    style={{ maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'help' }}
                  >
                    {r.auditCheck}
                  </Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td><EvidenceChips items={r.foundEvidence} /></Td>
                  <Td><EvidenceChips items={r.missingEvidence} /></Td>
                  <Td style={{ minWidth: 200, color: 'var(--color-text-secondary)' }}>{r.gapText}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, bg, color }) {
  return (
    <div style={{ flex: 1, background: bg, borderRadius: 'var(--border-radius-md)', padding: '1rem', textAlign: 'center' }}>
      <div style={{ fontSize: 12, color, opacity: 0.85, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 500, color }}>{value}</div>
    </div>
  )
}

function SummaryTab({ summary, hasScanned }) {
  if (!hasScanned) return <EmptyState>Run a scan to see the gap summary.</EmptyState>

  const paRows = Object.entries(summary.byPracticeArea || {})
  const fileRows = Object.entries(summary.byFile || {})

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <SummaryCard label="Total Rules Checked" value={summary.totalRulesChecked} bg="var(--color-background-info)" color="var(--color-text-info)" />
        <SummaryCard label="Found" value={summary.totalFound} bg="var(--color-background-success)" color="var(--color-text-success)" />
        <SummaryCard label="Partial" value={summary.totalPartial} bg="var(--color-background-warning)" color="var(--color-text-warning)" />
        <SummaryCard label="Missing" value={summary.totalMissing} bg="var(--color-background-danger)" color="var(--color-text-danger)" />
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: '1 1 320px', overflowX: 'auto' }}>
          <div className="section-title" style={{ fontSize: 13 }}>Practice Area Breakdown</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['PA', 'Found', 'Partial', 'Missing', 'Total'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
            <tbody>
              {paRows.map(([pa, t]) => (
                <tr key={pa} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                  <Td style={{ fontWeight: 500 }}>{pa}</Td>
                  <Td>{t.found}</Td>
                  <Td>{t.partial}</Td>
                  <Td>{t.missing}</Td>
                  <Td style={{ fontWeight: 600 }}>{t.total}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ flex: '1 1 320px', overflowX: 'auto' }}>
          <div className="section-title" style={{ fontSize: 13 }}>File Breakdown</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['File Name', 'Detected Type', 'Found', 'Partial', 'Missing', 'Gap Count'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
            <tbody>
              {fileRows.map(([fileName, t]) => (
                <tr key={fileName} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                  <Td style={{ fontWeight: 500 }}>{fileName}</Td>
                  <Td>{t.status === 'ERROR' ? <ErrorBadge /> : t.detectedType}</Td>
                  <Td>{t.found}</Td>
                  <Td>{t.partial}</Td>
                  <Td>{t.missing}</Td>
                  <Td style={{ fontWeight: 600 }}>{t.gapCount}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── 3-sheet Excel export (exceljs) ────────────────────────────────────────
//
// The `xlsx` package used elsewhere in this app (SheetJS Community edition)
// cannot write cell styling — no fill colors, no bold, no freeze panes; that
// support only exists in SheetJS's paid Pro build. exceljs is used here
// instead, dynamic-imported (mirrors the existing `await import('mammoth')`
// / `await import('docx')` convention already used for other heavy,
// export-only libraries in this codebase) so it never bloats the initial
// page load.

const HEADER_FILL = 'FFDBEAFE' // light blue, ARGB
const HEADER_FONT_COLOR = 'FF1E3A5F' // dark blue, ARGB
const STATUS_FILL = {
  FOUND: 'FFDCFCE7',
  PARTIAL: 'FFFEF3C7',
  MISSING: 'FFFEE2E2',
  ERROR: 'FFEDE9FE',
}

function styleHeaderRow(row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: HEADER_FONT_COLOR } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  row.commit()
}

// Auto-widths every column from its own header + cell content lengths — no
// cap, so full file names and other identifiers never get truncated with
// "...". `wrapCols` (1-indexed) get a sane max width instead, since their
// content is prose meant to wrap (Audit Check, Gap Description,
// Recommendation, etc.) rather than push the sheet arbitrarily wide.
function autoSizeColumns(sheet, wrapCols = []) {
  sheet.columns.forEach((col, i) => {
    const colNumber = i + 1
    let maxLen = 0
    col.eachCell({ includeEmpty: true }, cell => {
      const len = cell.value == null ? 0 : String(cell.value).length
      if (len > maxLen) maxLen = len
    })
    const isWrap = wrapCols.includes(colNumber)
    col.width = isWrap ? Math.min(Math.max(maxLen, 20), 55) : Math.max(maxLen + 2, 10)
    if (isWrap) {
      col.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
        if (rowNumber === 1) return
        cell.alignment = { wrapText: true, vertical: 'top' }
      })
    }
  })
}

function freezeHeaderRow(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}

function buildClassificationSheet(workbook, classificationReport) {
  const sheet = workbook.addWorksheet('Document Classification')
  const columns = [
    { header: 'Original File Name', key: 'file', width: 10 },
    { header: 'Detected Document Type', key: 'type', width: 10 },
    { header: 'Confidence', key: 'confidence', width: 10 },
    { header: 'Classification Reason', key: 'reason', width: 10 },
    { header: 'Practice Areas', key: 'pa', width: 10 },
    { header: 'Total Rules Checked', key: 'total', width: 10 },
    { header: 'Found', key: 'found', width: 10 },
    { header: 'Partial', key: 'partial', width: 10 },
    { header: 'Missing', key: 'missing', width: 10 },
    { header: 'Gap Count', key: 'gapCount', width: 10 },
    { header: 'Review Required', key: 'review', width: 10 },
    { header: 'Error Reason (if any)', key: 'error', width: 10 },
  ]
  sheet.columns = columns

  for (const r of classificationReport) {
    sheet.addRow({
      file: r.originalFileName,
      type: r.detectedType,
      confidence: r.confidence,
      reason: r.classificationReason || '',
      pa: (r.practiceAreas || []).join(', '),
      total: r.totalRulesChecked,
      found: r.foundCount,
      partial: r.partialCount,
      missing: r.missingCount,
      gapCount: r.gapCount,
      review: r.reviewRequired ? 'Yes' : 'No',
      error: r.status === 'ERROR' ? r.errorReason : '',
    })
  }

  styleHeaderRow(sheet.getRow(1))
  autoSizeColumns(sheet, [4]) // Classification Reason wraps
  freezeHeaderRow(sheet)
  return sheet
}

function buildEvidenceGapSheet(workbook, evidenceGapReport) {
  const sheet = workbook.addWorksheet('Evidence Gap Report')
  const columns = [
    { header: 'Practice Area', key: 'pa', width: 10 },
    { header: 'Rule ID', key: 'ruleId', width: 10 },
    { header: 'Level', key: 'level', width: 10 },
    { header: 'Original File Name', key: 'file', width: 10 },
    { header: 'Detected Document Type', key: 'type', width: 10 },
    { header: 'Audit Check', key: 'auditCheck', width: 10 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Found Evidence', key: 'found', width: 10 },
    { header: 'Missing Evidence', key: 'missing', width: 10 },
    { header: 'Gap Description', key: 'gapText', width: 10 },
    { header: 'Recommendation', key: 'recommendation', width: 10 },
  ]
  sheet.columns = columns

  for (const r of evidenceGapReport) {
    const row = sheet.addRow({
      pa: r.practiceArea,
      ruleId: r.ruleId,
      level: r.level,
      file: r.originalFileName,
      type: r.detectedDocType,
      auditCheck: r.auditCheck,
      status: r.status,
      found: (r.foundEvidence || []).join('; '),
      missing: (r.missingEvidence || []).join('; '),
      gapText: r.gapText,
      recommendation: r.recommendation,
    })
    const statusCell = row.getCell('status')
    const fill = STATUS_FILL[r.status]
    if (fill) statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
  }

  styleHeaderRow(sheet.getRow(1))
  autoSizeColumns(sheet, [6, 8, 9, 10, 11]) // Audit Check, Found/Missing Evidence, Gap Description, Recommendation wrap
  freezeHeaderRow(sheet)
  return sheet
}

function buildGapSummarySheet(workbook, gapSummary) {
  const sheet = workbook.addWorksheet('Gap Summary')

  // Section 1 — overall totals.
  const s1Headers = ['Total Files', 'Total Rules Checked', 'Found', 'Partial', 'Missing', 'Unknown', 'Total Gaps']
  sheet.addRow(s1Headers)
  sheet.addRow([
    gapSummary.totalFiles || 0,
    gapSummary.totalRulesChecked || 0,
    gapSummary.totalFound || 0,
    gapSummary.totalPartial || 0,
    gapSummary.totalMissing || 0,
    gapSummary.totalUnknown || 0,
    gapSummary.totalGaps || 0,
  ])
  styleHeaderRow(sheet.getRow(1))

  // Section 2 — PA-wise breakdown.
  sheet.addRow([])
  const s2TitleRowNum = sheet.rowCount + 1
  sheet.addRow(['Practice Area Breakdown'])
  sheet.getRow(s2TitleRowNum).getCell(1).font = { bold: true }
  const s2HeaderRowNum = sheet.rowCount + 1
  sheet.addRow(['Practice Area', 'Found', 'Partial', 'Missing', 'Total Rules'])
  for (const [pa, t] of Object.entries(gapSummary.byPracticeArea || {})) {
    sheet.addRow([pa, t.found, t.partial, t.missing, t.total])
  }
  styleHeaderRow(sheet.getRow(s2HeaderRowNum))

  // Section 3 — file-wise breakdown.
  sheet.addRow([])
  const s3TitleRowNum = sheet.rowCount + 1
  sheet.addRow(['File-wise Breakdown'])
  sheet.getRow(s3TitleRowNum).getCell(1).font = { bold: true }
  const s3HeaderRowNum = sheet.rowCount + 1
  sheet.addRow(['File Name', 'Detected Type', 'Found', 'Partial', 'Missing', 'Gap Count'])
  for (const [fileName, t] of Object.entries(gapSummary.byFile || {})) {
    sheet.addRow([fileName, t.status === 'ERROR' ? 'ERROR' : t.detectedType, t.found, t.partial, t.missing, t.gapCount])
  }
  styleHeaderRow(sheet.getRow(s3HeaderRowNum))

  sheet.columns.forEach(col => { col.width = 14 })
  autoSizeColumns(sheet)
  freezeHeaderRow(sheet)
  return sheet
}

async function exportCMMIReportExcel(cmmiScanResult) {
  if (!cmmiScanResult) return
  const { projectName, scanDate, reports } = cmmiScanResult
  const { classificationReport = [], evidenceGapReport = [], gapSummary = {} } = reports || {}

  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()

  buildClassificationSheet(workbook, classificationReport)
  buildEvidenceGapSheet(workbook, evidenceGapReport)
  buildGapSummarySheet(workbook, gapSummary)

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

  const d = new Date(scanDate || Date.now())
  const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const safeProjectName = sanitizeFilename(projectName).replace(/ /g, '_')
  const filename = `CMMI_Gap_Report_${safeProjectName}_${dateStr}.xlsx`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// `cmmiScanResult`: { projectName, scanDate, reports: { classificationReport,
// evidenceGapReport, gapSummary } } — the return shape of runNewCMMIScan().
// null before the user has clicked "Run CMMI Audit Scan" — rendered as an
// always-visible shell with per-tab empty-state messages rather than
// hidden entirely, so the panel (and its "Last scan" line) has a place to
// live once a scan does complete.
export default function CMMIScanResults({ cmmiScanResult }) {
  const [activeTab, setActiveTab] = useState('classification')
  const hasScanned = !!cmmiScanResult

  const { projectName, scanDate, reports } = cmmiScanResult || {}
  const { classificationReport = [], evidenceGapReport = [], gapSummary = {} } = reports || {}

  return (
    <div className="card" style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>CMMI Audit Scan Results</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {hasScanned ? `Last scan: ${projectName} — ${formatScanDate(scanDate)}` : 'No scan run yet — upload a folder and click "Run CMMI Audit Scan".'}
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => exportCMMIReportExcel(cmmiScanResult)}
          disabled={!hasScanned}
          style={!hasScanned ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        >
          <IconDownload size={14} /> Export to Excel
        </button>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '0.5px solid var(--color-border-tertiary)', marginBottom: '1.25rem' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer',
              color: activeTab === t.id ? 'var(--color-text-info)' : 'var(--color-text-secondary)',
              borderBottom: activeTab === t.id ? '2px solid #378ADD' : '2px solid transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'classification' && <ClassificationTab rows={classificationReport} hasScanned={hasScanned} />}
      {activeTab === 'gaps' && <GapReportTab rows={evidenceGapReport} hasScanned={hasScanned} />}
      {activeTab === 'summary' && <SummaryTab summary={gapSummary} hasScanned={hasScanned} />}
    </div>
  )
}
