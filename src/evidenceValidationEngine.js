// ─── Evidence Validation Engine ─────────────────────────────────────────────
//
// Given a document's extracted text and the classificationResult produced by
// documentClassificationEngine.js's classifyDocument(), checks that text
// against every RULE_CHECKLIST rule (src/ruleChecklist.js, generated from
// the MASTER sheet) belonging to the classified document's Practice Areas.
//
// L1-Gate rules ask "does the right artefact exist at all?" — answered
// entirely from the classification result (confidence / detectedType), not
// from re-scanning the text.
//
// L3-Check / L4-Probe rules ask a specific content question (e.g. "was this
// reviewed and approved?"). Evidence words for these come from, in order of
// priority (see pickCheckWords()):
//
//   1. DOMAIN_WORD_LISTS — a small curated indicator list for five common
//      check shapes (review/approval, traceability, testing, risk, defect),
//      matched by a keyword appearing in the rule's own auditCheck text.
//      Scored by presence (classifyByPresence): found none = MISSING, found
//      all = FOUND, found some = PARTIAL. A percentage threshold doesn't fit
//      these lists — they're short synonym sets for a single concept (e.g.
//      "approved"/"sign-off"/"authorised" all mean the same thing), so
//      finding just one of nine is genuinely partial evidence, not "11%
//      complete".
//   2. classificationResult.matchedKeywords — the real keywords the
//      document's own content matched during classification
//      (documentClassificationEngine.js). These are meaningful and
//      document-specific, unlike generic filler.
//   3. extractKeyEvidenceWords() — the original fallback: tokenizes the
//      auditCheck sentence and expands matches via SIGNAL_CLUSTERS below.
//      Used only when neither of the above applies (no domain match and no
//      matchedKeywords), so every rule still gets *some* evidence words.
// Options 2 and 3 keep the original 70/30 percentage threshold
// (classifyByThreshold).

import { RULE_CHECKLIST } from './ruleChecklist'

// Curated indicator lists for the five most common audit-check shapes.
// `test` runs against the rule's own auditCheck text (not the document) to
// decide whether this rule IS one of these shapes; `words` is then what
// gets searched for in the document text.
const DOMAIN_WORD_LISTS = [
  {
    test: t => t.includes('reviewed') || t.includes('approved') || t.includes('sign-off'),
    words: ['reviewed', 'approved', 'sign-off', 'signoff', 'approval', 'authorised', 'authorized', 'signed', 'endorsement'],
  },
  {
    test: t => t.includes('traceability') || t.includes('rtm') || t.includes('traced'),
    words: ['traceability', 'RTM', 'traced', 'traceable', 'linked', 'mapped', 'matrix'],
  },
  {
    test: t => t.includes('test'), // covers "testing" too
    words: ['tested', 'test case', 'test result', 'pass', 'fail', 'executed', 'UAT'],
  },
  {
    test: t => t.includes('risk'),
    words: ['risk', 'probability', 'impact', 'mitigation', 'contingency', 'owner', 'status'],
  },
  {
    test: t => t.includes('defect') || t.includes('bug'),
    words: ['defect', 'bug', 'severity', 'priority', 'resolution', 'retest', 'closure'],
  },
]

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'on',
  'for', 'and', 'or', 'by', 'with', 'from', 'at', 'as', 'that', 'this', 'these', 'those', 'it',
  'its', 'their', 'there', 'has', 'have', 'had', 'do', 'does', 'did', 'if', 'not', 'no', 'all',
  'any', 'each', 'per', 'which', 'who', 'whom', 'can', 'will', 'would', 'should', 'could', 'into',
  'than', 'then', 'so', 'such', 'also', 'both', 'other', 'more', 'most', 'some', 'only', 'own',
  'same', 'too', 'very', 'just', 'about', 'after', 'before', 'between', 'during', 'over', 'under',
  'again', 'once', 'here', 'when', 'where', 'why', 'how', 'they', 'them', 'what',
])

