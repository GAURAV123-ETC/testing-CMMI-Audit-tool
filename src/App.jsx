import { useState, useRef, useEffect } from 'react'
import {
  IconLayoutDashboard, IconFolderOpen, IconClipboardCheck,
  IconArrowsTransferUp, IconMessageChatbot,
  IconReportAnalytics, IconPlayerPlay, IconZoomCode, IconReport,
  IconCloudUpload, IconBrandGithub, IconCloud, IconBrandGoogle,
  IconFolder, IconArrowRight, IconEdit, IconDownload, IconSend,
  IconSparkles, IconFile, IconFileExport, IconSearch, IconFileCheck,
  IconTrash, IconX, IconFileSearch
} from '@tabler/icons-react'
import { getAIResponse } from './aiService'
import { PA_CHECKLISTS, SUPPORTED_PA_CODES } from './checklists'
import { validatePracticeArea, bucketFilesByPA, getRecommendationDetail } from './validationEngine'
import { downloadGapReportPDF, downloadGapReportExcel, downloadCombinedGapReportPDF, downloadAuditFindingsReportPDF, downloadIrpIncidentFindingsExcel } from './reportExport'
import { updateNCStore, daysBetween } from './ncEngine'
import { validateRiskSLA } from './riskSlaEngine'
import { validateLessonLearned } from './irpEngine'
import { validateIRPAudit, getIrpIncidentFindings } from './irpAudit'
import { nameMatchesKeywords } from './textMatch'
import { scanDirectoryHandle, scanFileList, filesUnderFolderPath } from './folderScanUtils'
import { validateIrpIncidentLogData } from './irpDataValidation'
import { runAuditPackageCheck, drillDownPracticeArea } from './auditPackageEngine'
import { parseGithubRepoInput, scanGithubRepo } from './githubConnector'
import { isSharePointConfigured, signIn as signInSharePoint, scanSharePointFolder } from './sharepointConnector'
import { isGoogleDriveConfigured, requestAccessToken as requestGoogleAccessToken, openPicker as openGoogleDrivePicker, scanGoogleDriveFolder } from './googleDriveConnector'
import { downloadAFRExcel, downloadAFRWord, buildDetailedFindingsRows } from './afrExport'
import { runEvidenceScan, runNewCMMIScan, SUPPORTED_EVIDENCE_EXTS } from './evidenceScanEngine'
import { extractDocumentText, getExt } from './documentTextExtraction'
import CMMIScanResults from './components/CMMIScanResults'
import { DEFAULT_FILTERS, applyDashboardFilters, isFiltersActive } from './dashboardFilters'
import {
  CORE_PRACTICE_AREAS, DOMAINS, PRACTICE_AREAS, CORE_PAS, PA_DOMAIN,
  domainsForSelection, paCodesForSelection, paTypeLabel, paDomainLabel,
  combinedPAStatus, paMissingOrGapDetail, computeDomainStats,
} from './domainData'

// ─── Data ────────────────────────────────────────────────────────────────────
// Domain/Practice Area data + helpers (CORE_PRACTICE_AREAS, DOMAINS,
// domainsForSelection, combinedPAStatus, etc.) now live in domainData.js —
// shared with afrExport.js so the Auditor/Gap report's "PA Mapping" reuses
// the exact same mapping instead of a second, hand-typed copy.

// Shared multi-select domain chip row — used by both PA Validation ("Select
// Domain") and the Dashboard ("Domain Filter"). `selected` is an array of
// DOMAINS `id`s; an empty array represents "All Domains".
function DomainMultiSelect({ selected, onChange }) {
  const isAll = selected.length === 0
  // Functional update — avoids a stale-closure race where two chip clicks
  // dispatched before React re-renders (e.g. rapid double-click) would both
  // read the same pre-click `selected` array and the second click's result
  // would silently overwrite the first's.
  const toggleDomain = (id) => {
    onChange(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }
  const activeStyle = { borderColor: '#378ADD', color: '#185FA5', background: 'rgba(55,138,221,0.08)' }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <span className="chip" style={isAll ? activeStyle : undefined} onClick={() => onChange([])}>All Domains</span>
      {DOMAINS.map(d => (
        <span key={d.id} className="chip" style={selected.includes(d.id) ? activeStyle : undefined} onClick={() => toggleDomain(d.id)} title={d.label}>
          {d.code}
        </span>
      ))}
    </div>
  )
}

const AFR_DATA = [
  {id:'AFR-001',severity:'critical',pa:'MPM',title:'Quantitative performance objectives not established',desc:'Organization has not defined measurable QPPOs linked to business objectives as required by MPM 4.1 and MPM 5.1',artifact:'Process Performance Baseline',recommendation:'Define at least 3 QPPOs with statistical baselines and target ranges within 30 days'},
  {id:'AFR-002',severity:'critical',pa:'MPM',title:'No Process Performance Models (PPMs) documented',desc:'Absence of PPMs prevents quantitative prediction of process outcomes; violates MPM 4.2 mandatory practice',artifact:'MPM Documentation',recommendation:'Develop PPMs using regression analysis on historical data covering at least 2 project cycles'},
  {id:'AFR-004',severity:'critical',pa:'DQ', title:'Data quality controls not defined',desc:'DQ 2.1 requires documented data quality criteria and validation rules. No formal DQ framework exists for operational data feeds',artifact:'Data Quality Plan',recommendation:'Establish data quality rules, acceptance thresholds, and automated validation checks within 30 days'},
  {id:'AFR-005',severity:'critical',pa:'ESAF',title:'Safety risk analysis not performed',desc:'ESAF 2.1 requires identification and analysis of safety hazards. No safety hazard log exists for current release',artifact:'Safety Hazard Log',recommendation:'Conduct safety risk analysis and document hazard controls before next release'},
  {id:'AFR-006',severity:'critical',pa:'MST', title:'Security threat model not maintained',desc:'MST 3.1 requires an up-to-date threat model. Current threat model is 18 months old and does not reflect recent architecture changes',artifact:'Threat Model, SAST Reports',recommendation:'Update threat model and conduct SAST/DAST scan within 2 weeks'},
  {id:'AFR-008',severity:'major',pa:'GOV',title:'Senior management review cadence insufficient',desc:'GOV 2.2 requires periodic senior management review of process performance. Last review was 6 months ago',artifact:'Management Review Minutes',recommendation:'Schedule monthly management reviews with process performance dashboards'},
  {id:'AFR-009',severity:'major',pa:'RDM',title:'Bidirectional requirements traceability gaps',desc:'RDM 3.2 mandates traceability from requirements to design and test. 12% of requirements lack design references',artifact:'RTM',recommendation:'Update RTM to add design document references for 23 requirements flagged in gap analysis'},
  {id:'AFR-010',severity:'major',pa:'SAM',title:'Supplier performance metrics not quantified',desc:'SAM 3.3 requires quantitative supplier performance tracking. Current tracking is qualitative only',artifact:'Supplier Agreements',recommendation:'Define measurable SLAs and KPIs for top 5 suppliers within 45 days'},
  {id:'AFR-011',severity:'major',pa:'PCM',title:'Process change impact analysis missing',desc:'PCM 3.2 requires documented impact analysis before process changes. 4 recent changes lack documentation',artifact:'Change Log',recommendation:'Retroactively document impact analysis and implement mandatory review gate for future changes'},
  {id:'AFR-012',severity:'major',pa:'PQA', title:'Quality assurance audit coverage insufficient',desc:'PQA 2.1 requires QA audits on all high-risk work products. 40% of critical artifacts were not audited in Q3',artifact:'QA Audit Records',recommendation:'Increase QA audit frequency and define risk-based sampling criteria for artifact selection'},
  {id:'AFR-013',severity:'minor',pa:'DAR',title:'Decision criteria not always documented',desc:'DAR 2.1 requires evaluation criteria documented before alternative analysis. 3 recent decisions undocumented',artifact:'Decision Log',recommendation:'Establish decision analysis template and add to project initiation checklist'},
  {id:'AFR-014',severity:'minor',pa:'PR',title:'Peer review data not consistently collected',desc:'PR 3.1 requires defect density data from reviews to be collected and analyzed. Gaps in Q3 data',artifact:'Peer Review Records',recommendation:'Update peer review template to include defect count and severity fields'},
  {id:'AFR-015',severity:'minor',pa:'II',title:'Training records incomplete for key roles',desc:'II 2.3 requires training records for all personnel performing CMMI-impacted roles',artifact:'Training Records',recommendation:'Audit training records and capture any missing completions within 2 weeks'},
  {id:'AFR-016',severity:'minor',pa:'OT', title:'Training effectiveness not measured',desc:'OT 3.1 requires evaluation of training effectiveness. Current training completion is tracked but learning outcomes are not assessed',artifact:'Training Effectiveness Reports',recommendation:'Add post-training assessments and link results to competency records in the skills matrix'},
]

const GAP_DATA = {
  CM: [
    {control:'CM 2.1',name:'Establish baselines',status:'compliant',desc:'Configuration baselines established at project milestones'},
    {control:'CM 2.2',name:'Track and control changes',status:'compliant',desc:'Change control board active and change log maintained'},
    {control:'CM 2.3',name:'Establish integrity',status:'compliant',desc:'Integrity checks performed at each baseline'},
    {control:'CM 3.1',name:'Configuration audits',status:'compliant',desc:'Physical and functional configuration audits conducted at release'},
  ],
  DAR: [
    {control:'DAR 2.1',name:'Document decision criteria',status:'partial',desc:'3 recent decisions lack documented evaluation criteria before analysis'},
    {control:'DAR 2.2',name:'Evaluate alternatives',status:'compliant',desc:'Alternative analysis templates in use'},
    {control:'DAR 3.1',name:'Select evaluation methods',status:'compliant',desc:'Formal evaluation methods selected based on decision significance'},
  ],
  EST: [
    {control:'EST 2.1',name:'Establish estimation approach',status:'compliant',desc:'Estimation methodology documented using historical data'},
    {control:'EST 2.2',name:'Estimate effort and cost',status:'compliant',desc:'Effort/cost estimates derived from WBS and historical actuals'},
    {control:'EST 3.1',name:'Estimate using models',status:'compliant',desc:'Parametric estimation models in use for major projects'},
    {control:'EST 3.2',name:'Validate estimates',status:'compliant',desc:'Estimates validated against project actuals at phase end'},
  ],
  GOV: [
    {control:'GOV 2.1',name:'Establish governance framework',status:'compliant',desc:'Governance structure and roles documented'},
    {control:'GOV 2.2',name:'Senior management review',status:'partial',desc:'Last senior management review was 6 months ago — should be monthly'},
    {control:'GOV 3.1',name:'Process performance reviews',status:'partial',desc:'Performance dashboards exist but not reviewed at governance level'},
    {control:'GOV 3.2',name:'Corrective action oversight',status:'compliant',desc:'AFR tracking in place with owner assignments'},
  ],
  II: [
    {control:'II 2.1',name:'Process infrastructure',status:'compliant',desc:'Tools and environments defined and maintained'},
    {control:'II 2.2',name:'Resource provisioning',status:'compliant',desc:'Resource needs identified in project plans'},
    {control:'II 2.3',name:'Training records',status:'partial',desc:'Training records incomplete for 8 personnel in CMMI-impacted roles'},
    {control:'II 3.1',name:'Skills assessment',status:'compliant',desc:'Skills matrix maintained and reviewed annually'},
  ],
  MC: [
    {control:'MC 2.1',name:'Monitor project planning',status:'compliant',desc:'Project plans reviewed against actuals at each milestone'},
    {control:'MC 2.2',name:'Monitor commitments',status:'compliant',desc:'Commitment tracking integrated into project status reports'},
    {control:'MC 3.1',name:'Analyse issues',status:'compliant',desc:'Issue analysis conducted at weekly project reviews'},
    {control:'MC 3.2',name:'Manage corrective actions',status:'compliant',desc:'Corrective actions tracked to closure with owner accountability'},
  ],
  MPM: [
    {control:'MPM 4.1',name:'Define QPPOs',status:'missing',desc:'No quantitative process performance objectives defined at organizational level'},
    {control:'MPM 4.2',name:'Establish PPBs',status:'partial',desc:'PPBs exist for 2 of 5 critical processes. Missing for test, deployment'},
    {control:'MPM 5.1',name:'Predictive performance',status:'missing',desc:'No statistical models for predicting process outcomes'},
    {control:'MPM 5.2',name:'Causal analysis of variation',status:'partial',desc:'Analysis done ad hoc, not systematically linked to QPPOs'},
  ],
  OT: [
    {control:'OT 2.1',name:'Establish training needs',status:'compliant',desc:'Training needs identified from project plans and role requirements'},
    {control:'OT 2.2',name:'Provide training',status:'compliant',desc:'Training delivered on schedule for all mandatory competencies'},
    {control:'OT 3.1',name:'Evaluate training effectiveness',status:'partial',desc:'Training completion tracked but learning outcomes not assessed against competency targets'},
    {control:'OT 3.2',name:'Maintain training records',status:'compliant',desc:'Training records maintained in LMS with role mapping'},
  ],
  PAD: [
    {control:'PAD 2.1',name:'Establish process assets',status:'compliant',desc:'Core process assets defined and baselined'},
    {control:'PAD 2.2',name:'Maintain process assets',status:'compliant',desc:'Asset review and update cycle in place'},
    {control:'PAD 3.1',name:'Collect improvement info',status:'compliant',desc:'Lessons learned captured post-project'},
    {control:'PAD 3.2',name:'Appraise process assets',status:'compliant',desc:'Annual process asset appraisal conducted'},
  ],
  PCM: [
    {control:'PCM 2.1',name:'Plan process changes',status:'compliant',desc:'Change proposals submitted via PCM change request process'},
    {control:'PCM 3.1',name:'Deploy process changes',status:'compliant',desc:'Process changes communicated and training updated'},
    {control:'PCM 3.2',name:'Impact analysis',status:'gap',desc:'4 recent process changes deployed without documented impact analysis'},
    {control:'PCM 5.1',name:'Quantitative change evaluation',status:'partial',desc:'Change effectiveness not measured quantitatively post-deployment'},
  ],
  PI: [
    {control:'PI 2.1',name:'Prepare for product integration',status:'compliant',desc:'Integration strategy and environment defined per project'},
    {control:'PI 3.1',name:'Manage interfaces',status:'compliant',desc:'Interface control documents maintained and reviewed'},
    {control:'PI 3.2',name:'Assemble product components',status:'compliant',desc:'Components assembled per integration plan with documented results'},
    {control:'PI 3.3',name:'Evaluate assembled products',status:'compliant',desc:'Integration test results reviewed and approved before delivery'},
  ],
  PLAN: [
    {control:'PLAN 2.1',name:'Establish project plan',status:'compliant',desc:'Project plans documented with scope, schedule, and resource estimates'},
    {control:'PLAN 2.2',name:'Identify project risks',status:'compliant',desc:'Risk register populated at project initiation'},
    {control:'PLAN 3.1',name:'Plan stakeholder involvement',status:'compliant',desc:'Stakeholder engagement plan defined and reviewed'},
    {control:'PLAN 3.2',name:'Plan data management',status:'partial',desc:'Data management plan template exists but not consistently applied across all projects'},
  ],
  PQA: [
    {control:'PQA 2.1',name:'Evaluate work products',status:'partial',desc:'QA audits cover critical artifacts but sampling criteria are not formally quantified'},
    {control:'PQA 2.2',name:'Evaluate processes',status:'partial',desc:'Process compliance checks performed but not on all active projects'},
    {control:'PQA 3.1',name:'Communicate noncompliance',status:'compliant',desc:'Non-conformances logged and escalated to management'},
    {control:'PQA 3.2',name:'Establish QA records',status:'compliant',desc:'QA records maintained and linked to project artifacts'},
  ],
  PR: [
    {control:'PR 2.1',name:'Prepare for peer reviews',status:'compliant',desc:'Review checklists and entry criteria defined'},
    {control:'PR 3.1',name:'Conduct peer reviews',status:'partial',desc:'Defect density data not consistently collected in Q3'},
    {control:'PR 3.2',name:'Analyze peer review data',status:'partial',desc:'Review metrics not aggregated and analyzed at organizational level'},
    {control:'PR 5.1',name:'Quantitative review analysis',status:'compliant',desc:'Review effectiveness measured using defect removal efficiency'},
  ],
  RDM: [
    {control:'RDM 2.1',name:'Requirements elicitation',status:'compliant',desc:'Requirements elicitation process well-documented and followed'},
    {control:'RDM 2.2',name:'Requirements analysis',status:'compliant',desc:'Analysis templates in use and consistently applied'},
    {control:'RDM 3.1',name:'Requirements allocation',status:'partial',desc:'Allocation to subsystems incomplete for 3 modules'},
    {control:'RDM 3.2',name:'Bidirectional traceability',status:'gap',desc:'12% of requirements missing design document references'},
    {control:'RDM 3.3',name:'Requirements validation',status:'compliant',desc:'Validation with stakeholders documented'},
  ],
  RSK: [
    {control:'RSK 2.1',name:'Identify risks',status:'compliant',desc:'Risk identification process embedded in project initiation'},
    {control:'RSK 2.2',name:'Analyze risks',status:'compliant',desc:'Risk probability and impact assessed and documented'},
    {control:'RSK 3.1',name:'Risk mitigation plans',status:'compliant',desc:'Mitigation plans defined for all high-priority risks'},
    {control:'RSK 3.2',name:'Monitor risks',status:'compliant',desc:'Weekly risk review integrated into project status meetings'},
  ],
  SAM: [
    {control:'SAM 2.1',name:'Establish supplier agreements',status:'compliant',desc:'Formal contracts in place for all critical suppliers'},
    {control:'SAM 3.1',name:'Review supplier performance',status:'compliant',desc:'Quarterly supplier reviews conducted'},
    {control:'SAM 3.2',name:'Manage supplier agreements',status:'compliant',desc:'Agreement changes tracked with amendment log'},
    {control:'SAM 3.3',name:'Quantitative supplier metrics',status:'gap',desc:'Supplier performance tracking is qualitative only — no SLA KPIs defined'},
  ],
  TS: [
    {control:'TS 2.1',name:'Select technical solutions',status:'compliant',desc:'Alternative solutions evaluated before selection'},
    {control:'TS 3.1',name:'Implement technical solutions',status:'compliant',desc:'Implementation follows approved architecture and design'},
    {control:'TS 3.2',name:'Develop support documentation',status:'compliant',desc:'Technical manuals and runbooks maintained'},
    {control:'TS 3.3',name:'Technical reviews',status:'compliant',desc:'Architecture and design reviews conducted at milestones'},
  ],
  VV: [
    {control:'VV 2.1',name:'Prepare for verification',status:'compliant',desc:'Verification plans and procedures defined per project'},
    {control:'VV 3.1',name:'Perform verification',status:'compliant',desc:'Verification activities executed per plan with documented results'},
    {control:'VV 3.2',name:'Analyze verification results',status:'partial',desc:'Verification results analysed but trend analysis not performed'},
    {control:'VV 3.3',name:'Validation activities',status:'compliant',desc:'Validation with end users documented and signed off'},
  ],
  // Domain-specific PA gap data
  DM: [
    {control:'DM 2.1',name:'Establish data governance',status:'partial',desc:'Data ownership defined for major datasets but governance policy not formally approved'},
    {control:'DM 2.2',name:'Maintain data assets',status:'compliant',desc:'Data asset inventory maintained and reviewed quarterly'},
    {control:'DM 3.1',name:'Manage data lifecycle',status:'partial',desc:'Data retention and archival procedures exist but are not consistently enforced'},
    {control:'DM 3.2',name:'Ensure data availability',status:'compliant',desc:'Data availability SLAs defined and monitored'},
  ],
  DQ: [
    {control:'DQ 2.1',name:'Define data quality criteria',status:'missing',desc:'No formal data quality rules or acceptance thresholds defined for operational data feeds'},
    {control:'DQ 2.2',name:'Measure data quality',status:'partial',desc:'Ad hoc data quality checks performed but not automated or systematically tracked'},
    {control:'DQ 3.1',name:'Remediate data quality issues',status:'partial',desc:'Issues corrected reactively; no root cause process to prevent recurrence'},
    {control:'DQ 3.2',name:'Report data quality status',status:'missing',desc:'No data quality dashboard or reporting mechanism in place'},
  ],
  WE: [
    {control:'WE 2.1',name:'Identify workforce needs',status:'compliant',desc:'Workforce planning aligned with project demand forecasting'},
    {control:'WE 2.2',name:'Recruit and onboard',status:'compliant',desc:'Onboarding process documented and consistently followed'},
    {control:'WE 3.1',name:'Develop workforce competencies',status:'partial',desc:'Competency framework defined but development plans not consistently created for all roles'},
    {control:'WE 3.2',name:'Maintain workforce engagement',status:'partial',desc:'Engagement surveys conducted annually; action plans not always tracked to closure'},
  ],
  ESAF: [
    {control:'ESAF 2.1',name:'Identify safety hazards',status:'missing',desc:'No safety hazard log exists for current release — critical gap'},
    {control:'ESAF 2.2',name:'Analyze safety risks',status:'missing',desc:'Safety risk analysis not performed for high-criticality system components'},
    {control:'ESAF 3.1',name:'Implement safety controls',status:'partial',desc:'Some safety controls in place for known risks but not systematically applied'},
    {control:'ESAF 3.2',name:'Monitor safety status',status:'partial',desc:'Safety monitoring is manual and lacks automated alerting'},
  ],
  ESEC: [
    {control:'ESEC 2.1',name:'Identify security requirements',status:'compliant',desc:'Security requirements captured during RDM and mapped to controls'},
    {control:'ESEC 2.2',name:'Implement security controls',status:'partial',desc:'Security controls implemented for most requirements; 3 high-priority items open'},
    {control:'ESEC 3.1',name:'Assess security posture',status:'partial',desc:'Last security assessment was 6 months ago; not aligned with release cadence'},
    {control:'ESEC 3.2',name:'Manage security findings',status:'compliant',desc:'Security findings tracked in backlog with owner assignments'},
  ],
  MST: [
    {control:'MST 2.1',name:'Identify threats & vulnerabilities',status:'partial',desc:'Vulnerability scanning in place but threat modeling is outdated'},
    {control:'MST 3.1',name:'Maintain threat model',status:'missing',desc:'Threat model is 18 months old and does not reflect recent architecture changes'},
    {control:'MST 3.2',name:'Remediate vulnerabilities',status:'partial',desc:'Critical CVEs patched within SLA; medium and low items backlogged without target dates'},
    {control:'MST 3.3',name:'Monitor for threats',status:'compliant',desc:'SIEM in place with active alerting for known attack patterns'},
  ],
  SDM: [
    {control:'SDM 2.1',name:'Establish service delivery approach',status:'compliant',desc:'Service catalog defined with agreed SLAs for each service offering'},
    {control:'SDM 2.2',name:'Deliver services',status:'compliant',desc:'Service delivery processes followed and SLAs met for 96% of tickets'},
    {control:'SDM 3.1',name:'Monitor service delivery',status:'compliant',desc:'Real-time service dashboards in place and reviewed daily'},
    {control:'SDM 3.2',name:'Improve service delivery',status:'partial',desc:'Improvement actions identified from retrospectives but not systematically tracked'},
  ],
  STSM: [
    {control:'STSM 2.1',name:'Define service strategy',status:'compliant',desc:'Service strategy aligned with organizational objectives and reviewed annually'},
    {control:'STSM 2.2',name:'Manage service portfolio',status:'partial',desc:'Service portfolio documented but not regularly reviewed against changing business needs'},
    {control:'STSM 3.1',name:'Plan service transitions',status:'partial',desc:'Transition plans created for major service changes but not consistently for minor ones'},
    {control:'STSM 3.2',name:'Evaluate strategic outcomes',status:'partial',desc:'Service outcomes measured but not linked to strategic KPIs'},
  ],
  SAM: [
    {control:'SAM 2.1',name:'Establish supplier agreements',status:'compliant',desc:'Formal contracts in place for all critical suppliers'},
    {control:'SAM 3.1',name:'Review supplier performance',status:'compliant',desc:'Quarterly supplier reviews conducted'},
    {control:'SAM 3.2',name:'Manage supplier agreements',status:'compliant',desc:'Agreement changes tracked with amendment log'},
    {control:'SAM 3.3',name:'Quantitative supplier metrics',status:'gap',desc:'Supplier performance tracking is qualitative only — no SLA KPIs defined'},
  ],
  EVW: [
    {control:'EVW 2.1',name:'Establish virtual work environment',status:'compliant',desc:'Collaboration tools and virtual workspace standards defined and deployed'},
    {control:'EVW 2.2',name:'Manage virtual communications',status:'partial',desc:'Communication protocols defined but not consistently followed across distributed teams'},
    {control:'EVW 3.1',name:'Assess virtual work effectiveness',status:'partial',desc:'Team health checks conducted but effectiveness metrics not formally tracked'},
    {control:'EVW 3.2',name:'Improve virtual collaboration',status:'partial',desc:'Retrospective findings documented but improvement actions lack follow-through tracking'},
  ],
  CONT: [
    {control:'CONT 2.1',name:'Identify continuity requirements',status:'compliant',desc:'Business continuity requirements documented and approved by stakeholders'},
    {control:'CONT 2.2',name:'Establish continuity plans',status:'partial',desc:'Continuity plans exist for critical services but not all dependencies are covered'},
    {control:'CONT 3.1',name:'Test continuity plans',status:'partial',desc:'Tabletop exercises conducted annually; no full failover test performed in last 18 months'},
    {control:'CONT 3.2',name:'Maintain continuity readiness',status:'partial',desc:'Plans updated after incidents but not reviewed on a scheduled cadence'},
  ],
}

