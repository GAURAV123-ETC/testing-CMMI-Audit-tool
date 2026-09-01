// ─── Domain / Practice Area Mapping — shared source of truth ───────────────
//
// Extracted from App.jsx so both the UI (App.jsx) and the report generator
// (afrExport.js) consume the exact same Domain-to-Practice-Area mapping —
// "PA Mapping should come from existing Practice Area validation/
// configuration rather than being manually typed during report generation."
// Never invented or modified — this is the same data/logic that was
// previously defined inline in App.jsx.

import { EXPECTED_PRACTICE_AREAS } from './practiceAreaRegistry'

// CMMI V3.0 core practice areas — cross-cutting, shown in every domain view.
// Order here drives the display order of the dashboard's core section.
export const CORE_PRACTICE_AREAS = [
  {code:'CAR',  name:'Causal Analysis and Resolution',          score:78, status:'partial'},
  {code:'PR',   name:'Peer Reviews',                            score:89, status:'compliant'},
  {code:'PQA',  name:'Process Quality Assurance',               score:75, status:'partial'},
  {code:'RDM',  name:'Requirements Development & Management',   score:76, status:'partial'},
  {code:'VV',   name:'Verification & Validation',               score:79, status:'compliant'},
  {code:'EST',  name:'Estimating',                              score:88, status:'compliant'},
  {code:'MC',   name:'Monitor & Control',                       score:84, status:'compliant'},
  {code:'PLAN', name:'Planning',                                score:81, status:'compliant'},
  {code:'RSK',  name:'Risk & Opportunity Management',           score:83, status:'compliant'},
  {code:'OT',   name:'Organizational Training',                 score:72, status:'partial'},
  {code:'CM',   name:'Configuration Management',                score:91, status:'compliant'},
  {code:'DAR',  name:'Decision Analysis & Resolution',          score:74, status:'partial'},
  {code:'MPM',  name:'Managing Performance & Measurement',      score:60, status:'critical'},
  {code:'PAD',  name:'Process Asset Development',               score:80, status:'compliant'},
  {code:'PCM',  name:'Process Management',                      score:72, status:'partial'},
  {code:'GOV',  name:'Governance',                              score:65, status:'partial'},
  {code:'II',   name:'Implementation Infrastructure',           score:70, status:'partial'},
]

// CMMI V3.0 domains and their domain-specific practice areas. Order here drives
// the order of the domain sections rendered below the core section.
export const DOMAINS = [
  {id:'dev',  code:'DEV',  label:'Development', pas:[
    {code:'PI',   name:'Product Integration',                   score:86, status:'compliant'},
    {code:'TS',   name:'Technical Solution',                    score:87, status:'compliant'},
  ]},
  {id:'svc',  code:'SVC',  label:'Services', pas:[
    {code:'CONT', name:'Continuity',                            score:68, status:'partial'},
    {code:'SDM',  name:'Service Delivery Management',           score:85, status:'compliant'},
    {code:'STSM', name:'Strategic Service Management',          score:73, status:'partial'},
  ]},
  {id:'spm',  code:'SPM',  label:'Suppliers', pas:[
    {code:'SAM',  name:'Supplier Agreement Management',         score:71, status:'partial'},
  ]},
  {id:'ppl',  code:'PPL',  label:'People', pas:[
    {code:'WE',   name:'Workforce Empowerment',                 score:69, status:'partial'},
  ]},
  {id:'data', code:'DATA', label:'Data', pas:[
    {code:'DM',   name:'Data Management',                       score:77, status:'partial'},
    {code:'DQ',   name:'Data Quality',                          score:63, status:'critical'},
  ]},
  {id:'sec',  code:'SEC',  label:'Security', pas:[
    {code:'ESEC', name:'Enabling Security',                     score:71, status:'partial'},
    {code:'MST',  name:'Managing Security Threats & Vulnerabilities', score:64, status:'critical'},
  ]},
  {id:'saf',  code:'SAF',  label:'Safety', pas:[
    {code:'ESAF', name:'Enabling Safety',                       score:58, status:'critical'},
  ]},
  {id:'vrt',  code:'VRT',  label:'Virtual', pas:[
    {code:'EVW',  name:'Enabling Virtual Work',                 score:76, status:'partial'},
  ]},
]

// Flat list of every practice area — core first, then domain-specific.
export const PRACTICE_AREAS = [...CORE_PRACTICE_AREAS, ...DOMAINS.flatMap(d => d.pas)]

export const CORE_PAS = new Set(CORE_PRACTICE_AREAS.map(pa => pa.code))

// Practice area code → domain id (core PAs are absent from this map).
export const PA_DOMAIN = Object.fromEntries(
  DOMAINS.flatMap(d => d.pas.map(pa => [pa.code, d.id]))
)

// ─── Domain-wise selection helpers ─────────────────────────────────────────
// `selectedDomainIds` is an array of DOMAINS `id`s — an empty array means
// "All Domains".

// Core Practice Areas are cross-cutting (already "shown in every domain
// view" per the existing CORE_PRACTICE_AREAS comment) — they're included
// regardless of which domain(s) are selected. IRP (from the Stage-1
// availability engine's practiceAreaRegistry.js) is likewise always-on: it
// isn't part of the CORE_PRACTICE_AREAS/DOMAINS taxonomy at all and already
// receives special, domain-independent treatment everywhere else in the app.
export function domainsForSelection(selectedDomainIds) {
  return !selectedDomainIds || selectedDomainIds.length === 0 ? DOMAINS : DOMAINS.filter(d => selectedDomainIds.includes(d.id))
}