// Curated audit-vocabulary clusters: { root, expand }. A tokenized word
// matches a cluster when it *starts with* root (crude stemming — covers
// plurals/tenses like "reviewed"/"reviews"/"reviewing" all matching
// root "review"). Matched clusters contribute their full `expand` list as
// key evidence words, in first-seen order. Sorted longest-root-first at use
// time so e.g. "baseline" doesn't get shadowed by a shorter unrelated root.
const SIGNAL_CLUSTERS = [
  { root: 'approv', expand: ['approved', 'approval', 'sign-off', 'authorised'] },
  { root: 'authoris', expand: ['authorised', 'approved', 'sign-off'] },
  { root: 'authoriz', expand: ['authorized', 'approved', 'sign-off'] },
  { root: 'sign', expand: ['sign-off', 'approved', 'authorised'] },
  { root: 'review', expand: ['reviewed', 'review'] },
  { root: 'stakeholder', expand: ['stakeholder', 'sponsor', 'owner'] },
  { root: 'owner', expand: ['owner', 'responsible', 'accountable'] },
  { root: 'respons', expand: ['responsibility', 'accountable'] },
  { root: 'baseline', expand: ['baseline', 'baselined', 'version'] },
  { root: 'version', expand: ['version', 'baseline', 'revision'] },
  { root: 'trace', expand: ['traceability', 'traced', 'linked'] },
  { root: 'test', expand: ['tested', 'test', 'verified'] },
  { root: 'retest', expand: ['retested', 'regression'] },
  { root: 'regressi', expand: ['regression', 'retest'] },
  { root: 'defect', expand: ['defect', 'issue'] },
  { root: 'bug', expand: ['bug', 'defect'] },
  { root: 'risk', expand: ['risk', 'mitigation', 'impact'] },
  { root: 'mitigat', expand: ['mitigation', 'contingency'] },
  { root: 'contingen', expand: ['contingency', 'mitigation'] },
  { root: 'escalat', expand: ['escalation', 'escalated'] },
  { root: 'train', expand: ['training', 'trained'] },
  { root: 'requirement', expand: ['requirement', 'requirements'] },
  { root: 'criteri', expand: ['criteria', 'acceptance'] },
  { root: 'accept', expand: ['acceptance', 'criteria'] },
  { root: 'schedul', expand: ['schedule', 'milestone'] },
  { root: 'milestone', expand: ['milestone', 'schedule'] },
  { root: 'status', expand: ['status', 'closure'] },
  { root: 'evidence', expand: ['evidence', 'record'] },
  { root: 'record', expand: ['record', 'log'] },
  { root: 'clos', expand: ['closure', 'closed'] },
  { root: 'measur', expand: ['measurement', 'metric'] },
  { root: 'metric', expand: ['metric', 'measurement'] },
  { root: 'audit', expand: ['audit', 'review'] },
  { root: 'scope', expand: ['scope', 'boundaries'] },
  { root: 'plan', expand: ['plan', 'planned'] },
  { root: 'identif', expand: ['identified', 'identification'] },
  { root: 'document', expand: ['documented', 'recorded'] },
  { root: 'complet', expand: ['completed', 'completion'] },
  { root: 'implement', expand: ['implemented', 'implementation'] },
  { root: 'monitor', expand: ['monitored', 'tracking'] },
  { root: 'report', expand: ['reported', 'reporting'] },
  { root: 'role', expand: ['role', 'responsibility'] },
  { root: 'chang', expand: ['change', 'impact'] },
  { root: 'configur', expand: ['configuration', 'baseline'] },
  { root: 'compliance', expand: ['compliance', 'conformance'] },
  { root: 'conform', expand: ['conformance', 'compliance'] },
  { root: 'governanc', expand: ['governance', 'oversight'] },
  { root: 'decision', expand: ['decision', 'rationale'] },
  { root: 'root cause', expand: ['root cause', 'analysis'] },
  { root: 'correct', expand: ['corrective', 'action'] },
  { root: 'prevent', expand: ['preventive', 'action'] },
  { root: 'capacity', expand: ['capacity', 'threshold'] },
  { root: 'availab', expand: ['availability', 'uptime'] },
  { root: 'perform', expand: ['performance', 'metric'] },
  { root: 'qualit', expand: ['quality', 'compliance'] },
  { root: 'sampl', expand: ['sample', 'evidence'] },
  { root: 'nonconform', expand: ['non-conformance', 'gap'] },
  { root: 'gap', expand: ['gap', 'finding'] },
  { root: 'secur', expand: ['security', 'access'] },
  { root: 'vulnerab', expand: ['vulnerability', 'threat'] },
  { root: 'access', expand: ['access', 'control'] },
  { root: 'backup', expand: ['backup', 'recovery'] },
  { root: 'recover', expand: ['recovery', 'backup'] },
  { root: 'incident', expand: ['incident', 'resolution'] },
  { root: 'threat', expand: ['threat', 'vulnerability'] },
].sort((a, b) => b.root.length - a.root.length)

// Used only to pad the key-evidence-word list up to a minimum of 4 when a
// short/generic auditCheck sentence doesn't yield enough signal on its own.
const FALLBACK_WORDS = ['evidence', 'documented', 'reviewed', 'approved', 'record', 'status']

function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z][a-z-]*/g) || []
}

// Returns 4-6 key evidence words for an L3-Check / L4-Probe auditCheck
// sentence. See module header comment for the approach and its limits.
export function extractKeyEvidenceWords(auditCheckText) {
  const tokens = tokenize(auditCheckText).filter(t => !STOPWORDS.has(t) && t.length > 2)
  const found = []
  const seen = new Set()

  for (const token of tokens) {
    const cluster = SIGNAL_CLUSTERS.find(c => token.startsWith(c.root))
    if (!cluster) continue
    for (const word of cluster.expand) {
      if (!seen.has(word)) {
        seen.add(word)
        found.push(word)
      }
    }
  }

  for (const word of FALLBACK_WORDS) {
    if (found.length >= 4) break
    if (!seen.has(word)) {
      seen.add(word)
      found.push(word)
    }
  }

  return found.slice(0, 6)
}