const CORR_DATA = [
  {req:'R-001',desc:'User authentication',brd:'BRD §3.1',design:'DD-2.1',code:'AUTH-001',test:'TC-101',deploy:'DPL-01',status:'ok'},
  {req:'R-002',desc:'Data encryption at rest',brd:'BRD §3.2',design:'—',code:'SEC-002',test:'TC-102',deploy:'DPL-02',status:'gap'},
  {req:'R-003',desc:'Audit logging',brd:'BRD §3.3',design:'DD-4.2',code:'LOG-003',test:'TC-103',deploy:'DPL-03',status:'ok'},
  {req:'R-004',desc:'Performance SLAs',brd:'BRD §4.1',design:'—',code:'PERF-004',test:'—',deploy:'—',status:'critical'},
  {req:'R-005',desc:'Role-based access control',brd:'BRD §4.2',design:'DD-3.1',code:'RBAC-005',test:'TC-105',deploy:'DPL-05',status:'ok'},
  {req:'R-006',desc:'Data backup & recovery',brd:'BRD §5.1',design:'DD-6.3',code:'BCK-006',test:'TC-106',deploy:'—',status:'gap'},
]

const ARTIFACT_DATA = {
  'Requirements Traceability Matrix (RTM)': {
    gaps: [
      {gap:'R-002 missing design reference',severity:'major'},
      {gap:'R-004 missing design + test reference',severity:'critical'},
      {gap:'No version control history linked',severity:'minor'},
    ],
    suggestions: [
      'Add Design Document DD-SEC-002 reference for R-002',
      'Create Performance Design Document for R-004',
      'Link test cases TC-204, TC-205 for R-004',
      'Add CM baseline tag to RTM version header',
    ]
  },
  'Software Development Plan (SDP)': {
    gaps: [
      {gap:'Missing quantitative schedule performance targets (MPM 4.1)',severity:'critical'},
      {gap:'No statistical estimation model referenced',severity:'major'},
      {gap:'Resource skill matrix not linked',severity:'minor'},
    ],
    suggestions: [
      'Add QPPO section linking to Process Performance Baseline',
      'Reference parametric estimation model (e.g. COCOMO II)',
      'Attach link to skills matrix in II 2.3 section',
      'Include process tailoring rationale per OPD 2.2',
    ]
  },
  'Risk Management Plan': {
    gaps: [
      {gap:'Risk probability thresholds not quantified',severity:'major'},
      {gap:'No link to organizational risk taxonomy',severity:'minor'},
    ],
    suggestions: [
      'Define numeric probability ranges (e.g. Low: <20%, Medium: 20-60%, High: >60%)',
      'Map risk categories to organizational risk taxonomy in PAD',
      'Add escalation criteria with quantitative triggers',
    ]
  },
  'Process Performance Baseline (PPB)': {
    gaps: [
      {gap:'PPB missing for Test Execution process (MPM 4.2)',severity:'critical'},
      {gap:'PPB missing for Deployment process (MPM 4.2)',severity:'critical'},
      {gap:'Statistical control limits not calculated',severity:'major'},
      {gap:'Baseline not updated after last 2 project cycles',severity:'major'},
    ],
    suggestions: [
      'Collect test execution data from last 6 projects and compute mean/std dev',
      'Define UCL/LCL for each PPB using 3-sigma methodology',
      'Add deployment frequency and failure rate as baseline measures',
      'Schedule quarterly PPB review and update cycle',
    ]
  },
  'Configuration Management Plan': {
    gaps: [
      {gap:'CI naming convention not enforced in tool',severity:'minor'},
      {gap:'No automated integrity check defined',severity:'minor'},
    ],
    suggestions: [
      'Document CI naming standard and add validation to CI tool',
      'Define automated integrity check script run at each baseline',
    ]
  },
  'Quality Assurance Plan': {
    gaps: [
      {gap:'QA sampling criteria not quantified (PR 3.1)',severity:'major'},
      {gap:'Defect removal efficiency target not defined',severity:'major'},
      {gap:'No QA metrics dashboard linked',severity:'minor'},
    ],
    suggestions: [
      'Define minimum QA coverage: e.g. 100% of high-risk artifacts, 30% random sample others',
      'Set defect removal efficiency target ≥ 85% before system test',
      'Link to project metrics dashboard for real-time QA status',
    ]
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const severityBadge = s => s==='critical'?'badge-danger':s==='major'?'badge-warning':s==='minor'?'badge-info':'badge-gray'
const statusBadge = s => s==='compliant'?'badge-success':s==='missing'||s==='gap'?'badge-danger':'badge-warning'
const afrClass = s => s==='critical'?'gap':s==='major'?'missing':'ok'

const CMMI_EXTENSIONS = ['pdf','docx','doc','xlsx','xls','txt','pptx','ppt','csv','md']
function getFileExt(name) { return name.split('.').pop().toLowerCase() }
function classifyFile(name) {
  const n = name.toLowerCase()
  if (n.includes('rtm') || n.includes('traceability')) return 'RDM'
  if (n.includes('threat') || n.includes('vulnerability') || n.includes('pentest')) return 'MST'
  if (n.includes('security') || n.includes('esec')) return 'ESEC'
  if (n.includes('safety') || n.includes('hazard')) return 'ESAF'
  if (n.includes('data quality') || n.includes('dq ')) return 'DQ'
  if (n.includes('data management') || n.includes(' dm ') || n.includes('data govern')) return 'DM'
  if (n.includes('service delivery') || n.includes('sdm')) return 'SDM'
  if (n.includes('service strategy') || n.includes('stsm')) return 'STSM'
  if (n.includes('continuity') || n.includes('bcp') || n.includes('disaster')) return 'CONT'
  if (n.includes('supplier') || n.includes('vendor')) return 'SAM'
  if (n.includes('risk')) return 'RSK'
  if (n.includes('virtual') || n.includes('remote team')) return 'EVW'
  if (n.includes('workforce') || n.includes('onboard') || n.includes('empowerment')) return 'WE'
  if (n.includes('training')) return 'OT'
  if (n.includes('qa') || n.includes('quality assurance') || n.includes('audit')) return 'PQA'
  if (n.includes('peer review')) return 'PR'
  if (n.includes('config') || n.includes('cm plan')) return 'CM'
  if (n.includes('performance') || n.includes('ppb') || n.includes('baseline')) return 'MPM'
  if (n.includes('integration') || n.includes(' pi ')) return 'PI'
  if (n.includes('sdp') || n.includes('dev plan') || n.includes('technical solution')) return 'TS'
  if (n.includes('verification') || n.includes(' vv ') || n.includes('_vv_')) return 'VV'
  if (n.includes('estimat') || n.includes(' est ') || n.includes('_est_')) return 'EST'
  if (n.includes('decision analysis') || n.includes(' dar ') || n.includes('_dar_')) return 'DAR'
  if (n.includes('governance') || n.includes(' gov ') || n.includes('_gov_')) return 'GOV'
  if (n.includes('monitor') || n.includes(' mc ') || n.includes('_mc_')) return 'MC'
  if (n.includes('process asset') || n.includes(' pad ') || n.includes('_pad_')) return 'PAD'
  if (n.includes(' ii ') || n.includes('_ii_')) return 'II'
  if (n.includes('plan')) return 'PLAN'
  if (n.includes('process')) return 'PCM'
  return 'General'
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

function exportAFRtoPDF(filter, auditMeta) {
  const filtered = filter === 'all' ? AFR_DATA : AFR_DATA.filter(a => a.severity === filter)
  const lines = []
  lines.push('CMMI V3.0 AUDIT FINDINGS REPORT')
  lines.push('')
  if (auditMeta) {
    lines.push(`Audit Name      : ${auditMeta.auditName}`)
    lines.push(`Auditors Name   : ${auditMeta.auditorsName}`)
    lines.push(`Auditees Name   : ${auditMeta.auditeesName}`)
    lines.push(`Audit Date      : ${auditMeta.auditDate}`)
    lines.push(`Project Name    : ${auditMeta.projectName}`)
  }
  lines.push('Generated: ' + new Date().toLocaleDateString())
  lines.push('Overall Score: 78/100  |  Open AFRs: 11  |  Critical: 3')
  lines.push('─'.repeat(60))
  lines.push('')
  filtered.forEach((a, i) => {
    lines.push(`${i+1}. [${a.severity.toUpperCase()}] ${a.id} — ${a.pa}`)
    lines.push(`   Title: ${a.title}`)
    lines.push(`   Description: ${a.desc}`)
    lines.push(`   Artifact(s): ${a.artifact}`)
    lines.push(`   Recommendation: ${a.recommendation}`)
    lines.push('')
  })
  const content = lines.join('\n')
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `CMMI_AFR_Report_${new Date().toISOString().slice(0,10)}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Scan Helpers ────────────────────────────────────────────────────────────

function matchesCode(name, code) {
  const upper = name.toUpperCase().replace(/[_\-\s.]/g, '')
  return upper === code ||
    upper.startsWith(code + '(') ||
    (upper.length > code.length && upper.startsWith(code) && !/[A-Z]/.test(upper[code.length]))
}

async function scanRepository(dirHandle) {
  const results = {}
  PRACTICE_AREAS.forEach(pa => { results[pa.code] = 'missing' })

  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory') {
      PRACTICE_AREAS.forEach(pa => {
        if (matchesCode(entry.name, pa.code)) results[pa.code] = 'available'
      })
      try {
        for await (const sub of entry.values()) {
          if (sub.kind === 'file') {
            const ext = getFileExt(sub.name)
            if (CMMI_EXTENSIONS.includes(ext)) {
              const code = classifyFile(sub.name)
              if (code !== 'General' && results[code] !== undefined) results[code] = 'available'
              const base = sub.name.replace(/\.[^.]+$/, '')
              PRACTICE_AREAS.forEach(pa => {
                if (matchesCode(base, pa.code)) results[pa.code] = 'available'
              })
            }
          }
        }
      } catch (_) {}
    } else if (entry.kind === 'file') {
      const ext = getFileExt(entry.name)
      if (CMMI_EXTENSIONS.includes(ext)) {
        const code = classifyFile(entry.name)
        if (code !== 'General' && results[code] !== undefined) results[code] = 'available'
        const base = entry.name.replace(/\.[^.]+$/, '')
        PRACTICE_AREAS.forEach(pa => {
          if (matchesCode(base, pa.code)) results[pa.code] = 'available'
        })
      }
    }
  }
  return results
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

// One practice-area tile. Shared by the core and every domain-specific section
// so spacing, typography and card styling stay identical across the dashboard.
function PracticeAreaCard({ pa, hasScan, scanResults }) {
  const available = hasScan && scanResults[pa.code] === 'available'
  return (
    <div className={`pa-card${hasScan && !available ? ' pa-card-missing' : ''}`}>
      <div style={{minWidth:0}}>
        <span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{pa.code}</span>
        <span style={{fontSize:11,color:'var(--color-text-secondary)',marginLeft:6}}>{pa.name}</span>
      </div>
      {hasScan ? (
        <span className={`badge ${available?'badge-success':'badge-danger'}`} style={{fontSize:10,flexShrink:0,marginLeft:6}}>
          {available?'Available':'Missing Document'}
        </span>
      ) : (
        <span style={{fontSize:11,fontWeight:500,flexShrink:0,marginLeft:6,color:pa.score>=85?'#639922':pa.score>=70?'#185FA5':'#E24B4A'}}>{pa.score}%</span>
      )}
    </div>
  )
}

function PracticeAreaGrid({ items, hasScan, scanResults }) {
  return (
    <div className="pa-grid">
      {items.map(pa => <PracticeAreaCard key={pa.code} pa={pa} hasScan={hasScan} scanResults={scanResults}/>)}
    </div>
  )
}

// Domain-specific section, rendered below the core practice areas with its own
// heading. One of these per selected domain (all eight when "All Domains").
function DomainSection({ domain, hasScan, scanResults, heading, subheading }) {
  const available = hasScan ? domain.pas.filter(pa => scanResults[pa.code] === 'available').length : 0
  const missing = domain.pas.length - available
  return (
    <div className="card">
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:'1rem'}}>
        <div>
          <div className="section-title" style={{margin:0}}>{heading}</div>
          <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>{subheading}</div>
        </div>
        {hasScan ? (
          <span style={{fontSize:12,color:'var(--color-text-secondary)'}}>
            <span style={{color:'#639922',fontWeight:500}}>{available} available</span>
            {' · '}
            <span style={{color:'#E24B4A',fontWeight:500}}>{missing} missing</span>
          </span>
        ) : (
          <span className="badge badge-gray">{domain.pas.length} practice area{domain.pas.length!==1?'s':''}</span>
        )}
      </div>
      <PracticeAreaGrid items={domain.pas} hasScan={hasScan} scanResults={scanResults}/>
    </div>
  )
}

function Dashboard({ switchTab, addChatMessage, scanResults, paReports, ncStore, commentsStore, pkgAvailability, irpIssueLog, irpDataValidation, irpAuditResult, onOpenGapReport, auditMeta, evidenceScanRows }) {
  // Multi-select — [] means "All Domains" (see DomainMultiSelect/domainsForSelection).
  const [selectedDomains, setSelectedDomains] = useState([])
  // Owned here (not inside GapAnalysisDashboardSection) so the always-visible
  // "Audit Report" section below can also respect the active filters.
  const [findingsFilters, setFindingsFilters] = useState(DEFAULT_FILTERS)
  const { filteredPaReports: afrPaReports, filteredNcStore: afrNcStore } = applyDashboardFilters(paReports, ncStore || {}, findingsFilters, auditMeta || {})

  // Core PAs are always visible; domain sections follow the current selection.
  const corePAs = CORE_PRACTICE_AREAS
  const visibleDomains = domainsForSelection(selectedDomains)
  const domainPAs = visibleDomains.flatMap(d => d.pas)
  const visiblePAs = [...corePAs, ...domainPAs]
  const visibleCodes = new Set(visiblePAs.map(pa => pa.code))
  const visibleAFRs = AFR_DATA.filter(a => visibleCodes.has(a.pa))

  const avgScore = Math.round(visiblePAs.reduce((sum, pa) => sum + pa.score, 0) / visiblePAs.length)
  const criticalAFRs = visibleAFRs.filter(a => a.severity === 'critical').length
  const compliantCount = visiblePAs.filter(p => p.status === 'compliant').length
  const criticalPACount = visiblePAs.filter(p => p.status === 'critical').length
  const partialCount = visiblePAs.filter(p => p.status === 'partial').length
  const ringOffset = Math.round(345.6 * (1 - avgScore / 100))

  const hasScan = scanResults && Object.keys(scanResults).length > 0
  const availableCount = hasScan ? visiblePAs.filter(pa => scanResults[pa.code] === 'available').length : 0
  const missingCount = hasScan ? visiblePAs.length - availableCount : 0
  const coreAvailable = hasScan ? corePAs.filter(pa => scanResults[pa.code] === 'available').length : 0
  const coreMissing = corePAs.length - coreAvailable

  // ── Real, domain-filtered PA Validation KPIs ────────────────────────────
  // Driven entirely by pkgAvailability (Stage-1 folder scan, lifted from PA
  // Validation) + paReports (Stage-2 compliance) — never hardcoded/mock.
  // hasValidationData distinguishes "nothing uploaded yet" from "uploaded,
  // zero available" so the KPI section doesn't misreport an empty session.
  const hasValidationData = pkgAvailability !== null && pkgAvailability !== undefined
  const kpiCodes = [...visibleCodes]
  const kpiStatuses = kpiCodes.map(code => combinedPAStatus(code, pkgAvailability, paReports))
  const kpiAvailable = kpiStatuses.filter(s => s === 'Available').length
  const kpiMissing = kpiStatuses.filter(s => s === 'Missing').length
  const kpiGap = kpiStatuses.filter(s => s === 'Gap').length
  const kpiCore = corePAs.length
  const kpiScore = kpiCodes.length ? Math.round((kpiAvailable / kpiCodes.length) * 100) : 0
  const domainWiseStats = visibleDomains.map(d => computeDomainStats(d, pkgAvailability, paReports))

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap',marginBottom:'1.25rem'}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:500,color:'var(--color-text-primary)'}}>Audit dashboard</h2>
          <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>CMMI V3.0 · Maturity level 5 · Real-time analysis</div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <span style={{fontSize:12,color:'var(--color-text-secondary)'}}>Domain</span>
          <DomainMultiSelect selected={selectedDomains} onChange={setSelectedDomains} />
          <button className="btn btn-primary" onClick={() => { switchTab('chatbot'); addChatMessage('Run a full CMMI Level 5 audit analysis on my organization and prioritize all open AFRs') }}>
            <IconPlayerPlay size={14}/> Run full audit ↗
          </button>
        </div>
      </div>

      {/* ── Audit Report ─────────────────────────────────────────────────────
          ALWAYS visible — never gated on any Practice Area having produced
          findings yet. Respects the Findings Filters below once touched. ── */}
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="section-title" style={{ margin: 0 }}>Audit Report</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              CMMI Audit Findings Report (AFR), generated from the current audit information{Object.keys(paReports).length > 0 ? ' and validated Practice Area findings' : ''}
              {isFiltersActive(findingsFilters) ? ' (currently filtered — see Findings Filters below)' : ''}.
            </div>
          </div>
          <AFRDownloadMenu paReports={afrPaReports} ncStore={afrNcStore} commentsStore={commentsStore} auditMeta={auditMeta} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} selectedDomains={selectedDomains} evidenceScanRows={evidenceScanRows} variant="split" />
        </div>
      </div>

      {/* ── Domain-Wise Practice Area Validation ────────────────────────────
          Real KPIs, computed only from the selected Domain(s) + the actual
          PA Validation scan data (pkgAvailability/paReports) — never
          hardcoded. Distinct from the legacy mock score cards below, which
          are untouched. ─────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="section-title" style={{ marginBottom: 2 }}>Practice Area Validation Results</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          {hasValidationData
            ? `Domain(s): ${selectedDomains.length === 0 ? 'All Domains' : visibleDomains.map(d => d.code).join(', ')}`
            : 'No folder has been scanned yet — upload a Practice Area folder in PA Validation to populate these results.'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12, marginBottom: '1.25rem' }}>
          {[
            ['Total Practice Areas', kpiCodes.length, 'var(--color-text-primary)'],
            ['Total Core Practice Areas', kpiCore, 'var(--color-text-primary)'],
            ['Available Practice Areas', kpiAvailable, '#639922'],
            ['Missing Practice Areas', kpiMissing, '#E24B4A'],
            ['Gap Practice Areas', kpiGap, '#BA7517'],
            ['Overall Practice Area Score', `${kpiScore}%`, '#185FA5'],
          ].map(([label, val, color]) => (
            <div key={label} className="metric-card">
              <div className="metric-label">{label}</div>
              <div className="metric-value" style={{ color }}>{val}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 8 }}>Domain-Wise Breakdown</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {['Domain', 'Total PA', 'Core PA', 'Available', 'Missing', 'Gap', 'Score'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {domainWiseStats.map(s => (
                <tr key={s.domain} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                  <td style={{ padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-primary)' }}>{s.domain}</td>
                  <td style={{ padding: '8px 10px' }}>{s.total}</td>
                  <td style={{ padding: '8px 10px' }}>{s.core}</td>
                  <td style={{ padding: '8px 10px', color: '#639922', fontWeight: 500 }}>{s.available}</td>
                  <td style={{ padding: '8px 10px', color: s.missing > 0 ? '#E24B4A' : 'var(--color-text-secondary)', fontWeight: 500 }}>{s.missing}</td>
                  <td style={{ padding: '8px 10px', color: s.gap > 0 ? '#BA7517' : 'var(--color-text-secondary)', fontWeight: 500 }}>{s.gap}</td>
                  <td style={{ padding: '8px 10px', fontWeight: 600, color: '#185FA5' }}>{s.score}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:'1.25rem'}}>
        <div className="metric-card">
          <div className="metric-label">{hasScan ? 'Available' : 'Overall score'}</div>
          <div className="metric-value" style={{color:'#185FA5'}}>{hasScan ? availableCount : `${avgScore}%`}</div>
          <div className="metric-sub">{hasScan ? 'Practice areas found' : '↑ 5% from last audit'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Practice areas</div>
          <div className="metric-value">{corePAs.length}</div>
          <div className="metric-sub">Core practice areas</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Open AFRs</div>
          <div className="metric-value" style={{color:'#A32D2D'}}>{visibleAFRs.length}</div>
          <div className="metric-sub">{criticalAFRs} critical</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{hasScan ? 'Missing' : 'Artifacts analyzed'}</div>
          <div className="metric-value" style={{color:hasScan&&missingCount>0?'#A32D2D':undefined}}>{hasScan ? missingCount : 47}</div>
          <div className="metric-sub">{hasScan ? 'Practice areas missing' : '8 with gaps'}</div>
        </div>
      </div>

      <div className="row">
        <div className="col" style={{flex:1.5}}>
          <div className="card">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
              <div className="section-title" style={{margin:0}}>Core Practice Areas</div>
              {hasScan ? (
                <span style={{fontSize:12,color:'var(--color-text-secondary)'}}>
                  <span style={{color:'#639922',fontWeight:500}}>{availableCount} available</span>
                  {' · '}
                  <span style={{color:'#E24B4A',fontWeight:500}}>{missingCount} missing</span>
                </span>
              ) : (
                <span className="badge badge-info">Level 5 targets</span>
              )}
            </div>
            {!hasScan && (
              <div style={{marginBottom:12,padding:'10px 12px',background:'rgba(55,138,221,0.06)',borderRadius:'var(--border-radius-md)',borderLeft:'3px solid #378ADD',fontSize:12,color:'var(--color-text-secondary)'}}>
                Upload your repository in{' '}
                <span style={{color:'#185FA5',cursor:'pointer',fontWeight:500}} onClick={() => switchTab('repository')}>Repository Scan</span>
                {' '}to see document availability for each practice area.
              </div>
            )}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
              {corePAs.map(pa => (
                <div key={pa.code} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'7px 10px',borderRadius:'var(--border-radius-md)',border:'0.5px solid var(--color-border-tertiary)',background:hasScan&&scanResults[pa.code]==='missing'?'rgba(226,75,74,0.04)':'var(--color-background-secondary)'}}>
                  <div style={{minWidth:0}}>
                    <span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{pa.code}</span>
                    <span style={{fontSize:11,color:'var(--color-text-secondary)',marginLeft:6}}>{pa.name}</span>
                  </div>
                  {hasScan ? (
                    <span className={`badge ${scanResults[pa.code]==='available'?'badge-success':'badge-danger'}`} style={{fontSize:10,flexShrink:0,marginLeft:6}}>
                      {scanResults[pa.code]==='available'?'Available':'Missing Document'}
                    </span>
                  ) : (
                    <span style={{fontSize:11,fontWeight:500,flexShrink:0,marginLeft:6,color:pa.score>=85?'#639922':pa.score>=70?'#185FA5':'#E24B4A'}}>{pa.score}%</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="col" style={{flex:1}}>
          <div className="card" style={{textAlign:'center'}}>
            <div className="section-title" style={{marginBottom:'1.25rem'}}>Audit score</div>
            <div className="score-ring">
              <svg width="130" height="130" viewBox="0 0 130 130">
                <circle cx="65" cy="65" r="55" fill="none" stroke="var(--color-background-secondary)" strokeWidth="14"/>
                <circle cx="65" cy="65" r="55" fill="none" stroke="#185FA5" strokeWidth="14" strokeDasharray="345.6" strokeDashoffset={ringOffset} strokeLinecap="round"/>
              </svg>
              <div className="score-text">
                <div style={{fontSize:26,fontWeight:500,color:'var(--color-text-primary)'}}>{avgScore}</div>
                <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>/ 100</div>
              </div>
            </div>
            <div style={{marginTop:'1rem',display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,textAlign:'left'}}>
              {[
                ['#639922', `Compliant: ${compliantCount}`],
                ['#E24B4A', `Critical: ${criticalPACount}`],
                ['#BA7517', `Partial: ${partialCount}`],
              ].map(([c,l]) => (
                <div key={l} style={{fontSize:12}}><span style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:c,marginRight:6}}/>{l}</div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="section-title" style={{marginBottom:10,fontSize:14}}>Quick actions</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              <button className="btn" onClick={() => switchTab('gaps')} style={{justifyContent:'flex-start',fontSize:12}}><IconZoomCode size={14}/> View gap report</button>
              <button className="btn" onClick={() => switchTab('afr')} style={{justifyContent:'flex-start',fontSize:12}}><IconReport size={14}/> Generate AFR</button>
              <button className="btn" onClick={() => switchTab('chatbot')} style={{justifyContent:'flex-start',fontSize:12}}><IconMessageChatbot size={14}/> Chat with AI guide</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{marginTop:'1.25rem'}}>
        {selectedDomains.length === 0 && (
          <div className="section-title" style={{marginBottom:10}}>Domain-Specific Practice Areas</div>
        )}
        {visibleDomains.map(d => (
          <DomainSection
            key={d.id}
            domain={d}
            hasScan={hasScan}
            scanResults={scanResults}
            heading={selectedDomains.length === 0 ? `${d.label} Practice Areas` : `${d.label} — Related Practice Areas`}
            subheading={`Domain: ${d.label} (${d.code})`}
          />
        ))}
      </div>

      <GapAnalysisDashboardSection paReports={paReports} ncStore={ncStore} commentsStore={commentsStore} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} selectedDomains={selectedDomains} onOpenGapReport={onOpenGapReport} auditMeta={auditMeta} filters={findingsFilters} setFilters={setFindingsFilters} evidenceScanRows={evidenceScanRows} />
    </div>
  )
}

// ─── Gap Analysis Dashboard Section ────────────────────────────────────────────
// Additive to the Dashboard — shows the live, per-Practice-Area Gap Analysis
// results produced by PA Validation. Automatically reflects `paReports` since
// that state lives in App and is re-rendered fresh whenever it changes.

function ChartLegend({ items }) {
  return (
    <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
      {items.map(([color, label]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--color-text-secondary)' }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block', flexShrink: 0 }} />{label}
        </div>
      ))}
    </div>
  )
}

function complianceStatusColor(status) {
  return status === 'Compliant' ? '#639922' : status === 'Partially Compliant' ? '#BA7517' : '#A32D2D'
}

function ComplianceBarChart({ items }) {
  const trackHeight = 130
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: trackHeight, padding: '0 4px', borderBottom: '1px solid var(--color-border-tertiary)' }}>
        {items.map(r => (
          <div key={r.paCode} title={`${r.paCode}: ${r.compliancePct}% (${r.overallStatus})`}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0, height: '100%', justifyContent: 'flex-end' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: complianceStatusColor(r.overallStatus), marginBottom: 3 }}>{r.compliancePct}%</div>
            <div style={{ width: '100%', maxWidth: 22, height: `${Math.max(r.compliancePct, 2)}%`, background: complianceStatusColor(r.overallStatus), borderRadius: '4px 4px 0 0' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, padding: '6px 4px 0' }}>
        {items.map(r => (
          <div key={r.paCode} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: 10, fontWeight: 500, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.paCode}</div>
        ))}
      </div>
      <ChartLegend items={[['#639922', 'Compliant'], ['#BA7517', 'Partially Compliant'], ['#A32D2D', 'Non-Compliant']]} />
    </div>
  )
}

function GapDistributionChart({ items }) {
  const maxTotal = Math.max(1, ...items.map(r => r.criticalCount + r.majorCount + r.minorCount))
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map(r => {
          const total = r.criticalCount + r.majorCount + r.minorCount
          const widthPct = total === 0 ? 0 : (total / maxTotal) * 100
          return (
            <div key={r.paCode} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 40, fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)', flexShrink: 0 }}>{r.paCode}</div>
              <div style={{ flex: 1, background: 'var(--color-background-secondary)', borderRadius: 4, height: 16, overflow: 'hidden' }}>
                {total > 0 && (
                  <div style={{ display: 'flex', width: `${widthPct}%`, height: '100%' }}>
                    {r.criticalCount > 0 && <div title={`Critical: ${r.criticalCount}`} style={{ width: `${(r.criticalCount / total) * 100}%`, background: '#E24B4A', marginRight: r.majorCount + r.minorCount > 0 ? 2 : 0 }} />}
                    {r.majorCount > 0 && <div title={`Major: ${r.majorCount}`} style={{ width: `${(r.majorCount / total) * 100}%`, background: '#BA7517', marginRight: r.minorCount > 0 ? 2 : 0 }} />}
                    {r.minorCount > 0 && <div title={`Minor: ${r.minorCount}`} style={{ width: `${(r.minorCount / total) * 100}%`, background: '#378ADD' }} />}
                  </div>
                )}
              </div>
              <div style={{ width: 20, fontSize: 10, color: 'var(--color-text-secondary)', textAlign: 'right', flexShrink: 0 }}>{total}</div>
            </div>
          )
        })}
      </div>
      <ChartLegend items={[['#E24B4A', 'Critical'], ['#BA7517', 'Major'], ['#378ADD', 'Minor']]} />
    </div>
  )
}

function DocAvailabilityDonut({ available, missing }) {
  const total = available + missing
  const C = 345.6
  const gapLen = available > 0 && missing > 0 ? 4 : 0
  const availLen = total === 0 ? 0 : Math.max(0, (available / total) * C - gapLen)
  const missLen = total === 0 ? 0 : Math.max(0, (missing / total) * C - gapLen)
  return (
    <div>
      <div className="score-ring">
        <svg width="130" height="130" viewBox="0 0 130 130">
          <circle cx="65" cy="65" r="55" fill="none" stroke="var(--color-background-secondary)" strokeWidth="14" />
          {available > 0 && (
            <circle cx="65" cy="65" r="55" fill="none" stroke="#639922" strokeWidth="14" strokeDasharray={`${availLen} ${C - availLen}`} strokeDashoffset="0" />
          )}
          {missing > 0 && (
            <circle cx="65" cy="65" r="55" fill="none" stroke="#A32D2D" strokeWidth="14" strokeDasharray={`${missLen} ${C - missLen}`} strokeDashoffset={-(availLen + gapLen)} />
          )}
        </svg>
        <div className="score-text">
          <div style={{ fontSize: 22, fontWeight: 500, color: 'var(--color-text-primary)' }}>{total}</div>
          <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>Documents</div>
        </div>
      </div>
      <ChartLegend items={[['#639922', `Available (${available})`], ['#A32D2D', `Missing (${missing})`]]} />
    </div>
  )
}

function OverallComplianceRing({ avgCompliance, compliantN, partialN, nonCompliantN }) {
  const C = 345.6
  const offset = Math.round(C * (1 - avgCompliance / 100))
  const color = avgCompliance === 100 ? '#639922' : avgCompliance >= 80 ? '#BA7517' : '#A32D2D'
  return (
    <div>
      <div className="score-ring">
        <svg width="130" height="130" viewBox="0 0 130 130">
          <circle cx="65" cy="65" r="55" fill="none" stroke="var(--color-background-secondary)" strokeWidth="14" />
          <circle cx="65" cy="65" r="55" fill="none" stroke={color} strokeWidth="14" strokeDasharray={C} strokeDashoffset={offset} strokeLinecap="round" />
        </svg>
        <div className="score-text">
          <div style={{ fontSize: 22, fontWeight: 500, color: 'var(--color-text-primary)' }}>{avgCompliance}%</div>
          <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>Avg compliance</div>
        </div>
      </div>
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
        {[['#639922', `Compliant: ${compliantN}`], ['#BA7517', `Partial: ${partialN}`], ['#A32D2D', `Non-Compliant: ${nonCompliantN}`]].map(([c, l]) => (
          <div key={l} style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, marginRight: 5 }} />{l}</div>
        ))}
      </div>
    </div>
  )
}

function DashboardDownloadButton({ paReports, auditMeta, irpAuditResult }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setOpen(o => !o)}>
        <IconDownload size={14} /> Download Report
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '110%', background: '#fff', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)', boxShadow: '0 4px 16px rgba(0,0,0,0.14)', zIndex: 20, minWidth: 170, overflow: 'hidden' }}>
          <div style={{ padding: '9px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text-primary)' }}
            onMouseDown={() => { setOpen(false); downloadCombinedGapReportPDF(paReports, auditMeta || {}, irpAuditResult) }}>📄 Download as PDF</div>
          <div style={{ padding: '9px 12px', fontSize: 12, cursor: 'pointer', borderTop: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-primary)' }}
            onMouseDown={() => { setOpen(false); downloadGapReportExcel(paReports, auditMeta || {}, irpAuditResult) }}>📊 Download as Excel</div>
        </div>
      )}
    </div>
  )
}

// Shared "Download AFR" control — Excel / Word, generated dynamically from
// the real paReports/ncStore/commentsStore/auditMeta passed in (never
// static data). Reused by both the PA Validation page and the Dashboard.
//
// IMPORTANT: this control is ALWAYS visible and ALWAYS enabled — it must not
// depend on any Practice Area having been validated yet, or on checklists.js
// having content. With zero findings, downloadAFRExcel/downloadAFRWord still
// produce a valid report containing the real audit information and a
// "No findings available for this audit." notice — never fake data.
//
// `variant="split"` renders two always-visible buttons side by side
// ("Download Excel AFR" / "Download Word AFR") instead of a single
// dropdown-triggered button — used for the dedicated "Audit Report" section
// so the two actions are unmistakably present without an extra click.
function AFRDownloadMenu({ paReports, ncStore, commentsStore, auditMeta, pkgAvailability, irpIssueLog, irpDataValidation, irpAuditResult, selectedDomains, evidenceScanRows, variant = 'dropdown' }) {
  const [open, setOpen] = useState(false)
  const [generatingExcel, setGeneratingExcel] = useState(false)
  const [generatingWord, setGeneratingWord] = useState(false)

  const afrContext = () => ({
    paReportsMap: paReports, ncStoreMap: ncStore, meta: auditMeta || {},
    pkgAvailability, irpIssueLog, irpDataValidation, irpAuditResult, selectedDomains: selectedDomains || [],
    evidenceScanRows: evidenceScanRows || [],
  })

  const handleExcel = () => {
    setOpen(false)
    setGeneratingExcel(true)
    try { downloadAFRExcel(afrContext()) }
    finally { setGeneratingExcel(false) }
  }
  const handleWord = async () => {
    setOpen(false)
    setGeneratingWord(true)
    try { await downloadAFRWord(afrContext()) }
    finally { setGeneratingWord(false) }
  }

  if (variant === 'split') {
    return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={handleExcel} disabled={generatingExcel}>
          <IconFileExport size={14} /> {generatingExcel ? 'Generating…' : 'Download Excel AFR'}
        </button>
        <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={handleWord} disabled={generatingWord}>
          <IconFileExport size={14} /> {generatingWord ? 'Generating…' : 'Download Word AFR'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn btn-primary"
        style={{ fontSize: 12 }}
        onClick={() => setOpen(o => !o)}
        disabled={generatingExcel || generatingWord}
      >
        <IconFileExport size={14} /> {generatingExcel || generatingWord ? 'Generating…' : 'Download AFR'}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '110%', background: '#fff', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)', boxShadow: '0 4px 16px rgba(0,0,0,0.14)', zIndex: 20, minWidth: 190, overflow: 'hidden' }}>
          <div style={{ padding: '9px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text-primary)' }} onMouseDown={handleExcel}>📊 Download Excel AFR</div>
          <div style={{ padding: '9px 12px', fontSize: 12, cursor: 'pointer', borderTop: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-primary)' }} onMouseDown={handleWord}>📝 Download Word AFR</div>
        </div>
      )}
    </div>
  )
}

// Multi-select chip group used throughout DashboardFilters.
function FilterChipGroup({ label, options, selected, onToggle, note, emptyText }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
        {label} {note && <span style={{ color: 'var(--color-text-tertiary)' }}>({note})</span>}
      </label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {options.length === 0 && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{emptyText}</span>}
        {options.map(opt => (
          <span
            key={opt}
            className="chip"
            style={selected.includes(opt) ? { borderColor: '#378ADD', color: '#185FA5', background: 'rgba(55,138,221,0.08)' } : undefined}
            onClick={() => onToggle(opt)}
          >
            {opt}
          </span>
        ))}
      </div>
    </div>
  )
}

// Dashboard-level findings filters (Project / Practice Area / Auditor /
// Audit / Date / Severity / Status). Project/Audit are single-value gates
// (this app captures exactly one audit/project per session — see
// dashboardFilters.js); Auditor is display-only (findings aren't attributed
// per-auditor in the data model).
function DashboardFilters({ paReports, auditMeta, filters, setFilters }) {
  const paCodes = Object.keys(paReports)
  const toggle = (key, value) => setFilters(prev => {
    const list = prev[key]
    return { ...prev, [key]: list.includes(value) ? list.filter(v => v !== value) : [...list, value] }
  })
  const setSingle = (key, value) => setFilters(prev => ({ ...prev, [key]: value ? [value] : [] }))

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0, fontSize: 13 }}>Findings Filters</div>
        {isFiltersActive(filters) && (
          <span style={{ fontSize: 11, color: '#185FA5', cursor: 'pointer', fontWeight: 500 }} onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Project</label>
          <select value={filters.projects[0] || ''} onChange={e => setSingle('projects', e.target.value)}>
            <option value="">All{auditMeta?.projectName ? ` (${auditMeta.projectName})` : ''}</option>
            {auditMeta?.projectName && <option value={auditMeta.projectName}>{auditMeta.projectName}</option>}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Audit</label>
          <select value={filters.audits[0] || ''} onChange={e => setSingle('audits', e.target.value)}>
            <option value="">All{auditMeta?.auditName ? ` (${auditMeta.auditName})` : ''}</option>
            {auditMeta?.auditName && <option value={auditMeta.auditName}>{auditMeta.auditName}</option>}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>From Date</label>
          <input type="date" value={filters.fromDate} onChange={e => setFilters(prev => ({ ...prev, fromDate: e.target.value }))} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>To Date</label>
          <input type="date" value={filters.toDate} onChange={e => setFilters(prev => ({ ...prev, toDate: e.target.value }))} />
        </div>
      </div>
      <FilterChipGroup label="Practice Area" options={paCodes} selected={filters.practiceAreas} onToggle={v => toggle('practiceAreas', v)} emptyText="No Practice Areas validated yet" />
      <FilterChipGroup label="Severity" options={['critical', 'major', 'minor']} selected={filters.severities} onToggle={v => toggle('severities', v)} emptyText="—" />
      <FilterChipGroup label="Status" options={['Open', 'Closed']} selected={filters.statuses} onToggle={v => toggle('statuses', v)} emptyText="—" />
      <FilterChipGroup
        label="Auditor" note="display only — findings aren't attributed per-auditor"
        options={auditMeta?.auditorsList || []} selected={filters.auditors} onToggle={v => toggle('auditors', v)} emptyText="—"
      />
    </div>
  )
}

function GapAnalysisDashboardSection({ paReports, ncStore, commentsStore, pkgAvailability, irpIssueLog, irpDataValidation, irpAuditResult, selectedDomains, onOpenGapReport, auditMeta, filters, setFilters, evidenceScanRows }) {
  if (Object.keys(paReports).length === 0) {
    return (
      <div style={{ marginTop: '1rem' }}>
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <IconClipboardCheck size={32} color="var(--color-text-tertiary)" style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 6 }}>No Gap Analysis Available</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', maxWidth: 440, marginLeft: 'auto', marginRight: 'auto' }}>
            Gap Analysis results appear here automatically. Summary cards, charts, and a downloadable report will be generated as soon as a Practice Area has been validated.
          </div>
        </div>
        <IrpIncidentFindingsPanel irpAuditResult={irpAuditResult} auditMeta={auditMeta} />
      </div>
    )
  }

  const { filteredPaReports, filteredNcStore } = applyDashboardFilters(paReports, ncStore || {}, filters, auditMeta || {})
  const gapList = Object.values(filteredPaReports)

  const compliantN = gapList.filter(r => r.overallStatus === 'Compliant').length
  const partialN = gapList.filter(r => r.overallStatus === 'Partially Compliant').length
  const nonCompliantN = gapList.filter(r => r.overallStatus === 'Non-Compliant').length
  const availableN = gapList.filter(r => r.documentFound).length
  const missingN = gapList.length - availableN
  const avgCompliance = gapList.length ? Math.round(gapList.reduce((s, r) => s + r.compliancePct, 0) / gapList.length) : 0

  return (
    <div style={{ marginTop: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>Gap Analysis Report</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>{gapList.length} Practice Area{gapList.length !== 1 ? 's' : ''} shown · updates automatically after each PA Validation run</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <DashboardDownloadButton paReports={filteredPaReports} auditMeta={auditMeta} irpAuditResult={irpAuditResult} />
          <AFRDownloadMenu paReports={filteredPaReports} ncStore={filteredNcStore} commentsStore={commentsStore} auditMeta={auditMeta} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} selectedDomains={selectedDomains} evidenceScanRows={evidenceScanRows} />
        </div>
      </div>

      <DashboardFilters paReports={paReports} auditMeta={auditMeta} filters={filters} setFilters={setFilters} />

      {gapList.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>No findings match the current filters.</div>
        </div>
      ) : (
        <>
          {/* Per-Practice-Area summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', gap: 12, marginBottom: '1rem' }}>
            {gapList.map(r => (
              <div
                key={r.paCode}
                className="card"
                style={{ margin: 0, cursor: 'pointer', borderTop: `3px solid ${complianceStatusColor(r.overallStatus)}` }}
                onClick={() => onOpenGapReport(r.paCode)}
                title={`Open ${r.paCode} detailed Gap Report`}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{r.paCode}</span>
                  <span className={`badge ${r.overallStatus === 'Compliant' ? 'badge-success' : r.overallStatus === 'Partially Compliant' ? 'badge-warning' : 'badge-danger'}`} style={{ fontSize: 10 }}>{r.overallStatus}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.paName}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  <span>Document</span>
                  <span style={{ fontWeight: 500, color: r.documentFound ? '#639922' : '#A32D2D' }}>{r.documentFound ? 'Available' : 'Missing'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  <span>Required Fields</span>
                  <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>{r.totalRequired}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  <span>Found / Missing</span>
                  <span style={{ fontWeight: 500 }}><span style={{ color: '#639922' }}>{r.foundCount}</span> / <span style={{ color: r.missingCount > 0 ? '#A32D2D' : 'var(--color-text-primary)' }}>{r.missingCount}</span></span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <span style={{ flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: 4, background: 'rgba(226,75,74,0.08)', fontSize: 10, color: '#A32D2D', fontWeight: 600 }}>{r.criticalCount} Crit</span>
                  <span style={{ flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: 4, background: 'rgba(186,117,23,0.08)', fontSize: 10, color: '#7a4d0f', fontWeight: 600 }}>{r.majorCount} Maj</span>
                  <span style={{ flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: 4, background: 'rgba(55,138,221,0.08)', fontSize: 10, color: '#185FA5', fontWeight: 600 }}>{r.minorCount} Min</span>
                </div>
                <div className="progress-bar" style={{ height: 6, marginBottom: 4 }}>
                  <div className="progress-fill" style={{ width: `${r.compliancePct}%`, background: complianceStatusColor(r.overallStatus) }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: 'var(--color-text-secondary)' }}>Compliance</span>
                  <span style={{ fontWeight: 600, color: complianceStatusColor(r.overallStatus) }}>{r.compliancePct}%</span>
                </div>
              </div>
            ))}
          </div>

          {/* Charts */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="section-title" style={{ fontSize: 14 }}>Practice Area-wise Compliance %</div>
            <ComplianceBarChart items={gapList} />
          </div>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="section-title" style={{ fontSize: 14 }}>Critical / Major / Minor Gap Distribution</div>
            <GapDistributionChart items={gapList} />
          </div>
          <div className="row">
            <div className="col">
              <div className="card" style={{ margin: 0, textAlign: 'center' }}>
                <div className="section-title" style={{ fontSize: 14 }}>Document Availability Status</div>
                <DocAvailabilityDonut available={availableN} missing={missingN} />
              </div>
            </div>
            <div className="col">
              <div className="card" style={{ margin: 0, textAlign: 'center' }}>
                <div className="section-title" style={{ fontSize: 14 }}>Overall Compliance Summary</div>
                <OverallComplianceRing avgCompliance={avgCompliance} compliantN={compliantN} partialN={partialN} nonCompliantN={nonCompliantN} />
              </div>
            </div>
          </div>
        </>
      )}

      <IrpIncidentFindingsPanel irpAuditResult={irpAuditResult} auditMeta={auditMeta} />
    </div>
  )
}

// IRP incident-level Gap Report — Priority Matrix mismatch, Response/
// Resolution SLA breach, RCA-missing-on-breach, RCA traceability, Closed
// Date/Time, and Issue Category gaps, each carrying its own Incident ID
// (see incidentEngine.js/rcaEngine.js/irpAudit.js). Renders independently
// of paReports/gapList — IRP incident data comes from a separate scan step
// (PAValidation's IRP folder detection) and should surface here even when
// no other Practice Area has been validated yet. Excludes pure
// header-presence findings (level === 'header'), which are already
// surfaced via the IRP Issue Log Stage-1 availability panel.
function IrpIncidentFindingsPanel({ irpAuditResult, auditMeta }) {
  const findings = getIrpIncidentFindings(irpAuditResult)
  if (findings.length === 0) return null

  const critical = findings.filter(f => f.severity === 'Critical').length
  const major = findings.filter(f => f.severity === 'Major').length
  const minor = findings.filter(f => f.severity === 'Minor').length

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="section-title" style={{ margin: 0, fontSize: 14 }}>IRP Incident Findings</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {findings.length} finding{findings.length !== 1 ? 's' : ''} from the IRP Incident Log &amp; RCA register — Priority, SLA, RCA, Closed Date/Time, Issue Category
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="badge badge-danger" style={{ fontSize: 10 }}>{critical} Critical</span>
          <span className="badge badge-warning" style={{ fontSize: 10 }}>{major} Major</span>
          <span className="badge badge-info" style={{ fontSize: 10 }}>{minor} Minor</span>
          <button
            className="btn btn-primary"
            style={{ fontSize: 12 }}
            onClick={() => downloadIrpIncidentFindingsExcel(irpAuditResult, auditMeta || {})}
          >
            <IconDownload size={14} /> Download
          </button>
        </div>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Incident ID', 'Gap Type', 'Finding', 'Actual', 'Expected', 'Severity', 'Status', 'Document/Sheet', 'Recommendation'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap', position: 'sticky', top: 0 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {findings.map(f => (
              <tr key={f.id} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                <td style={{ padding: '8px 10px', color: 'var(--color-text-primary)', fontWeight: 500, whiteSpace: 'nowrap' }}>{f.record || '—'}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{f.meta?.gapType || f.field}</td>
                <td style={{ padding: '8px 10px', minWidth: 280 }}>{f.finding}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{f.actual ?? '—'}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{f.expected ?? '—'}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  <span className={`badge ${f.severity === 'Critical' ? 'badge-danger' : f.severity === 'Major' ? 'badge-warning' : 'badge-info'}`} style={{ fontSize: 10 }}>{f.severity}</span>
                </td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  <span className="badge badge-danger" style={{ fontSize: 10 }}>Gap</span>
                </td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{f.evidence || '—'}{f.sheet && f.sheet !== f.evidence ? ` / ${f.sheet}` : ''}</td>
                <td style={{ padding: '8px 10px', minWidth: 200 }}>{f.recommendation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── IRO Validation ──────────────────────────────────────────────────────────

const IRO_FIELDS = [
  { field: 'Risk ID #',                      severity: 'minor',    synonyms: ['risk id', 'risk reference', 'risk number', 'risk ref', 'ref #', 'id #', 'risk #'] },
  { field: 'Date Raised',                    severity: 'minor',    synonyms: ['date raised', 'created date', 'open date', 'date created', 'date opened', 'raised date', 'date logged'] },
  { field: 'Risk Status',                    severity: 'major',    synonyms: ['risk status', 'status', 'current status', 'risk state'] },
  { field: 'Risk Category',                  severity: 'major',    synonyms: ['risk category', 'category', 'risk type', 'type of risk', 'risk classification'] },
  { field: 'Risk Description',               severity: 'critical', synonyms: ['risk description', 'description', 'risk statement', 'risk detail', 'risk narrative'] },
  { field: 'Risk Owner(s)',                  severity: 'major',    synonyms: ['risk owner', 'owner', 'responsible', 'risk owners', 'assigned to', 'accountable', 'risk lead'] },
  { field: 'Risk Trigger(s)',                severity: 'major',    synonyms: ['risk trigger', 'trigger', 'triggers', 'early warning', 'warning sign', 'indicator'] },
  { field: 'Probability',                    severity: 'major',    synonyms: ['probability', 'likelihood', 'chance', 'prob', 'probability of occurrence', 'likelihood rating'] },
  { field: 'Impact',                         severity: 'critical', synonyms: ['impact', 'consequence', 'impact level', 'impact rating', 'potential impact'] },
  { field: 'Priority',                       severity: 'critical', synonyms: ['priority', 'risk level', 'rating', 'risk rating', 'risk priority', 'risk score', 'overall rating'] },
  { field: 'Response',                       severity: 'critical', synonyms: ['response', 'mitigation plan', 'risk treatment', 'risk response', 'mitigation', 'treatment', 'response strategy'] },
  { field: 'Action Details',                 severity: 'major',    synonyms: ['action details', 'actions', 'mitigation actions', 'action items', 'action plan details', 'remediation'] },
  { field: 'Response / Actions Approved By', severity: 'minor',    synonyms: ['approved by', 'approver', 'approval', 'response approved', 'actions approved', 'sign off', 'authorized by'] },
]

function validateIROContent(text, fileName) {
  const normalized = text.toLowerCase().replace(/[^\w\s#/()\-]/g, ' ').replace(/\s+/g, ' ')
  const fields = IRO_FIELDS.map(({ field, severity, synonyms }) => {
    let status = 'missing'
    for (const syn of synonyms) {
      if (normalized.includes(syn)) {
        const idx = normalized.indexOf(syn)
        const after = normalized.slice(idx + syn.length, idx + syn.length + 120).trim()
        const words = (after.match(/\S+/g) || []).filter(w => ![':', '|', '-', ','].includes(w))
        status = words.length >= 2 ? 'present' : 'partial'
        break
      }
    }
    return { field, severity, status }
  })
  const points = fields.reduce((s, f) => s + (f.status === 'present' ? 1 : f.status === 'partial' ? 0.5 : 0), 0)
  const maxPoints = fields.length
  const percentage = Math.round((points / maxPoints) * 100)
  const ext = fileName.split('.').pop().toLowerCase()
  const isBinary = ['xlsx', 'xls', 'pdf', 'docx', 'doc', 'pptx', 'ppt'].includes(ext)
  return {
    fileName, fields, points, maxPoints, percentage, isBinary,
    presentCount: fields.filter(f => f.status === 'present').length,
    partialCount:  fields.filter(f => f.status === 'partial').length,
    missingCount:  fields.filter(f => f.status === 'missing').length,
  }
}

async function detectAndValidateIRO(dirHandle) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory' && matchesCode(entry.name, 'RSK')) {
      try {
        for await (const sub of entry.values()) {
          if (sub.kind === 'file' && sub.name.toLowerCase().includes('iro')) {
            try {
              const file = await sub.getFile()
              const raw  = await file.text()
              const clean = raw.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{3,}/g, '  ')
              return validateIROContent(clean, sub.name)
            } catch (_) {
              return { fileName: sub.name, error: 'Could not read file content.' }
            }
          }
        }
      } catch (_) {}
    }
  }
  return null
}

// Risk Register / Issue Log filename keywords, used to locate the source
// document for SLA validation (broader than the IRO label check above, since
// SLA validation reads actual data rows rather than best-effort text).
const RISK_DOC_KEYWORDS = ['iro', 'risk register', 'risk_register', 'risk-register', 'issue log', 'issue_log', 'issue-log', 'risk log']

function isRiskDocName(name) {
  const lower = (name || '').toLowerCase()
  return RISK_DOC_KEYWORDS.some(k => lower.includes(k))
}

async function findRiskFile(dirHandle) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory' && matchesCode(entry.name, 'RSK')) {
      try {
        for await (const sub of entry.values()) {
          if (sub.kind === 'file' && isRiskDocName(sub.name)) {
            return await sub.getFile()
          }
        }
      } catch (_) {}
    }
  }
  return null
}

async function detectAndValidateRiskSLA(dirHandle) {
  const file = await findRiskFile(dirHandle)
  if (!file) return null
  try {
    return await validateRiskSLA(file)
  } catch (e) {
    return { supported: false, fileName: file.name, reason: `Could not read file: ${e.message}` }
  }
}

// IRP (Incident Response Process) evidence lives *under* the RSK (Risk &
// Opportunity Management) Practice Area folder — the same convention this
// codebase already uses for the Risk Register / IRO document (see
// findRiskFile/detectAndValidateIRO above, both gated on matchesCode(...,
// 'RSK')). Folder-structure gate: Practice Area folders → RSK → IRP → evidence.
const IRP_FOLDER_KEYWORDS = ['irp', 'incident response', 'incident response process', 'incident management']

// Locates the IRP subfolder within RSK and collects every file inside it
// (one level of subfolders included, to cover "and its subfolders") as real
// File objects. Returns a status so the caller can distinguish "RSK Practice
// Area itself is missing" from "RSK is available but has no IRP subfolder" —
// reusing the exact same RSK-folder detection already used elsewhere in this
// file rather than re-scanning the whole repository a second time.
async function collectIRPFiles(dirHandle) {
  let rskEntry = null
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory' && matchesCode(entry.name, 'RSK')) { rskEntry = entry; break }
  }
  if (!rskEntry) return { status: 'rsk-missing', files: null }

  let irpEntry = null
  try {
    for await (const sub of rskEntry.values()) {
      if (sub.kind === 'directory' && (matchesCode(sub.name, 'IRP') || nameMatchesKeywords(sub.name, IRP_FOLDER_KEYWORDS))) {
        irpEntry = sub
        break
      }
    }
  } catch (_) {}
  if (!irpEntry) return { status: 'irp-missing', files: null }

  const out = []
  try {
    for await (const sub of irpEntry.values()) {
      if (sub.kind === 'file') {
        out.push(await sub.getFile())
      } else if (sub.kind === 'directory') {
        try {
          for await (const inner of sub.values()) {
            if (inner.kind === 'file') out.push(await inner.getFile())
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return { status: 'found', files: out }
}

async function detectAndValidateLessonLearned(dirHandle) {
  const result = await collectIRPFiles(dirHandle)
  if (result.status !== 'found') return null
  try {
    return await validateLessonLearned(result.files)
  } catch (e) {
    return { supported: false, findings: [], checklist: {}, summary: {}, reason: `Could not read IRP folder: ${e.message}` }
  }
}

// Flat multi-file uploads carry no folder structure, so Lesson Learned
// validation only runs when at least one uploaded file signals IRP/incident
// context — avoids showing a "missing evidence" gap on unrelated uploads.
const IRP_CONTEXT_KEYWORDS = ['irp', 'incident', 'iro', 'lesson learned', 'lessons learned', 'rca', 'root cause']
function looksLikeIRPContext(files) {
  return files.some(f => IRP_CONTEXT_KEYWORDS.some(k => f.name.toLowerCase().includes(k)))
}

// ─── Repository Scan ──────────────────────────────────────────────────────────

function Repository({ switchTab, addChatMessage, setScanResults, scanResults }) {
  const [uploaded, setUploaded] = useState(false)
  const [folderFiles, setFolderFiles] = useState([])
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState('')
  const [scanning, setScanning] = useState(false)
  const [iroValidation, setIroValidation] = useState(null)
  const [riskSlaValidation, setRiskSlaValidation] = useState(null)
  const [lessonLearnedValidation, setLessonLearnedValidation] = useState(null)
  const [irpAuditResult, setIrpAuditResult] = useState(null)
  const fileInputRef = useRef(null)

  // Clears the currently uploaded/scanned document(s) and every result derived
  // from them (shared scanResults included) so no stale document state can
  // reappear elsewhere in the app — the user starts from a clean slate.
  const cleanDocument = () => {
    setUploaded(false)
    setFolderFiles([])
    setFolderName('')
    setFolderError('')
    setIroValidation(null)
    setRiskSlaValidation(null)
    setLessonLearnedValidation(null)
    setIrpAuditResult(null)
    setScanResults(null)
  }

  const hasActiveDocument = folderFiles.length > 0 || !!scanResults || !!iroValidation || !!riskSlaValidation || !!lessonLearnedValidation || !!irpAuditResult || !!folderName

  const openLocalFolder = async () => {
    setFolderError('')
    if (!window.showDirectoryPicker) {
      setFolderError('Your browser does not support folder picking. Please use Chrome or Edge.')
      return
    }
    try {
      const dirHandle = await window.showDirectoryPicker()
      setFolderName(dirHandle.name)
      setScanning(true)
      const files = []
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
          const ext = getFileExt(entry.name)
          if (CMMI_EXTENSIONS.includes(ext)) {
            const fileHandle = await entry.getFile()
            files.push({ name: entry.name, size: fileHandle.size, pa: classifyFile(entry.name) })
          }
        } else if (entry.kind === 'directory') {
          try {
            for await (const sub of entry.values()) {
              if (sub.kind === 'file') {
                const ext = getFileExt(sub.name)
                if (CMMI_EXTENSIONS.includes(ext)) {
                  const fileHandle = await sub.getFile()
                  files.push({ name: sub.name, size: fileHandle.size, pa: classifyFile(sub.name) })
                }
              }
            }
          } catch (_) {}
        }
      }
      setFolderFiles(files)
      const results = await scanRepository(dirHandle)
      setScanResults(results)
      const iro = await detectAndValidateIRO(dirHandle)
      setIroValidation(iro)
      const riskSla = await detectAndValidateRiskSLA(dirHandle)
      setRiskSlaValidation(riskSla)
      const lessonLearned = await detectAndValidateLessonLearned(dirHandle)
      setLessonLearnedValidation(lessonLearned)
      const irpFolderResult = await collectIRPFiles(dirHandle)
      try {
        setIrpAuditResult(await validateIRPAudit(irpFolderResult))
      } catch (e) {
        setIrpAuditResult({ folderFound: irpFolderResult.status === 'found', findings: [], summary: {}, incident: null, rca: null, lessonLearned: null, reason: `Could not read IRP folder: ${e.message}` })
      }
      setScanning(false)
    } catch (e) {
      setScanning(false)
      if (e.name !== 'AbortError') setFolderError('Could not read folder. Please try again.')
    }
  }

  const handleFileUpload = (e) => {
    const files = Array.from(e.target.files)
    if (files.length === 0) return
    const mapped = files.map(f => ({ name: f.name, size: f.size, pa: classifyFile(f.name) }))
    setFolderFiles(mapped)
    setFolderName('Uploaded files')
    const results = {}
    PRACTICE_AREAS.filter(pa => CORE_PAS.has(pa.code)).forEach(pa => { results[pa.code] = 'missing' })
    mapped.forEach(f => {
      if (f.pa !== 'General' && results[f.pa] !== undefined) results[f.pa] = 'available'
      const base = f.name.replace(/\.[^.]+$/, '')
      PRACTICE_AREAS.filter(pa => CORE_PAS.has(pa.code)).forEach(pa => {
        if (matchesCode(base, pa.code)) results[pa.code] = 'available'
      })
    })
    setScanResults(results)
    const iroRaw = files.find(f => f.name.toLowerCase().includes('iro'))
    if (iroRaw) {
      iroRaw.text()
        .then(text => {
          const clean = text.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{3,}/g, '  ')
          setIroValidation(validateIROContent(clean, iroRaw.name))
        })
        .catch(() => setIroValidation({ fileName: iroRaw.name, error: 'Could not read file content.' }))
    }
    const riskDoc = files.find(f => isRiskDocName(f.name))
    if (riskDoc) {
      validateRiskSLA(riskDoc)
        .then(setRiskSlaValidation)
        .catch(e => setRiskSlaValidation({ supported: false, fileName: riskDoc.name, reason: `Could not read file: ${e.message}` }))
    } else {
      setRiskSlaValidation(null)
    }
    if (looksLikeIRPContext(files)) {
      validateLessonLearned(files)
        .then(setLessonLearnedValidation)
        .catch(e => setLessonLearnedValidation({ supported: false, findings: [], checklist: {}, summary: {}, reason: `Could not read file: ${e.message}` }))
      validateIRPAudit({ status: 'found', files })
        .then(setIrpAuditResult)
        .catch(e => setIrpAuditResult({ folderFound: true, findings: [], summary: {}, incident: null, rca: null, lessonLearned: null, reason: `Could not read file: ${e.message}` }))
    } else {
      setLessonLearnedValidation(null)
      setIrpAuditResult(null)
    }
  }

  return (
    <div>
      <div style={{marginBottom:'1.25rem'}}>
        <h2 style={{fontSize:18,fontWeight:500}}>Repository scan</h2>
        <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Identify missing artifacts across CMMI practice areas</div>
      </div>
      <div className="row">
        <div className="col" style={{flex:1.2}}>
          <div className="card">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:hasActiveDocument?0:'1rem'}}>
              <div className="section-title" style={{margin:0}}>Upload artifacts</div>
              {hasActiveDocument && (
                <button className="btn" style={{fontSize:12}} onClick={cleanDocument} title="Remove the current document and its scan results">
                  <IconTrash size={14}/> Clean / Remove Document
                </button>
              )}
            </div>
            <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.txt,.pptx,.csv,.md" style={{display:'none'}} onChange={handleFileUpload}/>
            <div className="upload-zone" onClick={() => fileInputRef.current.click()}>
              <IconCloudUpload size={28}/>
              <div style={{marginTop:8,fontSize:14,fontWeight:500}}>Drop files or click to browse</div>
              <div style={{fontSize:12,marginTop:4}}>Supports PDF, DOCX, XLSX, TXT, PPTX</div>
            </div>

            {scanning && <div style={{marginTop:12,fontSize:12,color:'var(--color-text-secondary)'}}>Scanning folder...</div>}
            {folderError && <div style={{marginTop:12,fontSize:12,color:'var(--color-text-danger)'}}>{folderError}</div>}

            {folderFiles.length > 0 && (
              <div style={{marginTop:12}}>
                <div style={{fontSize:12,fontWeight:500,color:'var(--color-text-secondary)',marginBottom:6}}>
                  📁 {folderName} — {folderFiles.length} file{folderFiles.length!==1?'s':''} found
                </div>
                <div className="scroll-area" style={{maxHeight:200}}>
                  {folderFiles.map(f => (
                    <div key={f.name} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderBottom:'0.5px solid var(--color-border-tertiary)',fontSize:12}}>
                      <IconFile size={14} color="var(--color-text-secondary)"/>
                      <span style={{flex:1,color:'var(--color-text-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.name}</span>
                      <span className="badge badge-info" style={{fontSize:10,flexShrink:0}}>{f.pa}</span>
                      <span className="badge badge-success" style={{fontSize:10,flexShrink:0}}>✓ Indexed</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {folderFiles.length === 0 && !scanning && folderName && (
              <div style={{marginTop:12,fontSize:12,color:'var(--color-text-warning)'}}>No supported files found in "{folderName}".</div>
            )}

            <div className="divider"/>
            <div style={{fontSize:13,fontWeight:500,marginBottom:10}}>Or connect repository</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <button className="btn" style={{fontSize:12,justifyContent:'center'}}><IconBrandGithub size={14}/> GitHub</button>
              <button className="btn" style={{fontSize:12,justifyContent:'center'}}><IconCloud size={14}/> SharePoint</button>
              <button className="btn" style={{fontSize:12,justifyContent:'center'}}><IconBrandGoogle size={14}/> Google Drive</button>
              <button className="btn" style={{fontSize:12,justifyContent:'center'}} onClick={openLocalFolder}><IconFolder size={14}/> Local folder</button>
            </div>
          </div>
        </div>
        <div className="col" style={{flex:2}}>
          <div className="card">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
              <div className="section-title" style={{margin:0}}>Core Practice Area validation</div>
              <button className="btn btn-primary" style={{fontSize:12}} onClick={() => { switchTab('chatbot'); addChatMessage('Identify all missing artifacts in my repository for CMMI Level 5 compliance and provide detailed recommendations') }}>AI scan ↗</button>
            </div>
            {!scanResults ? (
              <div style={{textAlign:'center',padding:'3rem 1rem',color:'var(--color-text-tertiary)'}}>
                <IconFolderOpen size={36} color="var(--color-text-tertiary)" style={{marginBottom:12}}/>
                <div style={{fontSize:14,fontWeight:500,color:'var(--color-text-primary)',marginBottom:6}}>No repository scanned yet</div>
                <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>Upload a project folder or files above to validate Practice Area document coverage.</div>
              </div>
            ) : (
              <div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                  <div style={{padding:'10px 12px',background:'rgba(99,153,34,0.08)',borderRadius:'var(--border-radius-md)',fontSize:12,color:'#639922',fontWeight:500,textAlign:'center'}}>
                    {Object.values(scanResults).filter(v => v === 'available').length} Available
                    <br/><span style={{fontWeight:400,color:'var(--color-text-secondary)'}}>Practice areas found</span>
                  </div>
                  <div style={{padding:'10px 12px',background:'rgba(226,75,74,0.08)',borderRadius:'var(--border-radius-md)',fontSize:12,color:'#E24B4A',fontWeight:500,textAlign:'center'}}>
                    {Object.values(scanResults).filter(v => v === 'missing').length} Missing
                    <br/><span style={{fontWeight:400,color:'var(--color-text-secondary)'}}>Practice areas missing</span>
                  </div>
                </div>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead>
                    <tr>
                      {['Code','Practice Area','Status'].map(h => (
                        <th key={h} style={{textAlign:h==='Status'?'right':'left',padding:'8px 10px',fontWeight:500,color:'var(--color-text-secondary)',background:'var(--color-background-secondary)',borderBottom:'0.5px solid var(--color-border-tertiary)'}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {PRACTICE_AREAS.filter(pa => CORE_PAS.has(pa.code)).map(pa => (
                      <tr key={pa.code} style={{borderBottom:'0.5px solid var(--color-border-tertiary)',background:scanResults[pa.code]==='missing'?'rgba(226,75,74,0.03)':''}}>
                        <td style={{padding:'8px 10px',fontWeight:500,color:'var(--color-text-primary)'}}>{pa.code}</td>
                        <td style={{padding:'8px 10px',color:'var(--color-text-secondary)'}}>{pa.name}</td>
                        <td style={{padding:'8px 10px',textAlign:'right'}}>
                          <span className={`badge ${scanResults[pa.code]==='available'?'badge-success':'badge-danger'}`} style={{fontSize:10}}>
                            {scanResults[pa.code]==='available'?'Available':'Missing Document'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {iroValidation && (
        <div className="card" style={{marginTop:'1rem'}}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:'1rem'}}>
            <div>
              <div className="section-title" style={{margin:0}}>IRO Risk Assessment Validation</div>
              <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>
                File: {iroValidation.fileName}
                {iroValidation.isBinary && ' · Best-effort text extraction from binary format'}
              </div>
            </div>
            {!iroValidation.error && (
              <div style={{padding:'8px 16px',borderRadius:'var(--border-radius-md)',background:iroValidation.percentage>=80?'rgba(99,153,34,0.12)':iroValidation.percentage>=60?'rgba(186,117,23,0.12)':'rgba(226,75,74,0.12)',textAlign:'center',minWidth:70}}>
                <div style={{fontSize:22,fontWeight:600,color:iroValidation.percentage>=80?'#639922':iroValidation.percentage>=60?'#BA7517':'#E24B4A'}}>{iroValidation.percentage}%</div>
                <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>Completion</div>
              </div>
            )}
          </div>

          {iroValidation.error ? (
            <div style={{fontSize:13,color:'var(--color-text-danger)',padding:'12px',background:'rgba(226,75,74,0.06)',borderRadius:'var(--border-radius-md)'}}>{iroValidation.error}</div>
          ) : (
            <>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:'1rem'}}>
                {[
                  ['Present', iroValidation.presentCount, '#639922', 'rgba(99,153,34,0.08)'],
                  ['Partial',  iroValidation.partialCount,  '#BA7517', 'rgba(186,117,23,0.08)'],
                  ['Missing',  iroValidation.missingCount,  '#E24B4A', 'rgba(226,75,74,0.08)'],
                ].map(([label, count, color, bg]) => (
                  <div key={label} style={{padding:'10px',background:bg,borderRadius:'var(--border-radius-md)',textAlign:'center'}}>
                    <div style={{fontSize:18,fontWeight:600,color}}>{count}</div>
                    <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>{label}</div>
                  </div>
                ))}
              </div>

              <div style={{marginBottom:'1rem'}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4,color:'var(--color-text-secondary)'}}>
                  <span>Completion: {iroValidation.points.toFixed(1)} / {iroValidation.maxPoints} points</span>
                  <span style={{fontWeight:500}}>{iroValidation.percentage}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{width:`${iroValidation.percentage}%`,background:iroValidation.percentage>=80?'#639922':iroValidation.percentage>=60?'#BA7517':'#E24B4A'}}/>
                </div>
              </div>

              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead>
                  <tr>
                    {['Field Name','Severity','Status'].map(h => (
                      <th key={h} style={{textAlign:'left',padding:'8px 10px',fontWeight:500,color:'var(--color-text-secondary)',background:'var(--color-background-secondary)',borderBottom:'0.5px solid var(--color-border-tertiary)'}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {iroValidation.fields.map(f => (
                    <tr key={f.field} style={{borderBottom:'0.5px solid var(--color-border-tertiary)',background:f.status==='missing'?'rgba(226,75,74,0.03)':f.status==='partial'?'rgba(186,117,23,0.03)':''}}>
                      <td style={{padding:'8px 10px',color:'var(--color-text-primary)',fontWeight:f.severity==='critical'?500:400}}>{f.field}</td>
                      <td style={{padding:'8px 10px'}}>
                        <span className={`badge ${f.severity==='critical'?'badge-danger':f.severity==='major'?'badge-warning':'badge-info'}`} style={{fontSize:10,textTransform:'capitalize'}}>{f.severity}</span>
                      </td>
                      <td style={{padding:'8px 10px'}}>
                        <span className={`badge ${f.status==='present'?'badge-success':f.status==='partial'?'badge-warning':'badge-danger'}`} style={{fontSize:10}}>
                          {f.status==='present'?'Present':f.status==='partial'?'Partial':'Missing'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{marginTop:'0.75rem',padding:'10px 12px',background:'rgba(55,138,221,0.06)',borderRadius:'var(--border-radius-md)',borderLeft:'3px solid #378ADD',fontSize:12,color:'var(--color-text-secondary)'}}>
                <strong style={{color:'var(--color-text-primary)'}}>Overall Assessment: </strong>
                {iroValidation.percentage >= 80
                  ? `Document is substantially complete (${iroValidation.percentage}%). ${iroValidation.missingCount > 0 ? iroValidation.missingCount + ' field(s) still need attention.' : 'All fields present.'}`
                  : iroValidation.percentage >= 60
                  ? `Document is partially complete (${iroValidation.percentage}%). Focus on: ${iroValidation.fields.filter(f => f.severity==='critical' && f.status!=='present').map(f => f.field).join(', ') || 'critical fields'}.`
                  : `Document requires significant attention (${iroValidation.percentage}%). ${iroValidation.missingCount} field(s) missing — address all Critical severity fields first.`
                }
              </div>
            </>
          )}
        </div>
      )}

      {riskSlaValidation && (
        <div className="card" style={{marginTop:'1rem'}}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:'1rem'}}>
            <div>
              <div className="section-title" style={{margin:0}}>Risk SLA Validation</div>
              <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>File: {riskSlaValidation.fileName}</div>
            </div>
          </div>

          {!riskSlaValidation.supported ? (
            <div style={{fontSize:13,color:'var(--color-text-secondary)',padding:'12px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)'}}>
              {riskSlaValidation.reason}
            </div>
          ) : (
            <>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:'1rem'}}>
                {[
                  ['Total Closed', riskSlaValidation.totalClosed, '#378ADD', 'rgba(55,138,221,0.08)'],
                  ['SLA Compliant', riskSlaValidation.slaCompliant, '#639922', 'rgba(99,153,34,0.08)'],
                  ['SLA Breached', riskSlaValidation.slaBreached, '#E24B4A', 'rgba(226,75,74,0.08)'],
                  ['Missing Breach Reason', riskSlaValidation.missingReasonCount, '#BA7517', 'rgba(186,117,23,0.08)'],
                ].map(([label, count, color, bg]) => (
                  <div key={label} style={{padding:'10px',background:bg,borderRadius:'var(--border-radius-md)',textAlign:'center'}}>
                    <div style={{fontSize:18,fontWeight:600,color}}>{count}</div>
                    <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>{label}</div>
                  </div>
                ))}
              </div>

              <div style={{marginBottom: riskSlaValidation.findings.length ? '1rem' : 0,padding:'10px 12px',background:riskSlaValidation.slaBreached>0?'rgba(186,117,23,0.06)':'rgba(99,153,34,0.06)',borderRadius:'var(--border-radius-md)',borderLeft:`3px solid ${riskSlaValidation.slaBreached>0?'#BA7517':'#639922'}`,fontSize:12,color:'var(--color-text-secondary)'}}>
                <strong style={{color:'var(--color-text-primary)'}}>Observation: </strong>
                {riskSlaValidation.observation || `Risk Register available. All ${riskSlaValidation.totalClosed} closed issue(s) are within their SLA window.`}
                {!riskSlaValidation.hasReasonColumn && riskSlaValidation.slaBreached > 0 && ' No SLA Breach Reason / Remarks column was found, so breach justification could not be verified for any record.'}
              </div>

              {riskSlaValidation.findings.length > 0 && (
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead>
                      <tr>
                        {['Issue ID','Priority','Raised Date','Closed Date','SLA Allowed','Actual Duration','Status','Result','Reason Available'].map(h => (
                          <th key={h} style={{textAlign:'left',padding:'8px 10px',fontWeight:500,color:'var(--color-text-secondary)',background:'var(--color-background-secondary)',borderBottom:'0.5px solid var(--color-border-tertiary)',whiteSpace:'nowrap'}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {riskSlaValidation.findings.map((f, i) => (
                        <tr key={f.issueId + i} style={{borderBottom:'0.5px solid var(--color-border-tertiary)',background:f.reasonAvailable==='No'?'rgba(226,75,74,0.03)':''}}>
                          <td style={{padding:'8px 10px',color:'var(--color-text-primary)',fontWeight:500,whiteSpace:'nowrap'}}>{f.issueId}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.priority}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.raisedDate}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.closedDate}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.slaAllowed}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.actualDuration}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.status}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>
                            <span className="badge badge-danger" style={{fontSize:10}}>{f.result}</span>
                          </td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>
                            <span className={`badge ${f.reasonAvailable==='Yes'?'badge-success':'badge-danger'}`} style={{fontSize:10}}>{f.reasonAvailable}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {lessonLearnedValidation && (
        <div className="card" style={{marginTop:'1rem'}}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:'1rem'}}>
            <div>
              <div className="section-title" style={{margin:0}}>IRO / IRP Lesson Learned Validation</div>
              {lessonLearnedValidation.fileName && (
                <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>
                  File: {lessonLearnedValidation.fileName}{lessonLearnedValidation.sheetName ? ` — Sheet: ${lessonLearnedValidation.sheetName}` : ''}
                  {lessonLearnedValidation.incidentLogAvailable && ` · Traced against Incident Log: ${lessonLearnedValidation.incidentLogFileName}`}
                </div>
              )}
            </div>
          </div>

          {!lessonLearnedValidation.supported && lessonLearnedValidation.reason ? (
            <div style={{fontSize:13,color:'var(--color-text-secondary)',padding:'12px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)'}}>
              {lessonLearnedValidation.reason}
            </div>
          ) : (
            <>
              {lessonLearnedValidation.supported && (
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:'1rem'}}>
                  {[
                    ['Records Validated', lessonLearnedValidation.summary.totalRecords, '#378ADD', 'rgba(55,138,221,0.08)'],
                    ['Critical', lessonLearnedValidation.summary.critical, '#E24B4A', 'rgba(226,75,74,0.08)'],
                    ['Major', lessonLearnedValidation.summary.major, '#BA7517', 'rgba(186,117,23,0.08)'],
                    ['Minor', lessonLearnedValidation.summary.minor, '#639922', 'rgba(99,153,34,0.08)'],
                  ].map(([label, count, color, bg]) => (
                    <div key={label} style={{padding:'10px',background:bg,borderRadius:'var(--border-radius-md)',textAlign:'center'}}>
                      <div style={{fontSize:18,fontWeight:600,color}}>{count}</div>
                      <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {lessonLearnedValidation.findings.length > 0 ? (
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead>
                      <tr>
                        {['Finding ID','PA','Evidence','Sheet','Field','Finding','Severity','Recommendation','Status'].map(h => (
                          <th key={h} style={{textAlign:'left',padding:'8px 10px',fontWeight:500,color:'var(--color-text-secondary)',background:'var(--color-background-secondary)',borderBottom:'0.5px solid var(--color-border-tertiary)',whiteSpace:'nowrap'}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lessonLearnedValidation.findings.map(f => (
                        <tr key={f.id} style={{borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                          <td style={{padding:'8px 10px',color:'var(--color-text-primary)',fontWeight:500,whiteSpace:'nowrap'}}>{f.id}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.pa}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.evidence}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.sheet}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.field}</td>
                          <td style={{padding:'8px 10px',minWidth:260}}>{f.finding}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>
                            <span className={`badge ${f.severity==='Critical'?'badge-danger':f.severity==='Major'?'badge-warning':'badge-info'}`} style={{fontSize:10}}>{f.severity}</span>
                          </td>
                          <td style={{padding:'8px 10px',minWidth:220}}>{f.recommendation}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>
                            <span className="badge badge-danger" style={{fontSize:10}}>{f.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{padding:'10px 12px',background:'rgba(99,153,34,0.06)',borderRadius:'var(--border-radius-md)',borderLeft:'3px solid #639922',fontSize:12,color:'var(--color-text-secondary)'}}>
                  No Lesson Learned gaps identified — all {lessonLearnedValidation.summary.totalRecords} record(s) pass ID, traceability, and action-tracking validation.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {irpAuditResult && (
        <div className="card" style={{marginTop:'1rem'}}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:'1rem'}}>
            <div>
              <div className="section-title" style={{margin:0}}>IRP Audit — Incident Log, RCA &amp; Lesson Learned</div>
              <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>
                End-to-end validation: Incident → Priority/SLA → RCA → Lesson Learned → Action Item
              </div>
            </div>
          </div>

          {!irpAuditResult.folderFound ? (
            <div style={{fontSize:13,color:'var(--color-text-secondary)',padding:'12px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)'}}>
              {irpAuditResult.reason || irpAuditResult.findings?.[0]?.finding || 'IRP folder not found — document-level validation was not performed.'}
            </div>
          ) : (
            <>
              <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginBottom:8}}>
                {[
                  ['Incidents', irpAuditResult.summary.totalIncidents, '#378ADD'],
                  ['P1', irpAuditResult.summary.p1, '#E24B4A'],
                  ['P2', irpAuditResult.summary.p2, '#BA7517'],
                  ['P3', irpAuditResult.summary.p3, '#639922'],
                  ['P4', irpAuditResult.summary.p4, '#639922'],
                  ['SLA Breaches', irpAuditResult.summary.slaBreaches, '#E24B4A'],
                ].map(([label, count, color]) => (
                  <div key={label} style={{padding:'10px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)',textAlign:'center'}}>
                    <div style={{fontSize:18,fontWeight:600,color}}>{count ?? 0}</div>
                    <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginBottom:'1rem'}}>
                {[
                  ['RCA Required', irpAuditResult.summary.rcaRequired, '#378ADD'],
                  ['RCA Missing', irpAuditResult.summary.rcaMissing, '#E24B4A'],
                  ['RCA Traceability Gaps', irpAuditResult.summary.rcaTraceabilityGaps, '#BA7517'],
                  ['Lesson Learned Records', irpAuditResult.summary.lessonLearnedRecords, '#378ADD'],
                  ['Open Actions', irpAuditResult.summary.openActions, '#BA7517'],
                  ['Closed Actions', irpAuditResult.summary.closedActions, '#639922'],
                ].map(([label, count, color]) => (
                  <div key={label} style={{padding:'10px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)',textAlign:'center'}}>
                    <div style={{fontSize:18,fontWeight:600,color}}>{count ?? 0}</div>
                    <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginBottom:'1rem'}}>
                {[
                  ['Dup. Incident IDs', irpAuditResult.summary.duplicateIncidentIds, '#E24B4A'],
                  ['Dup. RCA IDs', irpAuditResult.summary.duplicateRcaIds, '#E24B4A'],
                  ['Dup. LL IDs', irpAuditResult.summary.duplicateLessonLearnedIds, '#E24B4A'],
                  ['Priority Matrix Violations', irpAuditResult.summary.priorityMatrixViolations, '#BA7517'],
                  ['Traceability Gaps', irpAuditResult.summary.traceabilityGaps, '#BA7517'],
                  ['Missing Mandatory Fields', irpAuditResult.summary.missingMandatoryFields, '#BA7517'],
                ].map(([label, count, color]) => (
                  <div key={label} style={{padding:'10px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)',textAlign:'center'}}>
                    <div style={{fontSize:18,fontWeight:600,color}}>{count ?? 0}</div>
                    <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:'1rem'}}>
                {[
                  ['Total Gaps', irpAuditResult.summary.totalGaps, '#378ADD', 'rgba(55,138,221,0.08)'],
                  ['Critical', irpAuditResult.summary.criticalGaps, '#E24B4A', 'rgba(226,75,74,0.08)'],
                  ['Major', irpAuditResult.summary.majorGaps, '#BA7517', 'rgba(186,117,23,0.08)'],
                  ['Minor', irpAuditResult.summary.minorGaps, '#639922', 'rgba(99,153,34,0.08)'],
                ].map(([label, count, color, bg]) => (
                  <div key={label} style={{padding:'10px',background:bg,borderRadius:'var(--border-radius-md)',textAlign:'center'}}>
                    <div style={{fontSize:18,fontWeight:600,color}}>{count ?? 0}</div>
                    <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>{label}</div>
                  </div>
                ))}
              </div>

              {irpAuditResult.findings.length > 0 ? (
                <div style={{overflowX:'auto',maxHeight:480,overflowY:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead>
                      <tr>
                        {['Finding ID','Evidence','Sheet','Row','Field','Finding','Actual','Expected','Severity','Recommendation','Status'].map(h => (
                          <th key={h} style={{textAlign:'left',padding:'8px 10px',fontWeight:500,color:'var(--color-text-secondary)',background:'var(--color-background-secondary)',borderBottom:'0.5px solid var(--color-border-tertiary)',whiteSpace:'nowrap',position:'sticky',top:0}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {irpAuditResult.findings.map(f => (
                        <tr key={f.id} style={{borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                          <td style={{padding:'8px 10px',color:'var(--color-text-primary)',fontWeight:500,whiteSpace:'nowrap'}}>{f.id}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.evidence}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.sheet}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.row ?? '—'}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.field}</td>
                          <td style={{padding:'8px 10px',minWidth:260}}>{f.finding}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.actual ?? '—'}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>{f.expected ?? '—'}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>
                            <span className={`badge ${f.severity==='Critical'?'badge-danger':f.severity==='Major'?'badge-warning':'badge-info'}`} style={{fontSize:10}}>{f.severity}</span>
                          </td>
                          <td style={{padding:'8px 10px',minWidth:200}}>{f.recommendation}</td>
                          <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>
                            <span className="badge badge-danger" style={{fontSize:10}}>{f.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{padding:'10px 12px',background:'rgba(99,153,34,0.06)',borderRadius:'var(--border-radius-md)',borderLeft:'3px solid #639922',fontSize:12,color:'var(--color-text-secondary)'}}>
                  No IRP gaps identified across the Incident Log, RCA, and Lesson Learned registers.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Shared Gap Report Panel ────────────────────────────────────────────────
// Renders ONE Practice Area's independent Gap Report. Fully generic — driven
// entirely by the `result` object produced by validatePracticeArea(), so it
// works identically for any configured Practice Area.

function GapReportPanel({ result: r, onDownloadPDF, onDownloadExcel }) {
  const [menuOpen, setMenuOpen] = useState(false)
  if (!r) return null

  const statusColor = r.overallStatus === 'Compliant' ? '#639922' : r.overallStatus === 'Partially Compliant' ? '#BA7517' : '#A32D2D'

  return (
    <div>
      {/* Header banner */}
      <div className="card" style={{ marginBottom: '1rem', background: 'rgba(55,138,221,0.05)', border: '0.5px solid rgba(55,138,221,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Practice Area</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', marginTop: 2 }}>{r.paCode} — {r.paName}</div>
          </div>
          <div style={{ flex: 1 }} />
          {r.parseWarning && <span className="badge badge-warning" style={{ fontSize: 10 }}>Best-effort extraction</span>}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Required document</div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', marginTop: 1 }}>{r.documentLabel}{r.fileName ? ` — ${r.fileName}` : ''}</div>
          </div>
          <div style={{ position: 'relative' }}>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setMenuOpen(o => !o)}>
              <IconDownload size={14} /> Download Gap Report
            </button>
            {menuOpen && (
              <div style={{ position: 'absolute', right: 0, top: '110%', background: '#fff', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)', boxShadow: '0 4px 16px rgba(0,0,0,0.14)', zIndex: 20, minWidth: 170, overflow: 'hidden' }}>
                <div style={{ padding: '9px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text-primary)' }}
                  onMouseDown={() => { setMenuOpen(false); onDownloadPDF(r) }}>📄 Download as PDF</div>
                <div style={{ padding: '9px 12px', fontSize: 12, cursor: 'pointer', borderTop: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-primary)' }}
                  onMouseDown={() => { setMenuOpen(false); onDownloadExcel() }}>📊 Download as Excel</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {!r.documentFound && (
        <div className="card" style={{ marginBottom: '1rem', background: 'rgba(226,75,74,0.06)', border: '0.5px solid rgba(226,75,74,0.3)' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#A32D2D' }}>Status: Missing Document</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6 }}>
            The required document "{r.documentLabel}" was not found in the {r.paCode} folder. Field-level header validation was skipped for this Practice Area.
          </div>
        </div>
      )}

      {/* Metric cards: Document Found · Missing Headers · Compliance % */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 12 }}>
        <div className="metric-card">
          <div className="metric-label">Document Found</div>
          <div className="metric-value" style={{ color: r.documentFound ? '#639922' : '#A32D2D' }}>{r.documentFound ? 'Yes' : 'No'}</div>
          <div className="metric-sub">{r.documentLabel}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Missing Headers</div>
          <div className="metric-value" style={{ color: r.missingCount > 0 ? '#A32D2D' : '#639922' }}>{r.missingCount}</div>
          <div className="metric-sub">of {r.totalRequired} required</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Compliance %</div>
          <div className="metric-value" style={{ color: statusColor }}>{r.compliancePct}%</div>
          <div className="metric-sub">({r.foundCount} / {r.totalRequired}) × 100</div>
        </div>
      </div>

      {/* Gap classification cards: Critical · Major · Minor */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: '1rem' }}>
        {[
          ['Critical', r.criticalCount, '#A32D2D', 'rgba(226,75,74,0.08)'],
          ['Major',    r.majorCount,    '#BA7517', 'rgba(186,117,23,0.08)'],
          ['Minor',    r.minorCount,    '#378ADD', 'rgba(55,138,221,0.08)'],
        ].map(([label, count, color, bg]) => (
          <div key={label} style={{ background: bg, borderRadius: 'var(--border-radius-md)', padding: '1rem', textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 600, color: count > 0 ? color : '#639922' }}>{count}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', marginTop: 4 }}>{label} Gaps</div>
          </div>
        ))}
      </div>

      {/* Overall status + progress bar (color coded) */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>Overall Status</div>
          <span className={`badge ${r.overallStatus === 'Compliant' ? 'badge-success' : r.overallStatus === 'Partially Compliant' ? 'badge-warning' : 'badge-danger'}`} style={{ fontSize: 12 }}>
            {r.overallStatus}
          </span>
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4, color: 'var(--color-text-secondary)' }}>
            <span>Compliance: {r.foundCount} / {r.totalRequired} headers found</span>
            <span style={{ fontWeight: 500 }}>{r.compliancePct}%</span>
          </div>
          <div className="progress-bar" style={{ height: 8 }}>
            <div className="progress-fill" style={{ width: `${r.compliancePct}%`, background: statusColor }} />
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', padding: '8px 12px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)' }}>
          {!r.documentFound
            ? `Upload the ${r.documentLabel} into the ${r.paCode} folder to enable header validation.`
            : r.overallStatus === 'Compliant'
            ? `All ${r.totalRequired} mandatory ${r.paCode} header fields are present. The ${r.documentLabel} meets CMMI ${r.paCode} compliance requirements.`
            : r.overallStatus === 'Partially Compliant'
            ? `The ${r.documentLabel} is partially compliant. ${r.missingCount} header(s) are missing — ${r.criticalCount > 0 ? 'address Critical headers first' : 'address the identified gaps'} to improve compliance.`
            : `The ${r.documentLabel} requires significant improvement. ${r.missingCount} of ${r.totalRequired} mandatory headers are missing. Immediate action is required to achieve CMMI ${r.paCode} compliance.`
          }
        </div>
        {r.parseWarning && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#7a4d0f', padding: '6px 10px', background: 'rgba(186,117,23,0.08)', borderRadius: 'var(--border-radius-md)' }}>{r.parseWarning}</div>
        )}
      </div>

      {r.documentFound ? (
        <>
          {/* Detailed Gap Table */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="section-title">Detailed Gap Table</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['Field Name', 'Expected', 'Found', 'Severity', 'Status'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.headers.map(h => (
                  <tr key={h.name} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: h.status === 'FAIL' ? 'rgba(226,75,74,0.03)' : '' }}>
                    <td style={{ padding: '8px 10px', fontWeight: h.severity === 'critical' && h.status === 'FAIL' ? 500 : 400, color: 'var(--color-text-primary)' }}>{h.name}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{h.expected}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 500, color: h.status === 'PASS' ? '#639922' : '#A32D2D' }}>{h.found}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span className={`badge ${h.severity === 'critical' ? 'badge-danger' : h.severity === 'major' ? 'badge-warning' : 'badge-info'}`} style={{ fontSize: 10, textTransform: 'capitalize' }}>{h.severity}</span>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <span className={`badge ${h.status === 'PASS' ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: 10 }}>{h.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Recommendations — missing headers only */}
          {r.recommendations.length > 0 ? (
            <div className="card">
              <div className="section-title">Recommendations</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: '1rem' }}>
                The following recommendations address each missing header with CMMI rationale, required evidence, and its relevance during an appraisal.
              </div>
              {r.recommendations.map((rec, i) => (
                <div key={rec.field} style={{ marginBottom: 10, padding: '12px 14px', borderLeft: `3px solid ${rec.severity === 'critical' ? '#E24B4A' : rec.severity === 'major' ? '#BA7517' : '#378ADD'}`, background: 'var(--color-background-secondary)', borderRadius: '0 var(--border-radius-md) var(--border-radius-md) 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)' }}>{i + 1}. {rec.field}</span>
                    <span className={`badge ${rec.severity === 'critical' ? 'badge-danger' : rec.severity === 'major' ? 'badge-warning' : 'badge-info'}`} style={{ fontSize: 10 }}>{rec.severity}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{rec.text}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card" style={{ background: 'rgba(99,153,34,0.05)', border: '0.5px solid rgba(99,153,34,0.3)', textAlign: 'center', padding: '2rem' }}>
              <div style={{ fontSize: 28, marginBottom: 8, color: '#639922' }}>✓</div>
              <div style={{ fontSize: 15, fontWeight: 500, color: '#3d6b14', marginBottom: 4 }}>Fully Compliant</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>All {r.totalRequired} mandatory {r.paCode} headers are present. No recommendations required.</div>
            </div>
          )}
        </>
      ) : (
        <div className="card">
          <div className="section-title">Recommendations</div>
          <div style={{ padding: '12px 14px', borderLeft: '3px solid #E24B4A', background: 'var(--color-background-secondary)', borderRadius: '0 var(--border-radius-md) var(--border-radius-md) 0', fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
            Upload the required document ("{r.documentLabel}") inside the {r.paCode} Practice Area folder, then re-run validation. Until the document is present, none of the {r.totalRequired} mandatory header fields ({r.criticalTotal} Critical · {r.majorTotal} Major · {r.minorTotal} Minor) can be confirmed, and this Practice Area cannot be marked audit-ready during a CMMI appraisal.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Audit Findings (PA Validation page only) ─────────────────────────────────
// Fully generic — driven by `result` (validatePracticeArea output) and
// `ncRecords` (ncEngine.updateNCStore output). No Practice-Area-specific
// logic; works identically for any future checklist entry.
// Intentionally rendered ONLY inside PAValidation — never on the Dashboard,
// and never inside the shared GapReportPanel (so Gap analysis tab is unaffected).

function ncSeverityBadgeClass(sev) {
  return sev === 'critical' ? 'badge-danger' : sev === 'major' ? 'badge-warning' : 'badge-info'
}

function AuditFindingsTable({ columns, rows, emptyText }) {
  if (rows.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', padding: '10px 0' }}>{emptyText}</div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, minWidth: 720 }}>
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  )
}

function AuditFindingsSection({ result, ncRecords, auditMeta, allPaReports, allNcStore, commentsStore, setCommentsStore }) {
  const [remarks, setRemarks] = useState('')
  if (!result) return null

  const openNC = ncRecords.filter(r => r.status === 'Open')
  const closedNC = ncRecords.filter(r => r.status === 'Closed')
  const totalNC = ncRecords.length
  const criticalNC = ncRecords.filter(r => r.severity === 'critical').length
  const majorNC = ncRecords.filter(r => r.severity === 'major').length
  const minorNC = ncRecords.filter(r => r.severity === 'minor').length

  const findingText = (r) => `Missing mandatory field "${r.fieldName}" in ${r.documentLabel}${r.status === 'Closed' ? ' (subsequently resolved)' : ''}.`
  const remarksText = (r) => r.status === 'Closed'
    ? 'Resolved via document re-upload.'
    : r.reopenedAt ? 'Reopened — field missing again after prior closure.' : 'Pending remediation — see Recommendations below.'
  const reasonText = (r) => `Field not present in the header row of ${r.documentLabel} (mandatory per CMMI ${r.paCode} checklist).`
  const resolutionText = (r) => `"${r.fieldName}" header confirmed present in the re-uploaded ${r.documentLabel}.`
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString() : '—'

  const observationLines = !result.documentFound
    ? [
        `The uploaded ${result.paCode} ${result.documentLabel} document could not be found.`,
        `All ${result.totalRequired} mandatory checklist fields are unavailable pending upload of the document.`,
        `Total NC: ${totalNC}`,
        `Open NC: ${openNC.length}`,
        `Closed NC: ${closedNC.length}`,
        `Overall Compliance: ${result.compliancePct}%`,
        `This document is currently ${result.overallStatus} with the ${result.paCode} checklist.`,
      ]
    : [
        `The uploaded ${result.paCode} ${result.documentLabel} contains ${result.totalRequired} mandatory checklist fields.`,
        `Only ${result.foundCount} field${result.foundCount === 1 ? ' is' : 's are'} available.`,
        `${result.missingCount} mandatory field${result.missingCount === 1 ? ' is' : 's are'} missing.`,
        `Total NC: ${totalNC}`,
        `Open NC: ${openNC.length}`,
        `Closed NC: ${closedNC.length}`,
        `Overall Compliance: ${result.compliancePct}%`,
        `This document is currently ${result.overallStatus} with the ${result.paCode} checklist.`,
      ]

  return (
    <div style={{ marginTop: '1rem' }}>
      <AuditMetaBanner auditMeta={auditMeta} />
      <div className="section-title">Audit Findings Summary</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: '1rem' }}>
        {[
          ['Total Findings', totalNC, undefined, 'var(--color-text-primary)'],
          ['Total Non-Conformities', totalNC, undefined, 'var(--color-text-primary)'],
          ['Open NC', openNC.length, undefined, openNC.length > 0 ? '#A32D2D' : '#639922'],
          ['Closed NC', closedNC.length, undefined, '#639922'],
          ['Critical NC', criticalNC, undefined, criticalNC > 0 ? '#A32D2D' : '#639922'],
          ['Major NC', majorNC, undefined, majorNC > 0 ? '#7a4d0f' : '#639922'],
          ['Minor NC', minorNC, undefined, minorNC > 0 ? '#185FA5' : '#639922'],
          ['Compliance %', `${result.compliancePct}%`, undefined, result.overallStatus === 'Compliant' ? '#639922' : result.overallStatus === 'Partially Compliant' ? '#BA7517' : '#A32D2D'],
        ].map(([label, val, _u, color]) => (
          <div key={label} className="metric-card">
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ color }}>{val}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Non-Conformity Details</div>
        <AuditFindingsTable
          columns={['NC ID', 'Practice Area', 'Document Name', 'Field Name', 'Severity', 'Finding', 'Status', 'Owner', 'Target Closure Date', 'Actual Closure Date', 'Remarks', 'Auditor Comments']}
          emptyText="No Non-Conformities raised for this Practice Area."
          rows={ncRecords.map(r => (
            <tr key={r.ncId} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: r.status === 'Open' ? 'rgba(226,75,74,0.03)' : '' }}>
              <td style={{ padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-primary)' }}>{r.ncId}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{r.paCode}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{r.fileName || r.documentLabel}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-primary)' }}>{r.fieldName}</td>
              <td style={{ padding: '8px 10px' }}><span className={`badge ${ncSeverityBadgeClass(r.severity)}`} style={{ fontSize: 10, textTransform: 'capitalize' }}>{r.severity}</span></td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)', minWidth: 220 }}>{findingText(r)}</td>
              <td style={{ padding: '8px 10px' }}><span className={`badge ${r.status === 'Open' ? 'badge-danger' : 'badge-success'}`} style={{ fontSize: 10 }}>{r.status}</span></td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{r.owner}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{fmtDate(r.targetDate)}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{fmtDate(r.closedAt)}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)', minWidth: 200 }}>{remarksText(r)}</td>
              <td style={{ padding: '8px 10px', minWidth: 200 }}>
                <input
                  type="text"
                  value={(commentsStore && commentsStore[r.ncId]) || ''}
                  onChange={e => setCommentsStore && setCommentsStore(prev => ({ ...prev, [r.ncId]: e.target.value }))}
                  placeholder="Add auditor comment…"
                  style={{ fontSize: 11.5, padding: '5px 8px' }}
                />
              </td>
            </tr>
          ))}
        />
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Open Non-Conformities</div>
        <AuditFindingsTable
          columns={['NC ID', 'Practice Area', 'Missing Field', 'Severity', 'Reason', 'Owner', 'Target Date', 'Days Pending', 'Status']}
          emptyText="No open Non-Conformities — all findings for this Practice Area are closed."
          rows={openNC.map(r => (
            <tr key={r.ncId} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'rgba(226,75,74,0.03)' }}>
              <td style={{ padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-primary)' }}>{r.ncId}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{r.paCode}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-primary)' }}>{r.fieldName}</td>
              <td style={{ padding: '8px 10px' }}><span className={`badge ${ncSeverityBadgeClass(r.severity)}`} style={{ fontSize: 10, textTransform: 'capitalize' }}>{r.severity}</span></td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)', minWidth: 220 }}>{reasonText(r)}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{r.owner}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{fmtDate(r.targetDate)}</td>
              <td style={{ padding: '8px 10px', fontWeight: 500, color: '#A32D2D' }}>{daysBetween(r.firstDetectedAt)}</td>
              <td style={{ padding: '8px 10px' }}><span className="badge badge-danger" style={{ fontSize: 10 }}>Open</span></td>
            </tr>
          ))}
        />
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Closed Non-Conformities</div>
        <AuditFindingsTable
          columns={['NC ID', 'Practice Area', 'Resolved Field', 'Severity', 'Resolution', 'Closed By', 'Closed Date', 'Evidence']}
          emptyText="No closed Non-Conformities yet. Re-upload a corrected document for this Practice Area to close open findings."
          rows={closedNC.map(r => (
            <tr key={r.ncId} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
              <td style={{ padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-primary)' }}>{r.ncId}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{r.paCode}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-primary)' }}>{r.fieldName}</td>
              <td style={{ padding: '8px 10px' }}><span className={`badge ${ncSeverityBadgeClass(r.severity)}`} style={{ fontSize: 10, textTransform: 'capitalize' }}>{r.severity}</span></td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)', minWidth: 220 }}>{resolutionText(r)}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{r.closedBy}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{fmtDate(r.closedAt)}</td>
              <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)', minWidth: 220 }}>{r.evidence}</td>
            </tr>
          ))}
        />
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Audit Observation</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.9, padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)' }}>
          {observationLines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Recommendations</div>
        {result.recommendations.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>All required headers are present. No recommendations are necessary.</div>
        ) : (
          result.recommendations.map((rec, i) => {
            const detail = getRecommendationDetail(result.paCode, rec.field) || {}
            return (
              <div key={rec.field} style={{ marginBottom: 10, padding: '12px 14px', borderLeft: `3px solid ${rec.severity === 'critical' ? '#E24B4A' : rec.severity === 'major' ? '#BA7517' : '#378ADD'}`, background: 'var(--color-background-secondary)', borderRadius: '0 var(--border-radius-md) var(--border-radius-md) 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)' }}>{i + 1}. Missing Field: {rec.field}</span>
                  <span className={`badge ${ncSeverityBadgeClass(rec.severity)}`} style={{ fontSize: 10, textTransform: 'capitalize' }}>{rec.severity}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
                  <div><strong style={{ color: 'var(--color-text-primary)' }}>Why (CMMI): </strong>{detail.why}</div>
                  <div><strong style={{ color: 'var(--color-text-primary)' }}>Corrective Action: </strong>{detail.correctiveAction}</div>
                  <div><strong style={{ color: 'var(--color-text-primary)' }}>Expected Evidence: </strong>{detail.expectedEvidence}</div>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="card">
        <div className="section-title">Export Report</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>Auditor remarks (optional — included in the exported PDF)</div>
        <textarea
          value={remarks}
          onChange={e => setRemarks(e.target.value)}
          placeholder="e.g. Findings discussed with process owner; remediation plan agreed for next sprint."
          style={{ width: '100%', minHeight: 64, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-secondary)', borderRadius: 'var(--border-radius-md)', padding: '8px 12px', outline: 'none', resize: 'vertical', marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => downloadAuditFindingsReportPDF(result, ncRecords, { ...auditMeta, auditorRemarks: remarks })}>
            <IconFileExport size={14} /> Export Report
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Audit Information ─────────────────────────────────────────────────────────
// Collected once per Audit Run, before folder upload / audit processing begins.
// Persisted as `auditMeta` state in App and threaded through PA Validation, Gap
// Analysis, and every AFR / Gap Report export so the values never need re-entry.

function formatDateDMY(isoDate) {
  if (!isoDate) return ''
  const [y, m, d] = isoDate.split('-')
  if (!y || !m || !d) return isoDate
  return `${d}/${m}/${y}`
}

// Reusable field row for a list of names (Auditors, Auditees) — the user can
// add/remove rows freely; at least one non-empty entry is required.
function NameListField({ label, values, onChange, errKey, errors, placeholder }) {
  const setAt = (i, v) => { const next = [...values]; next[i] = v; onChange(next) }
  const addRow = () => onChange([...values, ''])
  const removeRow = (i) => onChange(values.length > 1 ? values.filter((_, idx) => idx !== i) : values)
  const addLabel = label.replace(/ Name$/, '').replace(/s$/, '')

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        {label} <span style={{ color: '#A32D2D' }}>*</span>
      </label>
      {values.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            type="text"
            value={v}
            placeholder={placeholder}
            onChange={e => setAt(i, e.target.value)}
            style={errors[errKey] ? { borderColor: '#E24B4A' } : undefined}
          />
          {values.length > 1 && (
            <button type="button" className="btn" style={{ padding: '0 10px', flexShrink: 0 }} onClick={() => removeRow(i)} title={`Remove this ${addLabel.toLowerCase()}`}>×</button>
          )}
        </div>
      ))}
      <button type="button" className="btn" style={{ fontSize: 12 }} onClick={addRow}>+ Add {addLabel}</button>
      {errors[errKey] && <div style={{ fontSize: 11, color: '#A32D2D', marginTop: 4 }}>{errors[errKey]}</div>}
    </div>
  )
}

// Single-value text/date field for the Audit Info form. Defined at module
// level (not inside AuditInfoForm) — an inline component redefined on every
// render is treated by React as a new component type each keystroke, which
// unmounts/remounts the <input> and drops focus after a single character.
function InfoField({ label, value, onChange, errKey, errors, type = 'text', placeholder }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        {label} <span style={{ color: '#A32D2D' }}>*</span>
      </label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={errors[errKey] ? { borderColor: '#E24B4A' } : undefined}
      />
      {errors[errKey] && <div style={{ fontSize: 11, color: '#A32D2D', marginTop: 4 }}>{errors[errKey]}</div>}
    </div>
  )
}

function AuditInfoForm({ onContinue, initial }) {
  const [auditName, setAuditName] = useState(initial?.auditName || '')
  const [auditorsList, setAuditorsList] = useState(initial?.auditorsList?.length ? initial.auditorsList : [''])
  const [auditeesList, setAuditeesList] = useState(initial?.auditeesList?.length ? initial.auditeesList : [''])
  const [auditDateISO, setAuditDateISO] = useState(initial?.auditDateISO || '')
  const [projectName, setProjectName] = useState(initial?.projectName || '')
  const [errors, setErrors] = useState({})

  const handleContinue = () => {
    const auditors = auditorsList.map(s => s.trim()).filter(Boolean)
    const auditees = auditeesList.map(s => s.trim()).filter(Boolean)
    const nextErrors = {}
    if (!auditName.trim()) nextErrors.auditName = 'Audit Name is required.'
    if (auditors.length === 0) nextErrors.auditorsName = 'Auditors Name is required.'
    if (auditees.length === 0) nextErrors.auditeesName = 'Auditees Name is required.'
    if (!auditDateISO) nextErrors.auditDate = 'Audit Date is required.'
    if (!projectName.trim()) nextErrors.projectName = 'Project Name is required.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    onContinue({
      auditName: auditName.trim(),
      auditorsName: auditors.join(', '),
      auditorsList: auditors,
      auditeesName: auditees.join(', '),
      auditeesList: auditees,
      auditDateISO,
      auditDate: formatDateDMY(auditDateISO),
      projectName: projectName.trim(),
    })
  }

  return (
    <div>
      <div style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ fontSize: 18, fontWeight: 500, color: 'var(--color-text-primary)' }}>Audit information</h2>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2 }}>
          Enter the audit details before uploading the project folder and running the audit
        </div>
      </div>
      <div className="card" style={{ maxWidth: 460 }}>
        {Object.keys(errors).length > 0 && (
          <div style={{ padding: '10px 12px', background: 'rgba(226,75,74,0.08)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #E24B4A', fontSize: 12, color: '#A32D2D', marginBottom: 16 }}>
            Please enter all required audit information before continuing.
          </div>
        )}
        <InfoField label="Audit Name" value={auditName} onChange={setAuditName} errKey="auditName" errors={errors} placeholder="e.g. CMMI V3.0 Internal Audit" />
        <NameListField label="Auditors Name" values={auditorsList} onChange={setAuditorsList} errKey="auditorsName" errors={errors} placeholder="e.g. Rajesh Kholiya" />
        <NameListField label="Auditees Name" values={auditeesList} onChange={setAuditeesList} errKey="auditeesName" errors={errors} placeholder="e.g. Priya Sharma" />
        <InfoField label="Audit Date" value={auditDateISO} onChange={setAuditDateISO} errKey="auditDate" errors={errors} type="date" />
        <InfoField label="Project Name" value={projectName} onChange={setProjectName} errKey="projectName" errors={errors} placeholder="e.g. ABC Banking Project" />
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 4 }} onClick={handleContinue}>
          Continue <IconArrowRight size={14} />
        </button>
      </div>
    </div>
  )
}

