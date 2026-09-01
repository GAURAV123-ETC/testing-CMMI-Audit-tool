import { useState, useRef, useEffect } from 'react'
import {
  IconLayoutDashboard, IconFolderOpen, IconClipboardCheck,
  IconFileDescription, IconArrowsTransferUp, IconMessageChatbot,
  IconReportAnalytics, IconPlayerPlay, IconZoomCode, IconReport,
  IconCloudUpload, IconBrandGithub, IconCloud, IconBrandGoogle,
  IconFolder, IconArrowRight, IconEdit, IconDownload, IconSend,
  IconSparkles, IconFile, IconFileExport
} from '@tabler/icons-react'

// ─── Data ────────────────────────────────────────────────────────────────────

const PRACTICE_AREAS = [
  {code:'CM',  name:'Configuration Management',    score:91, status:'compliant'},
  {code:'DAR', name:'Decision Analysis & Resolution', score:74, status:'partial'},
  {code:'EST', name:'Estimating',                  score:88, status:'compliant'},
  {code:'GOV', name:'Governance',                  score:65, status:'partial'},
  {code:'II',  name:'Implementation Infrastructure', score:70, status:'partial'},
  {code:'MC',  name:'Monitor & Control',            score:84, status:'compliant'},
  {code:'MPM', name:'Managing Performance & Measurement', score:60, status:'critical'},
  {code:'OPD', name:'Organizational Process Definition', score:78, status:'partial'},
  {code:'OPM', name:'Org Process Performance',     score:62, status:'critical'},
  {code:'PAD', name:'Process Asset Dev',            score:80, status:'compliant'},
  {code:'PCM', name:'Process Change Mgmt',          score:72, status:'partial'},
  {code:'PDD', name:'Product Dev & Design',         score:85, status:'compliant'},
  {code:'PR',  name:'Peer Reviews',                 score:89, status:'compliant'},
  {code:'RDM', name:'Requirements Dev & Mgmt',      score:76, status:'partial'},
  {code:'RSK', name:'Risk & Opportunity Mgmt',      score:83, status:'compliant'},
  {code:'SAM', name:'Supplier Agreement Mgmt',      score:71, status:'partial'},
  {code:'TS',  name:'Technical Solution',           score:87, status:'compliant'},
  {code:'VV',  name:'Verification & Validation',    score:79, status:'compliant'},
]

const AFR_DATA = [
  {id:'AFR-001',severity:'critical',pa:'MPM',title:'Quantitative performance objectives not established',desc:'Organization has not defined measurable QPPOs linked to business objectives as required by MPM 4.1 and MPM 5.1',artifact:'Process Performance Baseline',recommendation:'Define at least 3 QPPOs with statistical baselines and target ranges within 30 days'},
  {id:'AFR-002',severity:'critical',pa:'OPM',title:'No Process Performance Models (PPMs) documented',desc:'Absence of PPMs prevents quantitative prediction of process outcomes; violates OPM 4.2 mandatory practice',artifact:'OPM Documentation',recommendation:'Develop PPMs using regression analysis on historical data covering at least 2 project cycles'},
  {id:'AFR-005',severity:'major',pa:'GOV',title:'Senior management review cadence insufficient',desc:'GOV 2.2 requires periodic senior management review of process performance. Last review was 6 months ago',artifact:'Management Review Minutes',recommendation:'Schedule monthly management reviews with process performance dashboards'},
  {id:'AFR-006',severity:'major',pa:'RDM',title:'Bidirectional requirements traceability gaps',desc:'RDM 3.2 mandates traceability from requirements to design and test. 12% of requirements lack design references',artifact:'RTM',recommendation:'Update RTM to add design document references for 23 requirements flagged in gap analysis'},
  {id:'AFR-007',severity:'major',pa:'SAM',title:'Supplier performance metrics not quantified',desc:'SAM 3.3 requires quantitative supplier performance tracking. Current tracking is qualitative only',artifact:'Supplier Agreements',recommendation:'Define measurable SLAs and KPIs for top 5 suppliers within 45 days'},
  {id:'AFR-008',severity:'major',pa:'PCM',title:'Process change impact analysis missing',desc:'PCM 3.2 requires documented impact analysis before process changes. 4 recent changes lack documentation',artifact:'Change Log',recommendation:'Retroactively document impact analysis and implement mandatory review gate for future changes'},
  {id:'AFR-009',severity:'minor',pa:'DAR',title:'Decision criteria not always documented',desc:'DAR 2.1 requires evaluation criteria documented before alternative analysis. 3 recent decisions undocumented',artifact:'Decision Log',recommendation:'Establish decision analysis template and add to project initiation checklist'},
  {id:'AFR-010',severity:'minor',pa:'PR',title:'Peer review data not consistently collected',desc:'PR 3.1 requires defect density data from reviews to be collected and analyzed. Gaps in Q3 data',artifact:'Peer Review Records',recommendation:'Update peer review template to include defect count and severity fields'},
  {id:'AFR-011',severity:'minor',pa:'II',title:'Training records incomplete for key roles',desc:'II 2.3 requires training records for all personnel performing CMMI-impacted roles',artifact:'Training Records',recommendation:'Audit training records and capture any missing completions within 2 weeks'},
]