function matchEvidenceWords(text, words) {
  const lower = (text || '').toLowerCase()
  const found = []
  const missing = []
  for (const w of words) {
    if (lower.includes(w.toLowerCase())) found.push(w)
    else missing.push(w)
  }
  return { found, missing }
}

function classifyByThreshold(foundCount, total) {
  if (total === 0) return 'MISSING'
  const ratio = foundCount / total
  if (ratio >= 0.7) return 'FOUND'
  if (ratio >= 0.3) return 'PARTIAL'
  return 'MISSING'
}

// Presence-based classification for DOMAIN_WORD_LISTS: these are short
// synonym/indicator sets for one concept, not an exhaustive keyword
// catalogue, so "found some but not all" is PARTIAL regardless of exact
// ratio (see module header comment).
function classifyByPresence(foundCount, total) {
  if (total === 0 || foundCount === 0) return 'MISSING'
  if (foundCount === total) return 'FOUND'
  return 'PARTIAL'
}

// Picks the evidence word list + how to score it for one L3-Check/L4-Probe
// rule. See module header comment for the priority order.
function pickCheckWords(rule, classificationResult) {
  const auditCheckLower = (rule.auditCheck || '').toLowerCase()
  const domainList = DOMAIN_WORD_LISTS.find(d => d.test(auditCheckLower))
  if (domainList) return { words: domainList.words, classify: classifyByPresence }

  const matchedKeywords = classificationResult.matchedKeywords || []
  if (matchedKeywords.length > 0) return { words: matchedKeywords, classify: classifyByThreshold }

  return { words: extractKeyEvidenceWords(rule.auditCheck), classify: classifyByThreshold }
}

// RULE_CHECKLIST carries no pre-authored remediation text (only ruleId /
// auditCheck / gapText), so recommendation is templated from the rule's own
// outcome rather than sourced from the spreadsheet.
function buildRecommendation(status, missingEvidence, rule) {
  if (status === 'FOUND') return 'No action required — evidence sufficiently demonstrated.'
  if (rule.isGate) {
    return `Confirm the correct ${rule.practiceArea} artefact is uploaded — classification confidence is currently too low to treat this gate as satisfied.`
  }
  if (missingEvidence.length === 0) return 'Review this control manually — insufficient signal to auto-assess.'
  return `Provide clear evidence of: ${missingEvidence.join(', ')}.`
}

function validateGateRule(classificationResult) {
  if (classificationResult.detectedType === 'Unknown / Review Required') return 'MISSING'
  if (classificationResult.confidence === 'High' || classificationResult.confidence === 'Medium') return 'FOUND'
  return 'PARTIAL'
}

function validateCheckOrProbeRule(rule, documentText, classificationResult) {
  const { words, classify } = pickCheckWords(rule, classificationResult)
  const { found, missing } = matchEvidenceWords(documentText, words)
  return { status: classify(found.length, words.length), found, missing }
}

// Returns { originalFileName, detectedDocType, confidence, practiceAreas,
// totalRulesChecked, foundCount, partialCount, missingCount, unknownCount,
// results }. Never throws.
export function validateEvidence(documentText, classificationResult, ruleCatalog) {
  const practiceAreas = classificationResult.practiceAreas || []
  const catalogueRules = ruleCatalog?.rules?.length ? ruleCatalog.rules : RULE_CHECKLIST
  const rules = catalogueRules.filter(rule => practiceAreas.includes(rule.practiceArea))
  const excludedRole = ['TEMPLATE', 'BLANK_TEMPLATE', 'PROCESS_REFERENCE', 'DUPLICATE', 'SUPERSEDED_VERSION'].includes(classificationResult.documentRole)

  const results = rules.map(rule => {
    let status, foundEvidence, missingEvidence

    if (excludedRole) {
      status = 'NOT_APPLICABLE'
      foundEvidence = []
      missingEvidence = []
    } else if (rule.isGate) {
      status = validateGateRule(classificationResult)
      foundEvidence = []
      missingEvidence = []
    } else {
      const outcome = validateCheckOrProbeRule(rule, documentText, classificationResult)
      status = outcome.status
      foundEvidence = outcome.found
      missingEvidence = outcome.missing
    }

    return {
      ruleId: rule.ruleId,
      practiceArea: rule.practiceArea,
      level: rule.level,
      auditCheck: rule.auditCheck,
      status,
      foundEvidence,
      missingEvidence,
      gapText: rule.gapText,
      recommendation: buildRecommendation(status, missingEvidence, rule),
      originalFileName: classificationResult.originalFileName,
      detectedDocType: classificationResult.detectedType,
      confidence: classificationResult.confidence,
    }
  })

  return {
    originalFileName: classificationResult.originalFileName,
    detectedDocType: classificationResult.detectedType,
    confidence: classificationResult.confidence,
    documentRole: classificationResult.documentRole,
    practiceAreas,
    totalRulesChecked: results.length,
    foundCount: results.filter(r => r.status === 'FOUND').length,
    partialCount: results.filter(r => r.status === 'PARTIAL').length,
    missingCount: results.filter(r => r.status === 'MISSING').length,
    unknownCount: results.filter(r => r.status === 'UNKNOWN').length,
    results,
  }
}