// Shared audit metadata banner shown atop generated findings/AFR reports.
function AuditMetaBanner({ auditMeta, title = 'CMMI V3.0 Audit Findings Report' }) {
  if (!auditMeta) return null
  return (
    <div className="card" style={{ marginBottom: '1rem', background: 'var(--color-background-secondary)' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, fontSize: 12 }}>
        <div><span style={{ color: 'var(--color-text-secondary)' }}>Audit Name: </span><strong style={{ color: 'var(--color-text-primary)' }}>{auditMeta.auditName}</strong></div>
        <div><span style={{ color: 'var(--color-text-secondary)' }}>Auditors Name: </span><strong style={{ color: 'var(--color-text-primary)' }}>{auditMeta.auditorsName}</strong></div>
        <div><span style={{ color: 'var(--color-text-secondary)' }}>Auditees Name: </span><strong style={{ color: 'var(--color-text-primary)' }}>{auditMeta.auditeesName}</strong></div>
        <div><span style={{ color: 'var(--color-text-secondary)' }}>Audit Date: </span><strong style={{ color: 'var(--color-text-primary)' }}>{auditMeta.auditDate}</strong></div>
        <div><span style={{ color: 'var(--color-text-secondary)' }}>Project Name: </span><strong style={{ color: 'var(--color-text-primary)' }}>{auditMeta.projectName}</strong></div>
      </div>
    </div>
  )
}