const GAP_DATA = {
  MPM: [
    {control:'MPM 4.1',name:'Define QPPOs',status:'missing',desc:'No quantitative process performance objectives defined at organizational level'},
    {control:'MPM 4.2',name:'Establish PPBs',status:'partial',desc:'PPBs exist for 2 of 5 critical processes. Missing for test, deployment'},
    {control:'MPM 5.1',name:'Predictive performance',status:'missing',desc:'No statistical models for predicting process outcomes'},
    {control:'MPM 5.2',name:'Causal analysis of variation',status:'partial',desc:'Analysis done ad hoc, not systematically linked to QPPOs'},
  ],
  RDM: [
    {control:'RDM 2.1',name:'Requirements elicitation',status:'compliant',desc:'Requirements elicitation process well-documented and followed'},
    {control:'RDM 2.2',name:'Requirements analysis',status:'compliant',desc:'Analysis templates in use and consistently applied'},
    {control:'RDM 3.1',name:'Requirements allocation',status:'partial',desc:'Allocation to subsystems incomplete for 3 modules'},
    {control:'RDM 3.2',name:'Bidirectional traceability',status:'gap',desc:'12% of requirements missing design document references'},
    {control:'RDM 3.3',name:'Requirements validation',status:'compliant',desc:'Validation with stakeholders documented'},
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const severityBadge = s => s==='critical'?'badge-danger':s==='major'?'badge-warning':s==='minor'?'badge-info':'badge-gray'
const statusBadge = s => s==='compliant'?'badge-success':s==='missing'||s==='gap'?'badge-danger':'badge-warning'
const afrClass = s => s==='critical'?'gap':s==='major'?'missing':'ok'

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ switchTab, addChatMessage }) {
  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1.25rem'}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:500,color:'var(--color-text-primary)'}}>Audit dashboard</h2>
          <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>CMMI V3.0 · Maturity level 5 · Real-time analysis</div>
        </div>
        <button className="btn btn-primary" onClick={() => { switchTab('chatbot'); addChatMessage('Run a full CMMI Level 5 audit analysis on my organization') }}>
          <IconPlayerPlay size={14}/> Run full audit ↗
        </button>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:'1.25rem'}}>
        <div className="metric-card"><div className="metric-label">Overall score</div><div className="metric-value" style={{color:'#185FA5'}}>78%</div><div className="metric-sub">↑ 5% from last audit</div></div>
        <div className="metric-card"><div className="metric-label">Practice areas</div><div className="metric-value">24</div><div className="metric-sub">19 evaluated</div></div>
        <div className="metric-card"><div className="metric-label">Open AFRs</div><div className="metric-value" style={{color:'#A32D2D'}}>11</div><div className="metric-sub">3 critical</div></div>
        <div className="metric-card"><div className="metric-label">Artifacts analyzed</div><div className="metric-value">47</div><div className="metric-sub">8 with gaps</div></div>
      </div>

      <div className="row">
        <div className="col" style={{flex:1.5}}>
          <div className="card">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
              <div className="section-title" style={{margin:0}}>Practice area scores</div>
              <span className="badge badge-info">Level 5 targets</span>
            </div>
            {PRACTICE_AREAS.slice(0,8).map(pa => (
              <div key={pa.code} style={{marginBottom:10}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{fontSize:12,color:'var(--color-text-primary)'}}>{pa.code} — {pa.name}</span>
                  <span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{pa.score}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{width:`${pa.score}%`,background:pa.score>=85?'#639922':pa.score>=70?'#185FA5':'#E24B4A'}}/>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="col" style={{flex:1}}>
          <div className="card" style={{textAlign:'center'}}>
            <div className="section-title" style={{marginBottom:'1.25rem'}}>Audit score</div>
            <div className="score-ring">
              <svg width="130" height="130" viewBox="0 0 130 130">
                <circle cx="65" cy="65" r="55" fill="none" stroke="var(--color-background-secondary)" strokeWidth="14"/>
                <circle cx="65" cy="65" r="55" fill="none" stroke="#185FA5" strokeWidth="14" strokeDasharray="345.6" strokeDashoffset="76" strokeLinecap="round"/>
              </svg>
              <div className="score-text">
                <div style={{fontSize:26,fontWeight:500,color:'var(--color-text-primary)'}}>78</div>
                <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>/ 100</div>
              </div>
            </div>
            <div style={{marginTop:'1rem',display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,textAlign:'left'}}>
              {[['#639922','Compliant: 13'],['#E24B4A','Critical: 3'],['#BA7517','Partial: 8'],['#888780','N/A: 5']].map(([c,l]) => (
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
    </div>
  )
}

// ─── Repository Scan ──────────────────────────────────────────────────────────

function Repository({ switchTab, addChatMessage }) {
  const [uploaded, setUploaded] = useState(false)
  const missing = [
    {pa:'MPM',missing:['Process Performance Baselines','Process Performance Models','QPPO documentation','Statistical analysis reports'],severity:'critical'},
    {pa:'GOV',missing:['Senior management review records (Q3-Q4)'],severity:'major'},
    {pa:'RDM',missing:['Updated RTM with design refs for R-002, R-004'],severity:'major'},
    {pa:'SAM',missing:['Quantitative supplier SLA metrics'],severity:'major'},
  ]
  return (
    <div>
      <div style={{marginBottom:'1.25rem'}}>
        <h2 style={{fontSize:18,fontWeight:500}}>Repository scan</h2>
        <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Identify missing artifacts across CMMI practice areas</div>
      </div>
      <div className="row">
        <div className="col" style={{flex:1.2}}>
          <div className="card">
            <div className="section-title">Upload artifacts</div>
            <div className="upload-zone" onClick={() => setUploaded(true)}>
              <IconCloudUpload size={28}/>
              <div style={{marginTop:8,fontSize:14,fontWeight:500}}>Drop files or click to browse</div>
              <div style={{fontSize:12,marginTop:4}}>Supports PDF, DOCX, XLSX, TXT</div>
            </div>
            {uploaded && (
              <div style={{marginTop:12}}>
                {['SDP_v2.3.docx','RTM_v1.8.xlsx','RiskPlan_2025.pdf','QA_Plan.docx'].map(f => (
                  <div key={f} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderBottom:'0.5px solid var(--color-border-tertiary)',fontSize:12}}>
                    <IconFile size={14} color="var(--color-text-secondary)"/>
                    <span style={{flex:1,color:'var(--color-text-primary)'}}>{f}</span>
                    <span className="badge badge-success" style={{fontSize:10}}>✓ Indexed</span>
                  </div>
                ))}
              </div>
            )}
            <div className="divider"/>
            <div style={{fontSize:13,fontWeight:500,marginBottom:10}}>Or connect repository</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {[[IconBrandGithub,'GitHub'],[IconCloud,'SharePoint'],[IconBrandGoogle,'Google Drive'],[IconFolder,'Local folder']].map(([Icon,label]) => (
                <button key={label} className="btn" style={{fontSize:12,justifyContent:'center'}}><Icon size={14}/> {label}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="col" style={{flex:2}}>
          <div className="card">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
              <div className="section-title" style={{margin:0}}>Missing artifacts by practice area</div>
              <button className="btn btn-primary" style={{fontSize:12}} onClick={() => { switchTab('chatbot'); addChatMessage('Identify all missing artifacts in my repository for CMMI Level 5 compliance and provide detailed recommendations') }}>AI scan ↗</button>
            </div>
            {missing.map(a => (
              <div key={a.pa} className={`afr-item ${a.severity==='critical'?'gap':'missing'}`} style={{marginBottom:8}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{fontSize:13,fontWeight:500,color:'var(--color-text-primary)'}}>{a.pa}</span>
                  <span className={`badge ${severityBadge(a.severity)}`} style={{fontSize:11}}>{a.severity}</span>
                </div>
                {a.missing.map(m => <div key={m} style={{fontSize:12,color:'var(--color-text-secondary)',padding:'2px 0'}}>• {m}</div>)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Gap Analysis ─────────────────────────────────────────────────────────────

function GapAnalysis({ switchTab, addChatMessage }) {
  const [selectedPA, setSelectedPA] = useState('MPM')
  const pa = PRACTICE_AREAS.find(p => p.code === selectedPA)
  const gaps = GAP_DATA[selectedPA] || [{control:selectedPA+' 2.1',name:'General compliance',status:'compliant',desc:'Practice area evaluated — detailed analysis available'}]

  return (
    <div>
      <div style={{marginBottom:'1.25rem'}}>
        <h2 style={{fontSize:18,fontWeight:500}}>Gap analysis</h2>
        <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Evaluate artifacts against CMMI Level 5 mandatory controls</div>
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
                    <span className={`badge ${statusBadge(p.status)}`} style={{fontSize:10}}>{p.score}%</span>
                  </div>
                  <div style={{fontSize:11,color:'var(--color-text-secondary)',marginTop:2}}>{p.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="col" style={{flex:2}}>
          <div className="card">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
              <div className="section-title" style={{margin:0}}>{selectedPA} — {pa.name}</div>
              <button className="btn btn-primary" style={{fontSize:12}} onClick={() => { switchTab('chatbot'); addChatMessage(`Analyze gaps in my organization for CMMI Level 5 practice area ${selectedPA} (${pa.name}). Identify all failing controls, explain what artifacts are missing, and provide specific remediation steps.`) }}>Analyze with AI ↗</button>
            </div>
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
        </div>
      </div>
    </div>
  )
}

// ─── Artifact Updater ─────────────────────────────────────────────────────────

function ArtifactUpdater({ switchTab, addChatMessage }) {
  const artifactGaps = [
    {gap:'R-002 missing design reference',severity:'major'},
    {gap:'R-004 missing design + test reference',severity:'critical'},
    {gap:'No version control history linked',severity:'minor'},
  ]
  const suggestions = [
    'Add Design Document DD-SEC-002 reference for R-002',
    'Create Performance Design Document for R-004',
    'Link test cases TC-204, TC-205 for R-004',
    'Add CM baseline tag to RTM version header',
  ]
  return (
    <div>
      <div style={{marginBottom:'1.25rem'}}>
        <h2 style={{fontSize:18,fontWeight:500}}>Artifact updater</h2>
        <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>AI-assisted artifact remediation based on gap feedback</div>
      </div>
      <div className="row">
        <div className="col">
          <div className="card">
            <div className="section-title">Select artifact to update</div>
            <select style={{marginBottom:12}}>
              {['Requirements Traceability Matrix (RTM)','Software Development Plan (SDP)','Risk Management Plan','Process Performance Baseline (PPB)','Configuration Management Plan','Quality Assurance Plan'].map(o => <option key={o}>{o}</option>)}
            </select>
            <div className="card" style={{background:'var(--color-background-secondary)',borderColor:'var(--color-border-tertiary)'}}>
              <div style={{fontSize:12,fontWeight:500,color:'var(--color-text-secondary)',marginBottom:8}}>Identified gaps in this artifact</div>
              {artifactGaps.map(g => (
                <div key={g.gap} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                  <span className={`badge ${severityBadge(g.severity)}`} style={{fontSize:10}}>{g.severity}</span>
                  <span style={{fontSize:12,color:'var(--color-text-secondary)'}}>{g.gap}</span>
                </div>
              ))}
            </div>
            <div className="divider"/>
            <div style={{fontSize:13,fontWeight:500,marginBottom:8}}>AI suggested sections to add</div>
            {suggestions.map(s => (
              <div key={s} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',fontSize:12,color:'var(--color-text-secondary)'}}>
                <IconSparkles size={14} color="#185FA5" style={{marginTop:1,flexShrink:0}}/> {s}
              </div>
            ))}
            <div style={{marginTop:12}}>
              <button className="btn btn-primary" style={{width:'100%',justifyContent:'center'}} onClick={() => { switchTab('chatbot'); addChatMessage('Help me update the Requirements Traceability Matrix to meet CMMI Level 5 compliance. Provide specific content additions for missing controls.') }}>Generate updated content ↗</button>
            </div>
          </div>
        </div>
        <div className="col">
          <div className="card" style={{height:'100%'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
              <div className="section-title" style={{margin:0}}>Artifact preview</div>
              <div style={{display:'flex',gap:6}}>
                <button className="btn" style={{fontSize:12}}><IconEdit size={13}/> Edit</button>
                <button className="btn" style={{fontSize:12}}><IconDownload size={13}/> Export</button>
              </div>
            </div>
            <div style={{background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)',padding:'1rem',fontSize:12,lineHeight:1.8,color:'var(--color-text-secondary)',minHeight:300}}>
              <div style={{fontWeight:500,color:'var(--color-text-primary)',marginBottom:8,fontSize:13}}>Requirements Traceability Matrix v2.1</div>
              <div style={{borderBottom:'0.5px solid var(--color-border-tertiary)',paddingBottom:8,marginBottom:8}}>
                <span className="badge badge-warning" style={{fontSize:11}}>⚠ 3 gaps found</span>
              </div>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                <thead>
                  <tr style={{borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                    {['Req. ID','Description','Design ref','Test case','Status'].map(h => (
                      <th key={h} style={{textAlign:'left',padding:'6px 4px',color:'var(--color-text-secondary)'}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                    <td style={{padding:'6px 4px'}}>R-001</td><td style={{padding:'6px 4px'}}>User authentication</td><td style={{padding:'6px 4px'}}>DD-2.1</td><td style={{padding:'6px 4px'}}>TC-101</td><td style={{padding:'6px 4px'}}><span className="badge badge-success" style={{fontSize:10}}>✓ Linked</span></td>
                  </tr>
                  <tr style={{borderBottom:'0.5px solid var(--color-border-tertiary)',background:'rgba(186,117,23,0.06)'}}>
                    <td style={{padding:'6px 4px'}}>R-002</td><td style={{padding:'6px 4px'}}>Data encryption at rest</td><td style={{padding:'6px 4px',color:'#BA7517'}}>Missing</td><td style={{padding:'6px 4px'}}>TC-102</td><td style={{padding:'6px 4px'}}><span className="badge badge-warning" style={{fontSize:10}}>⚠ Gap</span></td>
                  </tr>
                  <tr style={{borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                    <td style={{padding:'6px 4px'}}>R-003</td><td style={{padding:'6px 4px'}}>Audit logging</td><td style={{padding:'6px 4px'}}>DD-4.2</td><td style={{padding:'6px 4px'}}>TC-103</td><td style={{padding:'6px 4px'}}><span className="badge badge-success" style={{fontSize:10}}>✓ Linked</span></td>
                  </tr>
                  <tr style={{background:'rgba(226,75,74,0.06)'}}>
                    <td style={{padding:'6px 4px'}}>R-004</td><td style={{padding:'6px 4px'}}>Performance SLAs</td><td style={{padding:'6px 4px',color:'#A32D2D'}}>Missing</td><td style={{padding:'6px 4px',color:'#A32D2D'}}>Missing</td><td style={{padding:'6px 4px'}}><span className="badge badge-danger" style={{fontSize:10}}>✗ Critical</span></td>
                  </tr>
                </tbody>
              </table>
              <div style={{marginTop:12,padding:8,background:'rgba(55,138,221,0.08)',borderRadius:'var(--border-radius-md)',borderLeft:'3px solid #378ADD',fontSize:11,color:'var(--color-text-secondary)'}}>
                <strong style={{color:'var(--color-text-info)'}}>AI suggestion:</strong> Add design document references for R-002 and R-004. CMMI RD 3.2 requires bi-directional traceability between requirements, design, and test artifacts.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Correlation Map ──────────────────────────────────────────────────────────

function CorrelationMap({ switchTab, addChatMessage }) {
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
            <input type="text" placeholder="Search requirement..." style={{width:200,fontSize:12}}/>
            <button className="btn btn-primary" style={{fontSize:12}} onClick={() => { switchTab('chatbot'); addChatMessage('Show me the full traceability chain for R-002 across all artifacts and identify any missing links') }}>Trace with AI ↗</button>
          </div>
        </div>
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
              {CORR_DATA.map(r => (
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
  const msgRef = useRef(null)

  useEffect(() => {
    if (pendingMessage) {
      setInput(pendingMessage)
      setPendingMessage(null)
    }
  }, [pendingMessage])

  useEffect(() => {
    if (msgRef.current) msgRef.current.scrollTop = msgRef.current.scrollHeight
  }, [messages])

  const suggestedQueries = [
    'How do I close AFR-001 (QPPOs)?','What is a Process Performance Baseline?',
    'How to achieve MPM Level 5 practices?',
    'Prioritize my open AFRs',
  ]

  const sendChat = () => {
    const msg = input.trim()
    if (!msg) return
    setMessages(prev => [...prev, {role:'user',text:msg}])
    setInput('')
    setTimeout(() => {
      setMessages(prev => [...prev, {role:'ai',text:`Thanks for your question about "${msg}". In a production version, this would connect to your AI backend with full CMMI V3.0 context. Current audit context: score 78/100, 11 open AFRs, critical gaps in MPM and OPM.`}])
    }, 1200)
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
              <span key={q} className="chip" onClick={() => setInput(q)}>
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
                  {m.text}
                </div>
              ))}
            </div>
            <div className="divider" style={{margin:'8px 0'}}/>
            <div style={{display:'flex',gap:8}}>
              <input type="text" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&sendChat()} placeholder="Ask about CMMI compliance, gaps, or artifact guidance..." style={{flex:1}}/>
              <button className="btn btn-primary" onClick={sendChat} style={{flexShrink:0}}><IconSend size={14}/></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── AFR Report ───────────────────────────────────────────────────────────────

function AFRReport({ switchTab, addChatMessage }) {
  const [filter, setFilter] = useState('all')
  const filtered = filter==='all' ? AFR_DATA : AFR_DATA.filter(a => a.severity===filter)
  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1.25rem'}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:500}}>AFR report</h2>
          <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>Appraisal Findings Report — CMMI Level 5 audit</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn" onClick={() => { switchTab('chatbot'); addChatMessage('Generate a complete CMMI Level 5 AFR report with all findings, gaps, scores, and remediation plan') }}><IconFileExport size={14}/> Export AFR ↗</button>
          <button className="btn btn-primary" onClick={() => { switchTab('chatbot'); addChatMessage('Create executive summary of our CMMI Level 5 audit findings and prioritized action plan') }}>Executive summary ↗</button>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:'1rem'}}>
        <div className="metric-card"><div className="metric-label">Audit score</div><div className="metric-value" style={{color:'#185FA5'}}>78/100</div><div className="metric-sub">Level 4.2 equivalent</div></div>
        <div className="metric-card"><div className="metric-label">Total AFRs</div><div className="metric-value">11</div><div className="metric-sub">Findings requiring action</div></div>
        <div className="metric-card"><div className="metric-label">Critical</div><div className="metric-value" style={{color:'#A32D2D'}}>3</div><div className="metric-sub">Block Level 5 achievement</div></div>
        <div className="metric-card"><div className="metric-label">Target closure</div><div className="metric-value">45d</div><div className="metric-sub">Recommended timeline</div></div>
      </div>
      <div className="card">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1rem'}}>
          <div className="section-title" style={{margin:0}}>All findings</div>
          <div style={{display:'flex',gap:6}}>
            {[['critical','Critical (3)','badge-danger'],['major','Major (5)','badge-warning'],['minor','Minor (3)','badge-info'],['all','All','badge-gray']].map(([f,l,cls]) => (
              <span key={f} className={`badge ${cls}`} style={{cursor:'pointer',outline:filter===f?'2px solid #378ADD':undefined}} onClick={() => setFilter(f)}>{l}</span>
            ))}
          </div>
        </div>
        {filtered.map(a => (
          <div key={a.id} className={`afr-item ${afrClass(a.severity)}`} style={{marginBottom:10}}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:6}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{a.id}</span>
                <span className={`badge ${severityBadge(a.severity)}`} style={{fontSize:10}}>{a.severity}</span>
                <span className="badge badge-gray" style={{fontSize:10}}>{a.pa}</span>
              </div>
              <button className="btn" style={{fontSize:11,padding:'4px 10px'}} onClick={() => { switchTab('chatbot'); addChatMessage(`Help me remediate ${a.id}: ${a.title}. Provide a step by step action plan.`) }}>Remediate ↗</button>
            </div>
            <div style={{fontSize:13,fontWeight:500,color:'var(--color-text-primary)',marginBottom:4}}>{a.title}</div>
            <div style={{fontSize:12,color:'var(--color-text-secondary)',marginBottom:6}}>{a.desc}</div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}><strong>Artifact(s):</strong> {a.artifact}</div>
            <div style={{marginTop:6,padding:'6px 10px',background:'rgba(55,138,221,0.06)',borderRadius:'var(--border-radius-md)',fontSize:11,color:'var(--color-text-secondary)'}}>
              <strong style={{color:'var(--color-text-info)'}}>Recommendation:</strong> {a.recommendation}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── App Shell ────────────────────────────────────────────────────────────────

const TABS = [
  {id:'dashboard',label:'Dashboard',Icon:IconLayoutDashboard},
  {id:'repository',label:'Repository scan',Icon:IconFolderOpen},
  {id:'gaps',label:'Gap analysis',Icon:IconClipboardCheck},
  {id:'artifacts',label:'Artifact updater',Icon:IconFileDescription},
  {id:'correlation',label:'Correlation map',Icon:IconArrowsTransferUp},
  {id:'chatbot',label:'AI guide',Icon:IconMessageChatbot},
  {id:'afr',label:'AFR report',Icon:IconReportAnalytics},
]

const INITIAL_MESSAGES = [{
  role:'ai',
  text:"Hello! I'm your CMMI Level 5 compliance assistant. I have full knowledge of the CMMI V3.0 model, all 24 practice areas, and your organization's current audit findings.\n\nI can help you close the 11 open AFRs, guide you on artifact creation, explain specific CMMI controls, and provide step-by-step remediation plans. Where would you like to start?"
}]

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [chatMessages, setChatMessages] = useState(INITIAL_MESSAGES)
  const [pendingMessage, setPendingMessage] = useState(null)

  const switchTab = (tab) => setActiveTab(tab)

  const addChatMessage = (msg) => {
    setActiveTab('chatbot')
    setPendingMessage(msg)
  }

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
          <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>TechCorp Inc. · 2025</div>
        </div>
      </div>

      <div className="main">
        {activeTab==='dashboard'   && <Dashboard switchTab={switchTab} addChatMessage={addChatMessage}/>}
        {activeTab==='repository'  && <Repository switchTab={switchTab} addChatMessage={addChatMessage}/>}
        {activeTab==='gaps'        && <GapAnalysis switchTab={switchTab} addChatMessage={addChatMessage}/>}
        {activeTab==='artifacts'   && <ArtifactUpdater switchTab={switchTab} addChatMessage={addChatMessage}/>}
        {activeTab==='correlation' && <CorrelationMap switchTab={switchTab} addChatMessage={addChatMessage}/>}
        {activeTab==='chatbot'     && <Chatbot messages={chatMessages} setMessages={setChatMessages} pendingMessage={pendingMessage} setPendingMessage={setPendingMessage}/>}
        {activeTab==='afr'         && <AFRReport switchTab={switchTab} addChatMessage={addChatMessage}/>}
      </div>
    </div>
  )
}