export function paCodesForSelection(selectedDomainIds) {
  const domains = domainsForSelection(selectedDomainIds)
  return new Set([...CORE_PRACTICE_AREAS.map(pa => pa.code), ...domains.flatMap(d => d.pas.map(pa => pa.code))])
}

export function paTypeLabel(code) {
  return CORE_PAS.has(code) || code === 'IRP' ? 'Core' : 'Non-Core'
}

export function paDomainLabel(code) {
  if (CORE_PAS.has(code) || code === 'IRP') return 'Core (All Domains)'
  const domain = DOMAINS.find(d => d.id === PA_DOMAIN[code])
  return domain ? domain.code : '—'
}

// Full display name for any registered Practice Area code (Core, domain-
// specific, or IRP) — falls back to the Stage-1 registry so every code the
// availability engine knows about resolves to a real name, never a manual
// guess.
export function paDisplayName(code) {
  const known = PRACTICE_AREAS.find(pa => pa.code === code)
  if (known) return known.name
  const registered = EXPECTED_PRACTICE_AREAS.find(pa => pa.code === code)
  return registered ? registered.name : code
}

// Combines Stage-1 folder/document availability (`pkgAvailability`, lifted
// from the PA Validation "Upload Practice Area Folder" scan) with Stage-2
// header-validation compliance (`paReports`, from the existing
// validatePracticeArea engine) into the single Available/Missing/Gap
// classification used by the PA Validation results table, the Dashboard
// KPIs, and the Auditor/Gap report generator.
// `irpIssueLog` is optional (default null) and backward compatible — every
// existing call site that doesn't pass it behaves exactly as before. When a
// caller (currently only afrExport.js) does pass the real
// checkIrpIssueLog() result for the current scan, IRP's compliance status is
// derived from its actual 24-field header validation instead of defaulting
// to "Available" purely because the IRP folder exists (there is no
// PA_CHECKLISTS entry for IRP, so paReports.IRP never exists).
export function combinedPAStatus(code, pkgAvailability, paReports, irpIssueLog = null) {
  const availability = pkgAvailability ? pkgAvailability[code] : undefined
  if (availability !== 'AVAILABLE') return 'Missing'
  if (code === 'IRP' && irpIssueLog) {
    if (irpIssueLog.documentStatus === 'MISSING' || irpIssueLog.documentStatus === 'NO DOCUMENT FOUND') return 'Missing'
    if (irpIssueLog.headerValidationPossible && irpIssueLog.headerStatus !== 'FULLY AVAILABLE') return 'Gap'
    return 'Available'
  }
  const report = paReports && paReports[code]
  // The folder existing does NOT imply compliance: if Stage 2 ran and found
  // the specific required document itself absent from an otherwise-present
  // folder, that is a Missing finding, not "Available" by default.
  if (report && !report.documentFound) return 'Missing'
  if (report && report.documentFound && report.overallStatus !== 'Compliant') return 'Gap'
  return 'Available'
}

// "Missing Document / Gap" column text for the PA Validation results table —
// derived from the actual scan/validation result, never invented.
export function paMissingOrGapDetail(code, status, paReports, irpIssueLog = null) {
  if (status === 'Available') return '-'
  if (code === 'IRP' && irpIssueLog) {
    if (status === 'Missing') return 'No IRP Issue Log was found under the IRP Practice Area folder.'
    const missing = (irpIssueLog.fieldResults || []).filter(f => f.status === 'MISSING')
    return missing.length ? `${missing.length} of ${(irpIssueLog.fieldResults || []).length} required Issue Log column(s) missing: ${missing.map(f => f.field).join(', ')}.` : 'Required validation criteria not fully satisfied.'
  }
  const report = paReports && paReports[code]
  if (status === 'Missing') {
    if (report && !report.documentFound) return `Required document "${report.documentLabel}" was not found.`
    return 'Practice Area folder not found in the uploaded package.'
  }
  if (report) return `${report.missingCount} of ${report.totalRequired} required field(s) missing in ${report.fileName || report.documentLabel}.`
  return 'Required validation criteria not fully satisfied.'
}

// Per-domain stats (Total PA / Core PA / Available / Missing / Gap / Score)
// for the Dashboard's domain-wise breakdown table — Score reuses the exact
// same available/total percentage formula already used by
// auditPackageEngine.js's summarizePracticeAreaAvailability, just scoped to
// one domain's Core+domain-specific Practice Areas.
export function computeDomainStats(domain, pkgAvailability, paReports) {
  const codes = [...CORE_PRACTICE_AREAS.map(pa => pa.code), ...domain.pas.map(pa => pa.code)]
  let available = 0, missing = 0, gap = 0
  codes.forEach(code => {
    const status = combinedPAStatus(code, pkgAvailability, paReports)
    if (status === 'Available') available += 1
    else if (status === 'Gap') gap += 1
    else missing += 1
  })
  return {
    domain: domain.code, total: codes.length, core: CORE_PRACTICE_AREAS.length,
    available, missing, gap,
    score: codes.length ? Math.round((available / codes.length) * 100) : 0,
  }
}