// ─── PA Validation ────────────────────────────────────────────────────────────

// Status → color mapping shared by every badge in the Audit Package
// Validation section (spec §11: Available=Green, Missing=Red, Partially
// Available=Amber, Not Checked=Grey, Read Error=Orange).
function pkgStatusStyle(status) {
  const s = (status || '').toUpperCase()
  if (s === 'AVAILABLE' || s === 'FULLY AVAILABLE' || s === 'DOCUMENTS FOUND' || s === 'PRIMARY CANDIDATE' || s === 'FOUND') return { color: '#639922', bg: 'rgba(99,153,34,0.1)' }
  if (s === 'MISSING') return { color: '#E24B4A', bg: 'rgba(226,75,74,0.1)' }
  if (s === 'GAP' || s === 'PARTIALLY AVAILABLE' || s === 'PARTIAL') return { color: '#BA7517', bg: 'rgba(186,117,23,0.1)' }
  if (s === 'READ ERROR') return { color: '#D9711F', bg: 'rgba(217,113,31,0.1)' }
  if (s === 'HEADER VALIDATION NOT POSSIBLE' || s === 'NO DOCUMENT FOUND' || s === 'SECONDARY/OLD CANDIDATE') return { color: '#8A6D00', bg: 'rgba(186,117,23,0.08)' }
  return { color: '#6B7280', bg: 'rgba(107,114,128,0.1)' } // NOT CHECKED / default (grey)
}

