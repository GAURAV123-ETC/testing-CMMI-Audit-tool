// ─── Dashboard Findings Filters ─────────────────────────────────────────────
//
// Narrows `paReports` / `ncStore` before they're handed to the Dashboard's
// combined Gap Report download or the new AFR download. Pure, side-effect
// free — the Dashboard owns the `filters` state and calls this on render.
//
// Note on scope (documented limitation): this app captures exactly one
// audit/project per session (see auditMeta in App.jsx) — there is no
// persisted multi-audit history. Project and Audit are therefore
// necessarily single-value, all-or-nothing gates rather than true
// multi-record filters; Auditor is accepted for spec compliance but is a
// documented no-op on export contents (findings aren't attributed to an
// individual auditor in the data model). Practice Area, Severity, Status
// and Date filter meaningfully, since a session can validate many Practice
// Areas and each finding carries its own severity/status/timestamp.

export const DEFAULT_FILTERS = {
  projects: [],
  audits: [],
  auditors: [],
  practiceAreas: [],
  severities: [],
  statuses: [],
  fromDate: '',
  toDate: '',
}

export function isFiltersActive(filters) {
  return Object.entries(filters).some(([key, val]) =>
    key === 'fromDate' || key === 'toDate' ? Boolean(val) : (val || []).length > 0
  )
}

// Returns { filteredPaReports, filteredNcStore } — same shapes as paReports/
// ncStore, just narrowed. Default (all-empty) filters are a strict no-op.
export function applyDashboardFilters(paReports, ncStore, filters = DEFAULT_FILTERS, auditMeta = {}) {
  const f = { ...DEFAULT_FILTERS, ...filters }

  if (f.projects.length && !f.projects.includes(auditMeta.projectName)) {
    return { filteredPaReports: {}, filteredNcStore: {} }
  }
  if (f.audits.length && !f.audits.includes(auditMeta.auditName)) {
    return { filteredPaReports: {}, filteredNcStore: {} }
  }

  const codes = Object.keys(paReports).filter(code => !f.practiceAreas.length || f.practiceAreas.includes(code))

  const filteredPaReports = {}
  const filteredNcStore = {}
  codes.forEach(code => {
    filteredPaReports[code] = paReports[code]
    const records = (ncStore[code]?.records || []).filter(r =>
      (!f.severities.length || f.severities.includes(r.severity)) &&
      (!f.statuses.length || f.statuses.includes(r.status)) &&
      (!f.fromDate || (r.firstDetectedAt || '').slice(0, 10) >= f.fromDate) &&
      (!f.toDate || (r.firstDetectedAt || '').slice(0, 10) <= f.toDate)
    )
    filteredNcStore[code] = { records, seq: ncStore[code]?.seq || 0 }
  })

  return { filteredPaReports, filteredNcStore }
}