function PkgStatusBadge({ status }) {
  const { color, bg } = pkgStatusStyle(status)
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 600, color, background: bg, whiteSpace: 'nowrap' }}>{status}</span>
}

// Renders the IRP-specific drill-down: folder status → Issue Log detection
// (all candidates, not just the primary) → header availability for the 24
// required fields. Availability-only, per spec — no row-level data checks.
function IRPPackageDrillDown({ irp }) {
  if (!irp || irp.folderStatus !== 'AVAILABLE') {
    return (
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
        <PkgStatusBadge status="MISSING" /> — the IRP Practice Area folder was not found in the uploaded audit package. IRP document-level validation was not performed.
      </div>
    )
  }

  const issueLog = irp.issueLog
  if (!issueLog || issueLog.documentStatus === 'NO DOCUMENT FOUND') {
    return (
      <div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 12 }}>
          <div>Folder Status: <PkgStatusBadge status="AVAILABLE" /></div>
          <div>Evidence Status: <PkgStatusBadge status="NO DOCUMENT FOUND" /></div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>The IRP folder exists but is empty — no documents were found inside it.</div>
      </div>
    )
  }

  if (issueLog.documentStatus === 'MISSING') {
    return (
      <div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 12 }}>
          <div>Folder Status: <PkgStatusBadge status="AVAILABLE" /></div>
          <div>IRP Issue Log Status: <PkgStatusBadge status="MISSING" /></div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          No Issue Log was recognized by file name, sheet name, or keyword inside the IRP folder (e.g. "Issue Log", "Issue Register", "Problem Log").
        </div>
      </div>
    )
  }

  const availableCount = issueLog.fieldResults.filter(f => f.status === 'AVAILABLE').length
  const totalFields = issueLog.fieldResults.length

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap', fontSize: 12 }}>
        <div>Folder Status: <PkgStatusBadge status="AVAILABLE" /></div>
        <div>IRP Issue Log Status: <PkgStatusBadge status={issueLog.documentStatus} /></div>
        <div>Header Validation: <PkgStatusBadge status={issueLog.headerStatus} /></div>
        {issueLog.headerValidationPossible && <div style={{ color: 'var(--color-text-secondary)' }}>Required Headers: {availableCount} / {totalFields}</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: '1rem' }}>
        {[
          ['Issue Log File Name', issueLog.fileName],
          ['File Type', issueLog.fileType],
          ['File Path', issueLog.filePath],
          ['Sheet Name', issueLog.sheetName || 'N/A'],
        ].map(([label, value]) => (
          <div key={label} style={{ padding: '8px 10px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)' }}>
            <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{label}</div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
          </div>
        ))}
      </div>

      {issueLog.candidates.length > 1 && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
            IRP Issue Logs Found: {issueLog.candidates.length} (all preserved for audit traceability — none discarded)
          </div>
          {issueLog.candidates.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderBottom: '0.5px solid var(--color-border-tertiary)', fontSize: 12 }}>
              <span style={{ color: 'var(--color-text-secondary)', minWidth: 16 }}>{i + 1}.</span>
              <span style={{ flex: 1, color: 'var(--color-text-primary)' }}>{c.fileName} <span style={{ color: 'var(--color-text-tertiary)' }}>({c.fileType} · {c.path})</span></span>
              <PkgStatusBadge status={c.readError ? 'READ ERROR' : c.role} />
            </div>
          ))}
        </div>
      )}

      {issueLog.headerStatus === 'PARTIALLY AVAILABLE' && issueLog.missingColumns.length > 0 && (
        <div style={{ marginBottom: '1rem', padding: '10px 12px', background: 'rgba(226,75,74,0.06)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #E24B4A' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#A32D2D', marginBottom: 4 }}>MISSING IRP Issue Log Columns ({issueLog.missingColumns.length})</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{issueLog.missingColumns.join(', ')}</div>
        </div>
      )}

      {!issueLog.headerValidationPossible && issueLog.headerStatus !== 'READ ERROR' && (
        <div style={{ marginBottom: '1rem', padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          This file format does not support automated header extraction in this stage. Headers are shown as "Not Checked" rather than falsely marked missing.
        </div>
      )}
      {issueLog.headerStatus === 'READ ERROR' && (
        <div style={{ marginBottom: '1rem', padding: '10px 12px', background: 'rgba(217,113,31,0.08)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #D9711F', fontSize: 12, color: '#8A4B12' }}>
          The primary Issue Log candidate could not be opened/read. This is reported as a Read Error, not a missing document.
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Required Field', 'Detected Header', 'Status', 'Remarks'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {issueLog.fieldResults.map(f => (
              <tr key={f.field} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                <td style={{ padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>{f.field}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{f.detectedHeader || '-'}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}><PkgStatusBadge status={f.status} /></td>
                <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)' }}>{f.remarks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const SOURCE_OPTIONS = [
  { id: 'local', label: 'Local Folder', Icon: IconFolder },
  { id: 'github', label: 'GitHub', Icon: IconBrandGithub },
  { id: 'sharepoint', label: 'SharePoint', Icon: IconCloud },
  { id: 'gdrive', label: 'Google Drive', Icon: IconBrandGoogle },
]

function PAValidation({ paReports, setPaReports, ncStore, setNcStore, auditMeta, onAuditMetaSubmit, commentsStore, setCommentsStore, pkgAvailability, setPkgAvailability, irpIssueLog, setIrpIssueLog, irpDataValidation, setIrpDataValidation, irpAuditResult, setIrpAuditResult, evidenceScanRows }) {
  const [folderName, setFolderName]     = useState('')
  const [processedCodes, setProcessedCodes] = useState([])
  const [focusedPA, setFocusedPA]       = useState(null)
  const [processing, setProcessing]     = useState(false)
  const [error, setError]               = useState('')
  const [scanWarning, setScanWarning]   = useState('')
  const [editingAuditInfo, setEditingAuditInfo] = useState(false)
  const fileInputRef = useRef(null)

  // ── Select Domain — multi-select, [] means "All Domains" ───────────────
  // Drives (a) which Practice Areas are validated in Stage 2 during this
  // upload, and (b) which rows the Stage-1 results table/summary display.
  const [selectedDomains, setSelectedDomains] = useState([])

  // ── Upload Practice Area Folder — single merged upload/scan pipeline ───
  // One scan (from any of the four sources below) drives BOTH the Stage-1
  // folder/document availability engine (runAuditPackageCheck) and the
  // Stage-2 real header-validation engine (bucketFilesByPA +
  // validatePracticeArea + updateNCStore). Neither engine's own code
  // changes — only this orchestration layer is new.
  const [scan, setScan] = useState(null)
  const [pkgResult, setPkgResult] = useState(null)
  const [pkgSelectedPA, setPkgSelectedPA] = useState(null)
  const [pkgDrillDown, setPkgDrillDown] = useState(null)

  const [activeSource, setActiveSource] = useState('local')

  const [ghOwnerRepo, setGhOwnerRepo] = useState('')
  const [ghBranch, setGhBranch] = useState('main')
  const [ghPath, setGhPath] = useState('')
  const [ghToken, setGhToken] = useState('')

  const [spAccount, setSpAccount] = useState(null)
  const [spAccessToken, setSpAccessToken] = useState(null)
  const [spSiteUrl, setSpSiteUrl] = useState('')
  const [spLibrary, setSpLibrary] = useState('Documents')
  const [spPath, setSpPath] = useState('')
  const [spBusy, setSpBusy] = useState(false)

  const [gdAccessToken, setGdAccessToken] = useState(null)
  const [gdPickedFolder, setGdPickedFolder] = useState(null)
  const [gdBusy, setGdBusy] = useState(false)

  // Runs BOTH engines off one normalized scan object, regardless of source.
  const runMergedPipeline = async (rawScan, sourceCtx) => {
    setError(''); setScanWarning(rawScan.scanWarning || '')
    setProcessing(true)
    try {
      const pkg = await runAuditPackageCheck(rawScan, { auditId: auditMeta?.auditName || null })
      setScan(rawScan)
      setPkgResult(pkg)
      setPkgSelectedPA('IRP')
      setPkgDrillDown(null)

      // Lift Stage-1 availability up to App level (unfiltered — the Dashboard
      // applies its own, independent domain filter on top of this) so the
      // Dashboard's real KPI cards/domain-wise table reflect this scan too.
      const availabilityUpdate = Object.fromEntries(pkg.practiceAreas.map(pa => [pa.code, pa.status]))
      availabilityUpdate.IRP = pkg.irp.folderStatus
      setPkgAvailability(prev => ({ ...(prev || {}), ...availabilityUpdate }))
      setIrpIssueLog(pkg.irp.issueLog)

      // Data-row validation (Report Date vs Closure Date ordering, duplicate
      // Incident ID) — the "later stage" irpIssueLogEngine.js's own comment
      // reserves for row-level rules. Runs on the same IRP-scoped raw files
      // as the availability check above, only when the IRP folder was found.
      const irpPA = pkg.practiceAreas.find(pa => pa.code === 'IRP')
      if (irpPA && irpPA.status === 'AVAILABLE' && irpPA.path) {
        const irpFiles = filesUnderFolderPath(rawScan, irpPA.path.replace(/^\//, ''))
        setIrpDataValidation(await validateIrpIncidentLogData(irpFiles))
        // Full Incident/RCA audit (Priority Matrix, SLA breach, RCA-required,
        // RCA traceability, Closed Date/Time, Issue Category — see
        // incidentEngine.js/rcaEngine.js/irpAudit.js) off the same IRP files,
        // so the Gap Report/AFR can surface incident-level gaps with their
        // Incident IDs from this same scan.
        //
        // incidentEngine.js/rcaEngine.js/irpEngine.js all call file.arrayBuffer()/
        // file.text() directly on each entry — unlike irpIssueLogEngine.js and
        // irpDataValidation.js above, which are written for the raw
        // folderScanUtils entry shape ({path, name, getFile}) and resolve it
        // themselves. Passing the raw (unresolved) irpFiles entries straight
        // into validateIRPAudit() throws "file.arrayBuffer is not a function"
        // inside readRows(), which the catch below was silently swallowing
        // into an empty-findings result — the exact reason real Issue
        // Category (and every other IRP incident/RCA) gap silently never
        // reached AFR for real uploaded folders despite passing unit tests
        // that construct already-resolved File objects directly. Resolve
        // each entry to its real File here first, matching what
        // collectIRPFiles() (the Repository-tab upload path) already does.
        try {
          const resolvedIrpFiles = await Promise.all(irpFiles.map(f => f.getFile()))
          setIrpAuditResult(await validateIRPAudit({ status: 'found', files: resolvedIrpFiles }))
        } catch (e) {
          setIrpAuditResult({ folderFound: true, findings: [], summary: {}, incident: null, rca: null, lessonLearned: null, reason: `Could not read IRP folder: ${e.message}` })
        }
      } else {
        setIrpDataValidation(null)
        setIrpAuditResult(null)
      }

      const resolved = await Promise.all(rawScan.files.map(async sf => ({ sf, file: await sf.getFile() })))
      const entries = resolved.map(({ sf, file }) => ({ file, subfolder: sf.path[0] || '' }))
      const sourceMap = new Map(resolved.map(({ sf, file }) => [file, {
        sourcePath: [...sf.path, sf.name].join('/'),
        uploadSource: sourceCtx.uploadSourceLabel,
        sourceMeta: sourceCtx.sourceMeta || null,
      }]))
      // Domain-scope Stage 2: only validate (and therefore only ever store
      // findings for) Practice Areas applicable to the selected domain(s) —
      // this is what guarantees unrelated domains' PAs never appear in
      // paReports/ncStore, and therefore never leak into the Dashboard, Gap
      // Analysis, or AFR downstream. Core Practice Areas are always in scope
      // (paCodesForSelection already includes them for every selection).
      const applicableCodes = paCodesForSelection(selectedDomains)
      const allBuckets = bucketFilesByPA(rawScan.rootName, entries)
      const buckets = allBuckets.filter(b => applicableCodes.has(b.paCode))
      if (buckets.length > 0) {
        const updates = {}
        const ncUpdates = {}
        for (const { paCode, files } of buckets) {
          const result = await validatePracticeArea(paCode, files)
          updates[paCode] = result
          const docFile = files.find(f => f.name === result.fileName)
          const srcInfo = (docFile && sourceMap.get(docFile)) || { sourcePath: null, uploadSource: sourceCtx.uploadSourceLabel, sourceMeta: sourceCtx.sourceMeta || null }
          ncUpdates[paCode] = updateNCStore(ncStore[paCode], paCode, result, srcInfo)
        }
        setPaReports(prev => ({ ...prev, ...updates }))
        setNcStore(prev => ({ ...prev, ...ncUpdates }))
        const codes = Object.keys(updates)
        setProcessedCodes(codes)
        setFocusedPA(codes[0])
      } else {
        setProcessedCodes([])
        setFocusedPA(null)
      }
      setFolderName(rawScan.rootName)
    } catch (e) {
      setError(e.message || 'Could not process the selected source. Please try again.')
    } finally {
      setProcessing(false)
    }
  }

  const openLocalSource = async () => {
    setError('')
    if (!window.showDirectoryPicker) {
      setError('Folder picker is not supported in this browser. Please use Chrome or Edge, or use the "Browse folder" option.')
      return
    }
    try {
      const dirHandle = await window.showDirectoryPicker()
      const rawScan = await scanDirectoryHandle(dirHandle)
      await runMergedPipeline(rawScan, { uploadSourceLabel: 'Local Folder', sourceMeta: null })
    } catch (e) {
      if (e.name !== 'AbortError') setError('Could not read folder. Please try again.')
    }
  }

  const handleLocalFileInput = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    const rawScan = scanFileList(files)
    await runMergedPipeline(rawScan, { uploadSourceLabel: 'Local Folder', sourceMeta: null })
    e.target.value = ''
  }

  const runGithubScan = async () => {
    setError('')
    const parsed = parseGithubRepoInput(ghOwnerRepo)
    if (!parsed) { setError('Enter a repository as "owner/repo" or a full GitHub URL.'); return }
    setProcessing(true)
    try {
      const rawScan = await scanGithubRepo({ ...parsed, branch: ghBranch, path: ghPath, token: ghToken })
      await runMergedPipeline(rawScan, { uploadSourceLabel: 'GitHub', sourceMeta: rawScan.sourceMeta })
    } catch (e) {
      setProcessing(false)
      setError(e.message || 'Could not scan the GitHub repository.')
    }
  }

  const connectSharePoint = async () => {
    setError(''); setSpBusy(true)
    try {
      const { account, accessToken } = await signInSharePoint()
      setSpAccount(account); setSpAccessToken(accessToken)
    } catch (e) {
      setError(e.message || 'Could not sign in to SharePoint.')
    } finally {
      setSpBusy(false)
    }
  }

  const runSharepointScan = async () => {
    setError('')
    if (!spAccessToken) { setError('Sign in to SharePoint first.'); return }
    setProcessing(true)
    try {
      const rawScan = await scanSharePointFolder({ siteUrl: spSiteUrl, driveName: spLibrary, folderPath: spPath, accessToken: spAccessToken })
      await runMergedPipeline(rawScan, { uploadSourceLabel: 'SharePoint', sourceMeta: rawScan.sourceMeta })
    } catch (e) {
      setProcessing(false)
      setError(e.message || 'Could not scan the SharePoint folder.')
    }
  }

  const connectGoogleDrive = async () => {
    setError(''); setGdBusy(true)
    try {
      const token = await requestGoogleAccessToken()
      setGdAccessToken(token)
      const folder = await openGoogleDrivePicker(token)
      if (folder) setGdPickedFolder(folder)
    } catch (e) {
      setError(e.message || 'Could not connect to Google Drive.')
    } finally {
      setGdBusy(false)
    }
  }

  const runGoogleDriveScan = async () => {
    setError('')
    if (!gdAccessToken || !gdPickedFolder) { setError('Connect Google Drive and choose a folder first.'); return }
    setProcessing(true)
    try {
      const rawScan = await scanGoogleDriveFolder({ folderId: gdPickedFolder.id, folderName: gdPickedFolder.name, accessToken: gdAccessToken })
      await runMergedPipeline(rawScan, { uploadSourceLabel: 'Google Drive', sourceMeta: rawScan.sourceMeta })
    } catch (e) {
      setProcessing(false)
      setError(e.message || 'Could not scan the Google Drive folder.')
    }
  }

  const resetUpload = () => {
    setFolderName(''); setProcessedCodes([]); setFocusedPA(null); setError(''); setScanWarning('')
    setScan(null); setPkgResult(null); setPkgSelectedPA(null); setPkgDrillDown(null)
  }

  const selectPackagePA = (code) => {
    setPkgSelectedPA(code)
    if (code === 'IRP' || !pkgResult) { setPkgDrillDown(null); return }
    const paResult = pkgResult.practiceAreas.find(p => p.code === code)
    if (paResult) setPkgDrillDown(drillDownPracticeArea(scan, paResult))
  }

  // Audit Run cannot start until the mandatory Audit Information is captured —
  // this gate blocks folder upload/processing until auditMeta is set.
  if (!auditMeta || editingAuditInfo) {
    return (
      <AuditInfoForm
        initial={auditMeta}
        onContinue={(meta) => { onAuditMetaSubmit(meta); setEditingAuditInfo(false) }}
      />
    )
  }

  // Cleans one Practice Area's uploaded document out of the shared paReports/
  // ncStore/commentsStore state (not just this component's local view) so
  // stale results never reappear elsewhere in the app (Dashboard, Gap
  // Analysis, AFR).
  const removePA = (code) => {
    if (!code) return
    setPaReports(prev => { const next = { ...prev }; delete next[code]; return next })
    setNcStore(prev => { const next = { ...prev }; delete next[code]; return next })
    setCommentsStore(prev => {
      const next = { ...prev }
      Object.keys(next).forEach(ncId => { if (ncId.startsWith(`${code}-NC-`)) delete next[ncId] })
      return next
    })
    const remaining = processedCodes.filter(c => c !== code)
    setProcessedCodes(remaining)
    if (code === focusedPA) setFocusedPA(remaining.length ? remaining[0] : null)
    if (remaining.length === 0) { setFolderName(''); setError('') }
  }

  const focusedResult = focusedPA ? paReports[focusedPA] : null

  // Domain-filtered Stage-1 rows + combined Available/Missing/Gap status —
  // recomputed on every render from pkgResult (this scan's raw availability)
  // + paReports (Stage-2 compliance), scoped to the current "Select Domain"
  // choice. IRP is always included (see paCodesForSelection's doc comment).
  const applicablePACodes = paCodesForSelection(selectedDomains)
  const domainRows = pkgResult
    ? pkgResult.practiceAreas
        .filter(pa => pa.code === 'IRP' || applicablePACodes.has(pa.code))
        .map(pa => ({ ...pa, combinedStatus: combinedPAStatus(pa.code, pkgAvailability, paReports) }))
    : []
  const domainAvailable = domainRows.filter(r => r.combinedStatus === 'Available')
  const domainMissing = domainRows.filter(r => r.combinedStatus === 'Missing')
  const domainGap = domainRows.filter(r => r.combinedStatus === 'Gap')
  const domainCoreCount = domainRows.filter(r => paTypeLabel(r.code) === 'Core').length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>Practice Area Validation</h2>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Upload a Practice Area folder — or a parent folder containing several Practice Area subfolders — to auto-detect and validate each one independently
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
            <strong style={{ color: 'var(--color-text-secondary)' }}>{auditMeta.auditName}</strong>
            {' · Auditors: '}{auditMeta.auditorsName}{' · Auditees: '}{auditMeta.auditeesName}{' · '}{auditMeta.auditDate}{' · '}{auditMeta.projectName}
            {' · '}<span style={{ color: '#185FA5', cursor: 'pointer', fontWeight: 500 }} onClick={() => setEditingAuditInfo(true)}>Edit</span>
          </div>
        </div>
        {focusedResult && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn" onClick={() => removePA(focusedPA)} title="Remove this document's results and clear its stale validation/finding data">
              <IconTrash size={14} /> Clean / Remove Document
            </button>
            <button className="btn" onClick={resetUpload}><IconFolderOpen size={14} /> New upload</button>
          </div>
        )}
      </div>

      {/* ── Upload Practice Area Folder (renamed from "Audit Package Validation") ──
          Single merged section: one upload/scan action drives both the folder/
          document availability check (Stage 1) and the real per-Practice-Area
          header validation (Stage 2) below. ─────────────────────────────────── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div>
            <div className="section-title" style={{ margin: 0 }}>Upload Practice Area Folder</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              Detects each Practice Area from its folder name, checks folder/document availability, then validates the FIRST ROW (header row) of each required document against that Practice Area's own CMMI checklist. Practice Areas are never mixed — each gets its own independent Gap Report.
            </div>
          </div>
          {scan && (
            <button className="btn" onClick={resetUpload} style={{ flexShrink: 0 }}>
              <IconTrash size={14} /> Clear / New Upload
            </button>
          )}
        </div>

        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Select Domain</label>
          <DomainMultiSelect selected={selectedDomains} onChange={setSelectedDomains} />
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
            {selectedDomains.length === 0
              ? 'All Domains selected — every registered Practice Area (Core + all domain-specific) will be validated.'
              : `Only Core Practice Areas plus ${domainsForSelection(selectedDomains).map(d => d.code).join(', ')}-specific Practice Areas will be validated and shown below.`}
          </div>
        </div>

        {!scan && !processing && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: '1.25rem', flexWrap: 'wrap' }}>
              {SOURCE_OPTIONS.map(s => (
                <div
                  key={s.id}
                  className="chip"
                  style={activeSource === s.id ? { borderColor: '#378ADD', color: '#185FA5', background: 'rgba(55,138,221,0.08)' } : undefined}
                  onClick={() => setActiveSource(s.id)}
                >
                  <s.Icon size={13} /> {s.label}
                </div>
              ))}
            </div>

            {activeSource === 'local' && (
              <>
                <input ref={fileInputRef} type="file" multiple webkitdirectory="" style={{ display: 'none' }} onChange={handleLocalFileInput} />
                <div className="upload-zone" onClick={() => fileInputRef.current.click()}>
                  <IconCloudUpload size={28} />
                  <div style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}>Drop the complete audit/project folder or click to browse</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>Recursively scans every nested folder and file — Excel, PDF, Word, CSV and more</div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: '1rem' }}>
                  <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => fileInputRef.current.click()}><IconFolder size={14} /> Browse folder</button>
                  <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={openLocalSource}><IconFolder size={14} /> Select local folder</button>
                </div>
              </>
            )}

            {activeSource === 'github' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Repository</label>
                    <input type="text" value={ghOwnerRepo} onChange={e => setGhOwnerRepo(e.target.value)} placeholder="owner/repo or https://github.com/owner/repo" />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Branch</label>
                    <input type="text" value={ghBranch} onChange={e => setGhBranch(e.target.value)} placeholder="main" />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Folder / Path (optional)</label>
                  <input type="text" value={ghPath} onChange={e => setGhPath(e.target.value)} placeholder="e.g. audit-package" />
                </div>
                <div style={{ marginTop: 10 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Personal Access Token (optional — private repos or rate limits; kept only for this session, never stored)</label>
                  <input type="password" value={ghToken} onChange={e => setGhToken(e.target.value)} placeholder="ghp_…" autoComplete="off" />
                </div>
                <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runGithubScan}><IconBrandGithub size={14} /> Scan Repository</button>
              </div>
            )}

            {activeSource === 'sharepoint' && (
              isSharePointConfigured() ? (
                <div>
                  {!spAccessToken ? (
                    <button className="btn btn-primary" onClick={connectSharePoint} disabled={spBusy}>
                      <IconCloud size={14} /> {spBusy ? 'Signing in…' : 'Sign in to SharePoint'}
                    </button>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>Signed in as {spAccount?.username || spAccount?.name || 'SharePoint user'}</div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Site URL</label>
                      <input type="text" value={spSiteUrl} onChange={e => setSpSiteUrl(e.target.value)} placeholder="https://yourtenant.sharepoint.com/sites/YourSite" />
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', margin: '10px 0 6px' }}>Document Library</label>
                      <input type="text" value={spLibrary} onChange={e => setSpLibrary(e.target.value)} placeholder="Documents" />
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', margin: '10px 0 6px' }}>Folder / Path</label>
                      <input type="text" value={spPath} onChange={e => setSpPath(e.target.value)} placeholder="e.g. AuditPackage" />
                      <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSharepointScan}><IconCloud size={14} /> Scan SharePoint Folder</button>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ padding: '10px 12px', background: 'rgba(55,138,221,0.06)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #378ADD', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  SharePoint is not configured. Set <code>VITE_SHAREPOINT_CLIENT_ID</code> and <code>VITE_SHAREPOINT_TENANT_ID</code> (see <code>.env.example</code>) to enable this source.
                </div>
              )
            )}

            {activeSource === 'gdrive' && (
              isGoogleDriveConfigured() ? (
                <div>
                  <button className="btn btn-primary" onClick={connectGoogleDrive} disabled={gdBusy}>
                    <IconBrandGoogle size={14} /> {gdBusy ? 'Connecting…' : gdPickedFolder ? 'Choose a different folder' : 'Connect Google Drive & choose folder'}
                  </button>
                  {gdPickedFolder && (
                    <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-secondary)' }}>Selected folder: <strong style={{ color: 'var(--color-text-primary)' }}>{gdPickedFolder.name}</strong></div>
                  )}
                  <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runGoogleDriveScan} disabled={!gdPickedFolder}><IconBrandGoogle size={14} /> Scan Google Drive Folder</button>
                </div>
              ) : (
                <div style={{ padding: '10px 12px', background: 'rgba(55,138,221,0.06)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #378ADD', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  Google Drive is not configured. Set <code>VITE_GOOGLE_CLIENT_ID</code> and <code>VITE_GOOGLE_API_KEY</code> (see <code>.env.example</code>) to enable this source.
                </div>
              )
            )}

            {error && (
              <div style={{ marginTop: '1rem', padding: '12px 14px', background: 'rgba(226,75,74,0.08)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #E24B4A', fontSize: 13, color: '#A32D2D' }}>
                {error}
              </div>
            )}

            <div className="divider" />
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, color: 'var(--color-text-secondary)' }}>Currently supported Practice Areas</div>
            {SUPPORTED_PA_CODES.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 8 }}>No Practice Area checklists are configured yet — folder/document availability (shown after upload) still works for every registered Practice Area; detailed header validation will begin producing findings once checklists are added.</div>
            )}
            {SUPPORTED_PA_CODES.map(code => {
              const cfg = PA_CHECKLISTS[code]
              const critical = cfg.headers.filter(h => h.severity === 'critical').length
              const major = cfg.headers.filter(h => h.severity === 'major').length
              const minor = cfg.headers.filter(h => h.severity === 'minor').length
              return (
                <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)', background: 'var(--color-background-secondary)', marginBottom: 8 }}>
                  <span className="badge badge-info">{code}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)' }}>{cfg.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>Validates {cfg.requiredDocument.label} — {cfg.headers.length} mandatory headers ({critical} Critical · {major} Major · {minor} Minor)</div>
                  </div>
                </div>
              )
            })}
            <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              More Practice Areas (PP, PMC, CM, MA, PPQA, DAR, RSKM…) can be added by defining a new checklist entry — no changes to the validation engine required.
            </div>
          </>
        )}

        {processing && (
          <div style={{ textAlign: 'center', padding: '2.5rem' }}>
            <div className="loading-dots" style={{ fontSize: 22, color: 'var(--color-text-secondary)' }}><span>.</span><span>.</span><span>.</span></div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 8 }}>Scanning folder and validating header rows…</div>
          </div>
        )}

        {scanWarning && (
          <div style={{ marginTop: '1rem', padding: '10px 12px', background: 'rgba(186,117,23,0.08)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #BA7517', fontSize: 12, color: '#7a4d0f' }}>
            {scanWarning}
          </div>
        )}

        {pkgResult && (
          <>
            {/* Folder Upload Status */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: '1.25rem' }}>
              {[
                ['Folder Uploaded', pkgResult.folder.rootName],
                ['Total Folders Found', pkgResult.folder.totalFolders],
                ['Total Files Found', pkgResult.folder.totalFiles],
                ['Scan Status', pkgResult.folder.scanStatus],
              ].map(([label, value]) => (
                <div key={label} style={{ padding: '10px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)', textAlign: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Practice Area Folder Availability — summary (domain-filtered) */}
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              Practice Area Results {selectedDomains.length > 0 && <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>— {domainsForSelection(selectedDomains).map(d => d.code).join(', ')}</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8, marginBottom: '1rem' }}>
              {[
                ['Total PA', domainRows.length, '#378ADD', 'rgba(55,138,221,0.08)'],
                ['Core PA', domainCoreCount, '#185FA5', 'rgba(55,138,221,0.08)'],
                ['Available', domainAvailable.length, '#639922', 'rgba(99,153,34,0.08)'],
                ['Missing', domainMissing.length, '#E24B4A', 'rgba(226,75,74,0.08)'],
                ['Gap', domainGap.length, '#BA7517', 'rgba(186,117,23,0.08)'],
                ['Score', `${domainRows.length ? Math.round((domainAvailable.length / domainRows.length) * 100) : 0}%`, '#185FA5', 'rgba(55,138,221,0.08)'],
              ].map(([label, count, color, bg]) => (
                <div key={label} style={{ padding: '10px', background: bg, borderRadius: 'var(--border-radius-md)', textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 600, color }}>{count}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Practice Area Results — table (click a row to drill down), domain-filtered */}
            <div style={{ overflowX: 'auto', marginBottom: '1.25rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['Domain', 'Practice Area', 'Type', 'Status', 'Path', 'Missing Document / Gap'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {domainRows.map(pa => (
                    <tr
                      key={pa.code}
                      onClick={() => selectPackagePA(pa.code)}
                      style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', cursor: 'pointer', background: pa.code === pkgSelectedPA ? 'rgba(55,138,221,0.06)' : undefined }}
                    >
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>{paDomainLabel(pa.code)}</td>
                      <td style={{ padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>{pa.code} <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— {pa.name}</span></td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{paTypeLabel(pa.code)}</td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}><PkgStatusBadge status={pa.combinedStatus.toUpperCase()} /></td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>{pa.path || '-'}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--color-text-secondary)', minWidth: 220 }}>{paMissingOrGapDetail(pa.code, pa.combinedStatus, paReports)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Available / Missing / Gap lists (domain-filtered) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: '1.25rem' }}>
              <div style={{ padding: '10px 12px', background: 'rgba(99,153,34,0.06)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #639922' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#639922', marginBottom: 6 }}>AVAILABLE ({domainAvailable.length})</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{domainAvailable.map(r => r.code).join(', ') || '—'}</div>
              </div>
              <div style={{ padding: '10px 12px', background: 'rgba(226,75,74,0.06)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #E24B4A' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#E24B4A', marginBottom: 6 }}>MISSING ({domainMissing.length})</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{domainMissing.map(r => r.code).join(', ') || '—'}</div>
              </div>
              <div style={{ padding: '10px 12px', background: 'rgba(186,117,23,0.06)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid #BA7517' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#BA7517', marginBottom: 6 }}>GAP ({domainGap.length})</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{domainGap.map(r => r.code).join(', ') || '—'}</div>
              </div>
            </div>

            {/* Drill-down panel */}
            {pkgSelectedPA && (
              <div style={{ border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)', padding: '1rem' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 10 }}>
                  {pkgSelectedPA} — Drill-Down
                </div>

                {pkgSelectedPA === 'IRP' ? (
                  <IRPPackageDrillDown irp={pkgResult.irp} />
                ) : (
                  <>
                    {!pkgDrillDown ? (
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Loading…</div>
                    ) : pkgDrillDown.folderStatus !== 'AVAILABLE' ? (
                      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                        <PkgStatusBadge status="MISSING" /> — this Practice Area folder was not found in the uploaded audit package.
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12 }}>
                          <div>Folder Status: <PkgStatusBadge status={pkgDrillDown.folderStatus} /></div>
                          <div>Evidence Status: <PkgStatusBadge status={pkgDrillDown.evidenceStatus} /></div>
                          <div style={{ color: 'var(--color-text-secondary)' }}>{pkgDrillDown.fileCount} file(s) found</div>
                        </div>
                        {pkgDrillDown.files.length > 0 && (
                          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                            {pkgDrillDown.files.map((f, i) => (
                              <div key={i} style={{ fontSize: 12, padding: '4px 0', color: 'var(--color-text-secondary)', display: 'flex', gap: 8 }}>
                                <IconFile size={12} /> {f.path ? `${f.path}/${f.name}` : f.name}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Audit Report ────────────────────────────────────────────────────
          ALWAYS visible once audit information has been captured — never
          gated on a Practice Area having been validated or on checklists.js
          having content. With zero findings, the generated reports still
          contain the real audit information plus a clear "No findings
          available for this audit." notice instead of fabricated data. ── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="section-title">Audit Report</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          Generates the CMMI Audit Findings Report (AFR) from every Practice Area validated so far in this session, using the audit information above.
          {Object.keys(paReports).length === 0 && ' No Practice Area has produced findings yet — the report will still download with the captured audit information.'}
        </div>
        <AFRDownloadMenu paReports={paReports} ncStore={ncStore} commentsStore={commentsStore} auditMeta={auditMeta} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} selectedDomains={selectedDomains} evidenceScanRows={evidenceScanRows} variant="split" />
      </div>

      {focusedResult && (
        <>
          {processedCodes.length > 1 && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                📁 {folderName} — {processedCodes.length} Practice Areas detected in this upload
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {processedCodes.map(code => {
                  const rr = paReports[code]
                  const color = rr.overallStatus === 'Compliant' ? '#639922' : rr.overallStatus === 'Partially Compliant' ? '#BA7517' : '#A32D2D'
                  return (
                    <div
                      key={code}
                      className="chip"
                      style={code === focusedPA ? { borderColor: '#378ADD', color: '#185FA5' } : undefined}
                      onClick={() => setFocusedPA(code)}
                    >
                      {code} · <span style={{ color, fontWeight: 600 }}>{rr.compliancePct}%</span>
                      <IconX size={12} style={{ marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); removePA(code) }} title={`Remove ${code}`} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <GapReportPanel result={focusedResult} onDownloadPDF={(result) => downloadGapReportPDF(result, auditMeta)} onDownloadExcel={() => downloadGapReportExcel(paReports, auditMeta, irpAuditResult)} />
          <AuditFindingsSection
            result={focusedResult}
            ncRecords={(ncStore[focusedPA] || {}).records || []}
            auditMeta={auditMeta}
            allPaReports={paReports}
            allNcStore={ncStore}
            commentsStore={commentsStore}
            setCommentsStore={setCommentsStore}
          />
        </>
      )}
    </div>
  )
}

// ─── Evidence Scan ────────────────────────────────────────────────────────────
//
// Folder-Based Keyword & Evidence Scan: scans a *parent* folder containing
// many project subfolders (evidenceScanEngine.js's groupFilesByProject
// groups by top-level folder = project) and classifies each document's
// content — OCR'd where needed — against the IRP/PLAN/RSK/RDM keyword lists
// in evidenceKeywords.js, independently per project. Different input shape
// from PA Validation above (which scans a SINGLE project's PA-named folder
// tree), so it gets its own upload flow, but feeds the exact same AFR
// generator: evidenceScanRows is lifted to App level exactly like
// pkgAvailability/paReports, so every AFRDownloadMenu (including this
// page's own) already includes it — no separate "generate" step needed.

function EvidenceKeywordChips({ keywords, tone }) {
  if (!keywords || keywords.length === 0) return <span style={{ color: 'var(--color-text-tertiary)' }}>-</span>
  const color = tone === 'found' ? '#639922' : '#E24B4A'
  const bg = tone === 'found' ? 'rgba(99,153,34,0.1)' : 'rgba(226,75,74,0.1)'
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {keywords.map(k => (
        <span key={k} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 999, color, background: bg, whiteSpace: 'nowrap' }}>{k}</span>
      ))}
    </div>
  )
}

function EvidenceScan({ evidenceScanRows, setEvidenceScanRows, auditMeta, paReports, ncStore, commentsStore, pkgAvailability, irpIssueLog, irpDataValidation, irpAuditResult, cmmiScanResult, setCmmiScanResult }) {
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [rootName, setRootName] = useState('')
  const fileInputRef = useRef(null)
  // Kept so the new "Run CMMI Audit Scan" button can reuse the same
  // uploaded files without asking the user to upload again — the existing
  // runEvidenceScan() flow below never stored the raw scan itself.
  const [lastRawScan, setLastRawScan] = useState(null)
  const [cmmiScanning, setCmmiScanning] = useState(false)
  const [cmmiError, setCmmiError] = useState('')

  const runScan = async (rawScan) => {
    setError('')
    setScanning(true)
    setProgress({ done: 0, total: 0, currentFile: '' })
    setLastRawScan(rawScan)
    try {
      const result = await runEvidenceScan(rawScan, { onProgress: setProgress })
      setEvidenceScanRows(result.rows)
      setRootName(rawScan.rootName)
    } catch (e) {
      setError(e.message || 'Could not complete the evidence scan. Please try again.')
    } finally {
      setScanning(false)
      setProgress(null)
    }
  }

  // Reuses the already-uploaded files (lastRawScan, from the folder upload
  // above) — extracts text via the existing documentTextExtraction.js, then
  // runs the new MASTER-rule-based scan (runNewCMMIScan ->
  // evidenceScanOrchestrator.js). Fully independent of runScan()/
  // evidenceScanRows above; does not touch that pipeline's state.
  //
  // Every uploaded file is processed here — not just the extensions
  // SUPPORTED_EVIDENCE_EXTS covers — so a file in an unsupported/legacy
  // format still gets a row (status ERROR + errorReason) instead of being
  // silently dropped before it ever reaches the scan (Fix 1 requirement:
  // no file may vanish without a trace in the Classification tab / Gap
  // Summary file count).
  const runNewCMMIScanHandler = async () => {
    if (!lastRawScan) return
    setCmmiError('')
    setCmmiScanning(true)
    try {
      const uploadedFiles = []
      for (const entry of lastRawScan.files) {
        const extraction = await extractDocumentText(entry)
        uploadedFiles.push({
          fileName: entry.name,
          text: extraction.text || '',
          status: extraction.status === 'ERROR' ? 'ERROR' : 'OK',
          errorReason: extraction.status === 'ERROR' ? (extraction.errorReason || extraction.error || 'Unknown error') : undefined,
          // Only set for format-level rejections (legacy .doc/.ppt) — see
          // documentTextExtraction.js's legacyFormatErrorResult(). Every
          // other ERROR case (corrupted file, unsupported extension, OCR
          // failure) falls back to evidenceScanOrchestrator.js's generic
          // ERROR/Low defaults.
          detectedType: extraction.status === 'ERROR' ? extraction.detectedType : undefined,
          confidence: extraction.status === 'ERROR' ? extraction.confidence : undefined,
        })
      }
      const projectName = (auditMeta && auditMeta.projectName) || rootName || 'CMMI Audit Project'
      const result = await runNewCMMIScan(uploadedFiles, projectName)
      setCmmiScanResult(result)
    } catch (e) {
      setCmmiError(e.message || 'Could not complete the CMMI audit scan. Please try again.')
    } finally {
      setCmmiScanning(false)
    }
  }

  const openLocalFolder = async () => {
    setError('')
    if (!window.showDirectoryPicker) {
      setError('Folder picker is not supported in this browser. Please use Chrome or Edge, or use the "Browse folder" option.')
      return
    }
    try {
      const dirHandle = await window.showDirectoryPicker()
      const rawScan = await scanDirectoryHandle(dirHandle)
      await runScan(rawScan)
    } catch (e) {
      if (e.name !== 'AbortError') setError('Could not read folder. Please try again.')
    }
  }

  const handleFileInput = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    const rawScan = scanFileList(files)
    await runScan(rawScan)
    e.target.value = ''
  }

  const resetScan = () => {
    setEvidenceScanRows([])
    setRootName('')
    setError('')
  }

  const projects = []
  const byProject = new Map()
  for (const row of evidenceScanRows) {
    if (!byProject.has(row.project)) { byProject.set(row.project, []); projects.push(row.project) }
    byProject.get(row.project).push(row)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>Evidence Scan</h2>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Upload a parent folder containing multiple project folders — every document is scanned (with OCR for scanned PDFs/images) and matched against the IRP, PLAN, RSK and RDM keyword lists, independently per project
          </div>
        </div>
        {evidenceScanRows.length > 0 && !scanning && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={resetScan}><IconTrash size={14} /> Clear / New Scan</button>
            <button className="btn btn-primary" onClick={runNewCMMIScanHandler} disabled={cmmiScanning}>
              {cmmiScanning ? <span className="spinner" /> : <IconFileSearch size={14} />}
              {cmmiScanning ? 'Running CMMI Audit Scan…' : 'Run CMMI Audit Scan'}
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="section-title">Upload Project Documents Folder</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          Recursively scans every project subfolder and file — Excel (.xlsx), Word (.docx), PDF (including scanned/OCR), PNG and JPG. Each top-level subfolder is treated as one project and scanned independently — an empty project folder never affects another project's results.
        </div>

        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#92400E',
          background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 'var(--border-radius-md)',
          padding: '10px 12px', marginBottom: 12,
        }}>
          <span>⚠️</span>
          <span>
            Supported formats: .docx, .xlsx, .xls, .pptx, .pdf, .jpg, .jpeg, .png<br />
            Legacy .doc and .ppt files are not supported. Please convert them to .docx or .pptx first.
          </span>
        </div>

        {!scanning && evidenceScanRows.length === 0 && (
          <>
            <input ref={fileInputRef} type="file" multiple webkitdirectory="" style={{ display: 'none' }} onChange={handleFileInput} />
            <div className="upload-zone" onClick={() => fileInputRef.current.click()}>
              <IconCloudUpload size={28} />
              <div style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}>Drop the parent Project Documents folder or click to browse</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Recursively scans every nested project subfolder and file</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: '1rem' }}>
              <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => fileInputRef.current.click()}><IconFolder size={14} /> Browse folder</button>
              <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={openLocalFolder}><IconFolder size={14} /> Select local folder</button>
            </div>
          </>
        )}

        {scanning && (
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            Scanning{progress && progress.total ? ` — ${progress.done} / ${progress.total} files` : '…'}
            {progress && progress.currentFile ? ` (${progress.currentFile})` : ''}
            <div style={{ marginTop: 8, height: 6, borderRadius: 999, background: 'var(--color-background-secondary)', overflow: 'hidden' }}>
              <div style={{ height: '100%', background: '#378ADD', width: progress && progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : '10%', transition: 'width 0.2s' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>Scanned/image documents are OCR'd in the browser — this can take several seconds per file.</div>
          </div>
        )}

        {error && <div style={{ fontSize: 12, color: '#E24B4A', marginTop: 10 }}>{error}</div>}
      </div>

      {evidenceScanRows.length > 0 && (
        <>
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div className="section-title" style={{ margin: 0 }}>Audit Report</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  Evidence Scan results are automatically included as a dedicated "Evidence Scan" sheet/section in the AFR — no separate step needed.
                </div>
              </div>
              <AFRDownloadMenu paReports={paReports} ncStore={ncStore} commentsStore={commentsStore} auditMeta={auditMeta} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} selectedDomains={[]} evidenceScanRows={evidenceScanRows} variant="split" />
            </div>
          </div>

          {rootName && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>📁 {rootName} — {projects.length} project{projects.length !== 1 ? 's' : ''} scanned</div>}

          {projects.map(projectName => {
            const rows = byProject.get(projectName)
            return (
              <div key={projectName} className="card" style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>
                  {projectName} <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)', fontSize: 12 }}>· {rows.length} document{rows.length !== 1 ? 's' : ''}</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {['Document', 'Document Type', 'Practice Area', 'Keywords Found', 'Keywords Missing', 'Evidence Status'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                          <td style={{ padding: '8px 10px', fontWeight: 500, color: 'var(--color-text-primary)' }} title={r.sourcePath || ''}>{r.document}{r.ocrUsed ? ' 🔎' : ''}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.documentType}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.practiceArea === 'UNCLASSIFIED' ? 'Unclassified' : r.practiceArea}</td>
                          <td style={{ padding: '8px 10px' }}><EvidenceKeywordChips keywords={r.keywordsFound} tone="found" /></td>
                          <td style={{ padding: '8px 10px' }}><EvidenceKeywordChips keywords={r.keywordsMissing} tone="missing" /></td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}><PkgStatusBadge status={r.evidenceStatus} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.some(r => r.note) && (
                  <div style={{ marginTop: 10, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {rows.filter(r => r.note).map((r, i) => <div key={i}>{r.document}: {r.note}</div>)}
                  </div>
                )}
              </div>
            )
          })}

          {cmmiError && <div style={{ fontSize: 12, color: '#E24B4A', marginTop: 10 }}>{cmmiError}</div>}
          <CMMIScanResults cmmiScanResult={cmmiScanResult} />
        </>
      )}
    </div>
  )
}

// ─── Gap Analysis ─────────────────────────────────────────────────────────────

function GapAnalysis({ switchTab, addChatMessage, paReports, initialPA, auditMeta }) {
  const [selectedPA, setSelectedPA] = useState(initialPA || 'PR')
  const pa = PRACTICE_AREAS.find(p => p.code === selectedPA)
  const liveResult = paReports[selectedPA]
  const gaps = GAP_DATA[selectedPA] || [{control:selectedPA+' 2.1',name:'General compliance',status:'compliant',desc:'Practice area evaluated — detailed analysis available'}]

  return (
    <div>
      <div style={{marginBottom:'1.25rem'}}>
        <h2 style={{fontSize:18,fontWeight:500}}>Gap analysis</h2>
        <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Independent, per-Practice-Area Gap Reports generated from PA Validation uploads</div>
      </div>
      <div className="row">
        <div className="col" style={{flex:1}}>
          <div className="card">
            <div className="section-title" style={{fontSize:14}}>Select practice area</div>
            <div className="scroll-area">
              {PRACTICE_AREAS.map(p => (
                <div key={p.code} className={`pa-item${p.code===selectedPA?' selected':''}`} onClick={() => setSelectedPA(p.code)}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                    <span style={{fontSize:13,fontWeight:500}}>{p.code}</span>
                    {paReports[p.code] ? (
                      <span className={`badge ${paReports[p.code].overallStatus==='Compliant'?'badge-success':paReports[p.code].overallStatus==='Partially Compliant'?'badge-warning':'badge-danger'}`} style={{fontSize:10}}>{paReports[p.code].compliancePct}%</span>
                    ) : (
                      <span className={`badge ${statusBadge(p.status)}`} style={{fontSize:10}}>{p.score}%</span>
                    )}
                  </div>
                  <div style={{fontSize:11,color:'var(--color-text-secondary)',marginTop:2}}>{p.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="col" style={{flex:2}}>
          {liveResult ? (
            <GapReportPanel result={liveResult} onDownloadPDF={(result) => downloadGapReportPDF(result, auditMeta || {})} onDownloadExcel={() => downloadGapReportExcel(paReports, auditMeta || {}, irpAuditResult)} />
          ) : (
            <div className="card">
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
                <div className="section-title" style={{margin:0}}>{selectedPA} — {pa.name}</div>
                <button className="btn btn-primary" style={{fontSize:12}} onClick={() => { switchTab('chatbot'); addChatMessage(`Analyze gaps in my organization for CMMI Level 5 practice area ${selectedPA} (${pa.name}). Identify all failing controls, explain what artifacts are missing, and provide specific remediation steps.`) }}>Analyze with AI ↗</button>
              </div>
              {SUPPORTED_PA_CODES.includes(selectedPA) && (
                <div style={{marginBottom:12,padding:'10px 12px',background:'rgba(55,138,221,0.06)',borderRadius:'var(--border-radius-md)',borderLeft:'3px solid #378ADD',fontSize:12,color:'var(--color-text-secondary)'}}>
                  No Gap Report yet for {selectedPA}. Upload its folder in{' '}
                  <span style={{color:'#185FA5',cursor:'pointer',fontWeight:500}} onClick={() => switchTab('pa-validation')}>PA Validation</span>
                  {' '}to generate a real, document-driven report.
                </div>
              )}
              {gaps.map(g => (
                <div key={g.control} className={`afr-item ${g.status==='missing'||g.status==='gap'?'gap':g.status==='partial'?'missing':'ok'}`} style={{marginBottom:8}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                    <span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{g.control} — {g.name}</span>
                    <span className={`badge ${statusBadge(g.status)}`} style={{fontSize:10}}>{g.status}</span>
                  </div>
                  <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>{g.desc}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Artifact Updater ─────────────────────────────────────────────────────────

// ─── Correlation Map ──────────────────────────────────────────────────────────

function CorrelationMap({ switchTab, addChatMessage }) {
  const [search, setSearch] = useState('')
  const filtered = CORR_DATA.filter(r =>
    !search || r.req.toLowerCase().includes(search.toLowerCase()) ||
    r.desc.toLowerCase().includes(search.toLowerCase()) ||
    r.brd.toLowerCase().includes(search.toLowerCase())
  )
  const coverage = [
    {label:'Fully traced',count:3,pct:50,color:'#639922'},
    {label:'Minor gaps',count:2,pct:33,color:'#BA7517'},
    {label:'Critical gaps',count:1,pct:17,color:'#E24B4A'},
  ]
  const missingLinks = [
    {req:'R-002',artifact:'Design Document',impact:'RDM 3.2 violation'},
    {req:'R-004',artifact:'Design Document',impact:'RDM 3.2 — Critical'},
    {req:'R-004',artifact:'Test Case',impact:'VV 3.1 violation'},
    {req:'R-006',artifact:'Deployment record',impact:'CM 2.3 gap'},
  ]
  const colStyle = {padding:'8px 10px',fontSize:11,borderRight:'0.5px solid var(--color-border-tertiary)'}
  const hdrStyle = {...colStyle,fontWeight:500,color:'var(--color-text-secondary)',background:'var(--color-background-secondary)'}

  return (
    <div>
      <div style={{marginBottom:'1.25rem'}}>
        <h2 style={{fontSize:18,fontWeight:500}}>Artifact correlation map</h2>
        <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Trace requirements across BRD → Design → Code → Test → Deployment</div>
      </div>
      <div className="card">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
          <div className="section-title" style={{margin:0}}>Traceability chain</div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <div style={{position:'relative'}}>
              <IconSearch size={13} style={{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',color:'var(--color-text-tertiary)'}}/>
              <input type="text" placeholder="Search requirement..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:200,fontSize:12,paddingLeft:28}}/>
            </div>
            <button className="btn btn-primary" style={{fontSize:12}} onClick={() => { switchTab('chatbot'); addChatMessage('Show me the full traceability chain for R-002 across all artifacts and identify any missing links') }}>Trace with AI ↗</button>
          </div>
        </div>
        {filtered.length === 0 ? (
          <div style={{textAlign:'center',padding:'2rem',color:'var(--color-text-tertiary)',fontSize:13}}>No requirements match "{search}"</div>
        ) : (
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead>
                <tr>
                  {['Req. ID','Description','BRD','Design doc','Code ref','Test case','Deploy','Status'].map(h => (
                    <th key={h} style={hdrStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.req} style={{borderBottom:'0.5px solid var(--color-border-tertiary)',background:r.status==='critical'?'rgba(226,75,74,0.05)':r.status==='gap'?'rgba(186,117,23,0.05)':''}}>
                    <td style={{...colStyle,fontWeight:500}}>{r.req}</td>
                    <td style={colStyle}>{r.desc}</td>
                    <td style={{...colStyle,color:'var(--color-text-info)'}}>{r.brd}</td>
                    <td style={{...colStyle,color:r.design==='—'?'#A32D2D':'var(--color-text-secondary)',fontWeight:r.design==='—'?500:400}}>{r.design}</td>
                    <td style={{...colStyle,color:'var(--color-text-secondary)'}}>{r.code}</td>
                    <td style={{...colStyle,color:r.test==='—'?'#A32D2D':'var(--color-text-secondary)',fontWeight:r.test==='—'?500:400}}>{r.test}</td>
                    <td style={{...colStyle,color:r.deploy==='—'?'#BA7517':'var(--color-text-secondary)'}}>{r.deploy}</td>
                    <td style={{padding:'8px 10px'}}>
                      <span className={`badge ${r.status==='ok'?'badge-success':r.status==='critical'?'badge-danger':'badge-warning'}`} style={{fontSize:10}}>
                        {r.status==='ok'?'✓ Linked':r.status==='critical'?'✗ Critical':'⚠ Gap'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="row" style={{marginTop:'1rem'}}>
        <div className="col">
          <div className="card">
            <div className="section-title" style={{fontSize:14}}>Coverage summary</div>
            {coverage.map(s => (
              <div key={s.label} style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <div style={{width:10,height:10,borderRadius:'50%',background:s.color}}/>
                  <span style={{fontSize:12,color:'var(--color-text-secondary)'}}>{s.label}</span>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <div className="progress-bar" style={{width:80}}><div className="progress-fill" style={{width:`${s.pct}%`,background:s.color}}/></div>
                  <span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{s.count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="col">
          <div className="card">
            <div className="section-title" style={{fontSize:14}}>Missing links</div>
            {missingLinks.map((m,i) => (
              <div key={i} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'8px 0',borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                <span className="badge badge-warning" style={{fontSize:10,flexShrink:0}}>{m.req}</span>
                <div>
                  <div style={{fontSize:12,color:'var(--color-text-primary)'}}>{m.artifact} missing</div>
                  <div style={{fontSize:11,color:'var(--color-text-danger)',marginTop:2}}>{m.impact}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Chatbot ──────────────────────────────────────────────────────────────────

function Chatbot({ messages, setMessages, pendingMessage, setPendingMessage }) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const msgRef = useRef(null)

  useEffect(() => {
    if (pendingMessage) { setInput(pendingMessage); setPendingMessage(null) }
  }, [pendingMessage])

  useEffect(() => {
    if (msgRef.current) msgRef.current.scrollTop = msgRef.current.scrollHeight
  }, [messages, loading])

  const suggestedQueries = [
    'How do I close AFR-001 (QPPOs)?','What is a Process Performance Baseline?',
    'How to achieve MPM Level 5 practices?','Explain CAR 5.1 requirements',
    'Prioritize my open AFRs',
  ]

  const sendChat = async () => {
    const msg = input.trim()
    if (!msg || loading) return
    setMessages(prev => [...prev, {role:'user',text:msg}])
    setInput('')
    setLoading(true)
    try {
      const response = await getAIResponse(msg)
      setMessages(prev => [...prev, {role:'ai',text:response}])
    } catch {
      setMessages(prev => [...prev, {role:'ai',text:'Sorry, there was an error. Please try again.'}])
    }
    setLoading(false)
  }

  return (
    <div>
      <div style={{marginBottom:'1.25rem'}}>
        <h2 style={{fontSize:18,fontWeight:500}}>AI compliance guide</h2>
        <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Chat with your CMMI Level 5 expert to close gaps and get guidance</div>
      </div>
      <div className="row">
        <div className="col" style={{flex:1}}>
          <div className="card">
            <div className="section-title" style={{fontSize:14}}>Suggested queries</div>
            <div>{suggestedQueries.map(q => (
              <span key={q} className="chip" onClick={() => { setInput(q) }}>
                <IconArrowRight size={12}/> {q}
              </span>
            ))}</div>
          </div>
          <div className="card">
            <div className="section-title" style={{fontSize:14}}>Open gaps</div>
            {AFR_DATA.slice(0,5).map(a => (
              <div key={a.id} className="corr-line" onClick={() => setInput(`Help me close ${a.id}: ${a.title}`)}>
                <div className="corr-dot" style={{background:a.severity==='critical'?'#E24B4A':a.severity==='major'?'#BA7517':'#378ADD'}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{a.id} — {a.pa}</div>
                  <div style={{fontSize:11,color:'var(--color-text-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.title}</div>
                </div>
                <IconArrowRight size={14} color="var(--color-text-tertiary)"/>
              </div>
            ))}
          </div>
        </div>
        <div className="col" style={{flex:2}}>
          <div className="card" style={{display:'flex',flexDirection:'column'}}>
            <div id="chat-messages" ref={msgRef}>
              {messages.map((m,i) => (
                <div key={i} className={`chat-msg ${m.role}`}>
                  {m.role==='ai' && <><strong>CMMI AI Guide</strong><br/></>}
                  <span style={{whiteSpace:'pre-wrap'}}>{m.text}</span>
                </div>
              ))}
              {loading && (
                <div className="chat-msg ai">
                  <strong>CMMI AI Guide</strong><br/>
                  <span className="loading-dots"><span>.</span><span>.</span><span>.</span></span>
                </div>
              )}
            </div>
            <div className="divider" style={{margin:'8px 0'}}/>
            <div style={{display:'flex',gap:8}}>
              <input type="text" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&sendChat()} placeholder="Ask about CMMI compliance, gaps, or artifact guidance..." style={{flex:1}} disabled={loading}/>
              <button className="btn btn-primary" onClick={sendChat} style={{flexShrink:0}} disabled={loading}><IconSend size={14}/></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── AFR Report ───────────────────────────────────────────────────────────────

// Real findings only — built from the exact same buildDetailedFindingsRows()
// that downloadAFRExcel()/downloadAFRWord() use, so this on-screen page
// always agrees with the downloaded AFR file (no second, divergent
// mechanism, nothing fabricated). Each row's 'Severity' is real: Source 4
// (IRP incident findings) carries the underlying finding's own severity;
// Sources 1-3 are assigned severity using the same conventions already
// established elsewhere in this codebase for the same category of gap (see
// afrExport.js).
function AFRReport({ switchTab, addChatMessage, auditMeta, paReports, ncStore, commentsStore, pkgAvailability, irpIssueLog, irpDataValidation, irpAuditResult, evidenceScanRows }) {
  const [filter, setFilter] = useState('all')
  const [selectedDomains, setSelectedDomains] = useState([])

  const detailedRows = buildDetailedFindingsRows(pkgAvailability, paReports, irpDataValidation, irpAuditResult, selectedDomains, auditMeta || {}, irpIssueLog)
  const critical = detailedRows.filter(r => r.Severity === 'Critical').length
  const major = detailedRows.filter(r => r.Severity === 'Major').length
  const minor = detailedRows.filter(r => r.Severity === 'Minor').length
  const filtered = filter === 'all' ? detailedRows : detailedRows.filter(r => r.Severity?.toLowerCase() === filter)

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1.25rem'}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:500}}>AFR report</h2>
          <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Audit Findings Report — CMMI V3.0 audit</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <AFRDownloadMenu paReports={paReports} ncStore={ncStore} commentsStore={commentsStore} auditMeta={auditMeta} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} selectedDomains={selectedDomains} evidenceScanRows={evidenceScanRows} />
          <button className="btn btn-primary" onClick={() => { switchTab('chatbot'); addChatMessage('Create executive summary of our CMMI Level 5 audit findings and prioritized action plan') }}>Executive summary ↗</button>
        </div>
      </div>
      <AuditMetaBanner auditMeta={auditMeta} />
      <div style={{marginBottom:'1rem'}}>
        <DomainMultiSelect selected={selectedDomains} onChange={setSelectedDomains} />
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:'1rem'}}>
        <div className="metric-card"><div className="metric-label">Total findings</div><div className="metric-value" style={{color:'#185FA5'}}>{detailedRows.length}</div><div className="metric-sub">Across all assessed Practice Areas</div></div>
        <div className="metric-card"><div className="metric-label">Critical</div><div className="metric-value" style={{color:'#A32D2D'}}>{critical}</div><div className="metric-sub">Requires immediate action</div></div>
        <div className="metric-card"><div className="metric-label">Major</div><div className="metric-value" style={{color:'#BA7517'}}>{major}</div><div className="metric-sub">Requires remediation</div></div>
        <div className="metric-card"><div className="metric-label">Minor</div><div className="metric-value" style={{color:'#378ADD'}}>{minor}</div><div className="metric-sub">Lower-priority improvement</div></div>
      </div>
      <div className="card">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
          <div className="section-title" style={{margin:0}}>All findings</div>
          <div style={{display:'flex',gap:6}}>
            {[['critical',`Critical (${critical})`,'badge-danger'],['major',`Major (${major})`,'badge-warning'],['minor',`Minor (${minor})`,'badge-info'],['all','All','badge-gray']].map(([f,l,cls]) => (
              <span key={f} className={`badge ${cls}`} style={{cursor:'pointer',outline:filter===f?'2px solid #378ADD':undefined,outlineOffset:2}} onClick={() => setFilter(f)}>{l}</span>
            ))}
          </div>
        </div>
        {detailedRows.length === 0 ? (
          <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>No findings available for this audit yet — scan a project repository from the Repository or PA Validation tab to generate real findings.</div>
        ) : filtered.map((r, i) => (
          <div key={i} className={`afr-item ${r.Severity === 'Critical' ? 'gap' : r.Severity === 'Major' ? 'missing' : 'ok'}`} style={{marginBottom:10}}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:6}}>
              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                {r['Incident ID'] && r['Incident ID'] !== '-' && <span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{r['Incident ID']}</span>}
                <span className={`badge ${r.Severity === 'Critical' ? 'badge-danger' : r.Severity === 'Major' ? 'badge-warning' : 'badge-info'}`} style={{fontSize:10}}>{r.Severity}</span>
                <span className="badge badge-gray" style={{fontSize:10}}>{r['CMMI Practice Areas']}</span>
              </div>
              <button className="btn" style={{fontSize:11,padding:'4px 10px'}} onClick={() => { switchTab('chatbot'); addChatMessage(`Help me remediate this finding: ${r['Findings']}`) }}>Remediate ↗</button>
            </div>
            <div style={{fontSize:12,color:'var(--color-text-primary)',marginBottom:6}}>{r['Findings']}</div>
            <div style={{marginTop:6,padding:'6px 10px',background:'rgba(55,138,221,0.06)',borderRadius:'var(--border-radius-md)',fontSize:11,color:'var(--color-text-secondary)'}}>
              <strong style={{color:'var(--color-text-info)'}}>Recommendation:</strong> {r['Recommendations']}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── App Shell ────────────────────────────────────────────────────────────────

const TABS = [
  {id:'dashboard',     label:'Dashboard',         Icon:IconLayoutDashboard},
  {id:'repository',    label:'Repository scan',   Icon:IconFolderOpen},
  {id:'pa-validation', label:'PA Validation',     Icon:IconFileCheck},
  {id:'evidence-scan', label:'Evidence Scan',     Icon:IconFileSearch},
  {id:'gaps',          label:'Gap analysis',      Icon:IconClipboardCheck},
  {id:'correlation',   label:'Correlation map',   Icon:IconArrowsTransferUp},
  {id:'chatbot',       label:'AI guide',          Icon:IconMessageChatbot},
  {id:'afr',           label:'AFR report',        Icon:IconReportAnalytics},
]

const INITIAL_MESSAGES = [{
  role:'ai',
  text:"Hello! I'm your CMMI Level 5 compliance assistant. I have full knowledge of the CMMI V3.0 model, all 24 practice areas, and your organization's current audit findings.\n\nI can help you close the 11 open AFRs, guide you on artifact creation, explain specific CMMI controls, and provide step-by-step remediation plans. Where would you like to start?"
}]

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [chatMessages, setChatMessages] = useState(INITIAL_MESSAGES)
  const [pendingMessage, setPendingMessage] = useState(null)
  const [scanResults, setScanResults] = useState(null)
  const [paReports, setPaReports] = useState({})
  const [ncStore, setNcStore] = useState({})
  const [commentsStore, setCommentsStore] = useState({}) // { [ncId]: string } — session-only auditor comments
  // Stage-1 folder/document availability per Practice Area code, lifted from
  // PA Validation so the Dashboard can compute real, domain-filtered KPIs
  // from the same scan data. null = no folder has been scanned yet this
  // session; otherwise { [paCode]: 'AVAILABLE' | 'MISSING' }, accumulated
  // across every upload (mirrors paReports/ncStore's accumulation pattern).
  const [pkgAvailability, setPkgAvailability] = useState(null)
  // The real, currently-active checkIrpIssueLog() result for the IRP
  // Practice Area (24 required Issue Log fields — see irpIssueLogEngine.js),
  // lifted the same way as pkgAvailability so the AFR generator can use IRP's
  // actual, already-computed checklist data instead of treating IRP as
  // unassessed just because checklists.js has no generic PA_CHECKLISTS entry
  // for it. null = no folder scanned yet this session.
  const [irpIssueLog, setIrpIssueLog] = useState(null)
  // Real IRP Incident Log data-row validation (Report Date vs Closure Date
  // ordering, duplicate Incident ID) — see irpDataValidation.js. Computed
  // alongside irpIssueLog from the same scan. null = not yet computed.
  const [irpDataValidation, setIrpDataValidation] = useState(null)
  // Full IRP Incident/RCA/Lesson-Learned audit result (Priority Matrix, SLA
  // breach, RCA-required, RCA traceability, Closed Date/Time, Issue Category
  // — see incidentEngine.js/rcaEngine.js/irpAudit.js), computed alongside
  // irpDataValidation from the same scan so the Gap Report and AFR can
  // surface incident-level gaps, each with its Incident ID. null = not yet
  // computed this session.
  const [irpAuditResult, setIrpAuditResult] = useState(null)
  // Folder-Based Keyword & Evidence Scan results (evidenceScanEngine.js's
  // runEvidenceScan()), lifted from the Evidence Scan tab the same way
  // pkgAvailability/paReports are lifted from PA Validation, so every
  // AFRDownloadMenu (PA Validation, Dashboard, AFR Report, Evidence Scan
  // itself) already includes it once a scan has run. Full replace (not
  // accumulate) on each scan — keeps re-scans free of duplicate findings.
  const [evidenceScanRows, setEvidenceScanRows] = useState([])
  // Result of the new MASTER-rule-based CMMI Audit Scan (runNewCMMIScan(),
  // evidenceScanEngine.js -> evidenceScanOrchestrator.js) — independent of,
  // and additional to, evidenceScanRows above. null = not yet run.
  const [cmmiScanResult, setCmmiScanResult] = useState(null)
  const [gapFocusPA, setGapFocusPA] = useState(null)
  const [auditMeta, setAuditMeta] = useState(null)
  const openGapReport = (code) => { setGapFocusPA(code); setActiveTab('gaps') }

  const switchTab = (tab) => setActiveTab(tab)
  const addChatMessage = (msg) => { setActiveTab('chatbot'); setPendingMessage(msg) }

  return (
    <div className="app">
      <div className="sidebar">
        <div style={{padding:16,borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
          <div style={{fontSize:13,fontWeight:500,color:'var(--color-text-primary)'}}>CMMI Audit AI</div>
          <div style={{fontSize:11,color:'var(--color-text-secondary)',marginTop:2}}>Level 5 · v3.0</div>
        </div>
        <div style={{padding:'8px 0',flex:1}}>
          <div style={{padding:'8px 16px',fontSize:11,color:'var(--color-text-tertiary)',textTransform:'uppercase',letterSpacing:'0.05em',marginTop:4}}>Audit modules</div>
          {TABS.map(({id,label,Icon}) => (
            <div key={id} className={`nav-item${activeTab===id?' active':''}`} onClick={() => switchTab(id)}>
              <Icon size={17}/> {label}
            </div>
          ))}
        </div>
        <div style={{padding:16,borderTop:'0.5px solid var(--color-border-tertiary)'}}>
          <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Audit session</div>
          <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>{auditMeta ? `${auditMeta.projectName} · ${auditMeta.auditDate}` : 'TechCorp Inc. · 2025'}</div>
        </div>
      </div>
      <div className="main">
        {activeTab==='dashboard'     && <Dashboard switchTab={switchTab} addChatMessage={addChatMessage} scanResults={scanResults} paReports={paReports} ncStore={ncStore} commentsStore={commentsStore} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} onOpenGapReport={openGapReport} auditMeta={auditMeta} evidenceScanRows={evidenceScanRows}/>}
        {activeTab==='repository'    && <Repository switchTab={switchTab} addChatMessage={addChatMessage} setScanResults={setScanResults} scanResults={scanResults}/>}
        {activeTab==='pa-validation' && <PAValidation paReports={paReports} setPaReports={setPaReports} ncStore={ncStore} setNcStore={setNcStore} auditMeta={auditMeta} onAuditMetaSubmit={setAuditMeta} commentsStore={commentsStore} setCommentsStore={setCommentsStore} pkgAvailability={pkgAvailability} setPkgAvailability={setPkgAvailability} irpIssueLog={irpIssueLog} setIrpIssueLog={setIrpIssueLog} irpDataValidation={irpDataValidation} setIrpDataValidation={setIrpDataValidation} irpAuditResult={irpAuditResult} setIrpAuditResult={setIrpAuditResult} evidenceScanRows={evidenceScanRows}/>}
        {activeTab==='evidence-scan' && <EvidenceScan evidenceScanRows={evidenceScanRows} setEvidenceScanRows={setEvidenceScanRows} auditMeta={auditMeta} paReports={paReports} ncStore={ncStore} commentsStore={commentsStore} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} cmmiScanResult={cmmiScanResult} setCmmiScanResult={setCmmiScanResult}/>}
        {activeTab==='gaps'          && <GapAnalysis switchTab={switchTab} addChatMessage={addChatMessage} paReports={paReports} initialPA={gapFocusPA} auditMeta={auditMeta}/>}
        {activeTab==='correlation' && <CorrelationMap switchTab={switchTab} addChatMessage={addChatMessage}/>}
        {activeTab==='chatbot'     && <Chatbot messages={chatMessages} setMessages={setChatMessages} pendingMessage={pendingMessage} setPendingMessage={setPendingMessage}/>}
        {activeTab==='afr'         && <AFRReport switchTab={switchTab} addChatMessage={addChatMessage} auditMeta={auditMeta} paReports={paReports} ncStore={ncStore} commentsStore={commentsStore} pkgAvailability={pkgAvailability} irpIssueLog={irpIssueLog} irpDataValidation={irpDataValidation} irpAuditResult={irpAuditResult} evidenceScanRows={evidenceScanRows}/>}
      </div>
    </div>
  )
}
