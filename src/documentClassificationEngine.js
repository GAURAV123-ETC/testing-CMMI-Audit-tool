// ─── Document Classification Engine ────────────────────────────────────────
//
// Given a document's extracted text (from documentTextExtraction.js) and its
// original filename, scores it against every entry in documentTypeConfig.js
// (DOCUMENT_TYPE_CONFIG, generated from the reference checklist's Sheet5)
// and returns the best-matching document type plus full diagnostics.
//
// Matching is plain case-insensitive substring search (not the word-boundary
// regex used by evidenceScanEngine.js's matchKeywordsInText) because
// DOCUMENT_TYPE_CONFIG's keyword phrases are auto-generated from a
// comma-split spreadsheet column and can carry trailing punctuation (e.g.
// "4. Project Organization Structure:") that a \b boundary would never match
// even when the phrase is genuinely present in the text.
//
// Content vs. filename signal (Rule 1): content match score against
// DOCUMENT_TYPE_CONFIG is the primary and only signal that decides *whether*
// a document can be classified at all (score < 20 => Unknown, filename
// cannot override that). Filename is a weak secondary signal only, applied
// as a capped +10-point bonus on top of the content-selected type, and is
// never enough by itself to raise confidence to "High".
//
// Specific-shape overrides (Rule 2): a handful of document shapes — defect/
// issue trackers, RACI/RASCI matrices, requirements/RTM docs — have highly
// distinctive vocabulary that the generic Sheet5 scoring above tends to
// under-classify (e.g. a Requirements doc named "Test Cases_v2.xlsx" would
// otherwise score against "Test Case" instead). These are checked directly
// against the document's content (filename is irrelevant to them, in either
// direction) and, when triggered, take priority over the generic score.

import { DOCUMENT_TYPE_CONFIG } from './documentTypeConfig'

function matchKeywords(text, keywords) {
  const lower = text.toLowerCase()
  const matched = []
  const missed = []
  for (const kw of keywords) {
    const kwLower = (kw || '').toLowerCase().trim()
    if (kwLower && lower.includes(kwLower)) matched.push(kw)
    else missed.push(kw)
  }
  return { matched, missed }
}

function structuralMatches(structure, keywords) {
  const headers = (structure?.headers || []).join(' ').toLowerCase()
  if (!headers) return []
  return (keywords || []).filter(keyword => {
    const value = String(keyword || '').toLowerCase().trim()
    return value.length > 2 && headers.includes(value)
  })
}

// Document role is intentionally independent from document type. A blank or
// reference template may look exactly like a Risk Register structurally, but
// must not count as project implementation evidence.
export function classifyDocumentRole(documentText, structure = {}) {
  const lower = (documentText || '').toLowerCase()
  const populatedRows = Number(structure.populatedRows || 0)
  const templateSignal = /\b(template|sample|example|placeholder|to be completed|tbd)\b/.test(lower)
  if (structure.isSpreadsheet && populatedRows === 0) return 'BLANK_TEMPLATE'
  if (templateSignal && populatedRows < 2) return 'TEMPLATE'
  if (/\b(policy|process|procedure|guideline|standard)\b/.test(lower) && !/\b(project|release|sprint|risk id|requirement id)\b/.test(lower)) return 'PROCESS_REFERENCE'
  return 'PROJECT_IMPLEMENTATION_EVIDENCE'
}

// RULE 2 — specific misclassification fixes. Content-only signal: filename
// must never trigger or suppress these, per spec ("Even if filename says
// something else" / "Even if filename contains misleading words").
//
// practiceAreas below use RULE_CHECKLIST's actual codes, not the originally
// spec'd ones — MC, IPM, VER and VAL do not exist in RULE_CHECKLIST (the
// MASTER-sheet-derived rule set evidenceValidationEngine.js filters against),
// so using them verbatim would silently produce zero matched rules for every
// document these overrides fire on. Each was remapped to the closest real
// code, verified against RULE_CHECKLIST's own auditCheck text (see
// documentTypeConfig.js's header comment for the full mapping table used
// consistently across both files):
//   MC  -> MPM (Monitor & Control has no RULE_CHECKLIST entry; MPM's rules
//               are the same planned-vs-actual/performance-tracking content)
//   IPM -> DAR (no Integrated Project Management code exists; DAR-1a asks
//               "Was the decision approved by the role defined in the
//               decision authority matrix?" — the closest real equivalent
//               to a RACI/responsibility matrix in this rule set)
//   VER, VAL -> VV (RULE_CHECKLIST never splits these — always the combined
//               "VV" code)
const OVERRIDE_RULES = [
  {
    name: 'Issue/Defect tracking override',
    documentType: 'Issue Log / Defect Tracker',
    practiceAreas: ['CAR', 'MPM'],
    minMatches: 3,
    keywords: ['defect', 'bug', 'issue id', 'severity', 'priority', 'resolution', 'retest', 'root cause', 'defect log', 'bug tracker'],
    expectedEvidence: 'Defect/bug log with severity, priority, root cause and resolution/retest status',
  },
  {
    name: 'RACI/RASCI matrix override',
    documentType: 'RACI / Responsibility Matrix',
    practiceAreas: ['DAR', 'PLAN'],
    minMatches: 2,
    keywords: ['raci', 'rasci', 'responsible', 'accountable', 'consulted', 'informed', 'role matrix'],
    expectedEvidence: 'RACI/RASCI matrix identifying Responsible, Accountable, Consulted and Informed roles',
  },
  {
    name: 'Requirements/Traceability override',
    documentType: 'Requirements / RTM',
    practiceAreas: ['RDM', 'VV'],
    minMatches: 3,
    keywords: ['requirement id', 'req-', 'traceability', 'srs', 'brtm', 'rtm', 'functional requirement', 'non-functional requirement', 'use case'],
    expectedEvidence: 'Requirements Traceability Matrix linking requirements to design/test cases',
  },
]

function checkOverrides(documentText) {
  const lower = documentText.toLowerCase()
  for (const rule of OVERRIDE_RULES) {
    const matched = rule.keywords.filter(kw => lower.includes(kw.toLowerCase()))
    if (matched.length >= rule.minMatches) {
      return { rule, matched, missed: rule.keywords.filter(kw => !matched.includes(kw)) }
    }
  }
  return null
}

// Confidence for an override match is never "Low" (triggering the override
// at all already means a real content threshold was met) and only "High"
// when the match is unusually strong — comfortably past the minimum and
// covering at least half the indicator list.
function overrideConfidence(matched, rule) {
  const strong = matched.length >= rule.minMatches + 2 && matched.length / rule.keywords.length >= 0.5
  return strong ? 'High' : 'Medium'
}

// RULE 1 — filename bonus. Capped at +10, awarded in +5 increments per
// distinct keyword (from the content-selected type's own keyword list, not
// any other type's) that also appears in the filename. Short/generic
// keyword fragments (<=3 chars) are skipped so e.g. a keyword "of" doesn't
// match nearly every filename.
function filenameBonus(fileName, keywords) {
  const nameLower = (fileName || '').toLowerCase()
  const words = []
  let bonus = 0
  for (const kw of keywords || []) {
    if (bonus >= 10) break
    const kwLower = (kw || '').toLowerCase().trim()
    if (kwLower.length > 3 && nameLower.includes(kwLower)) {
      bonus += 5
      words.push(kw)
    }
  }
  return { bonus: Math.min(bonus, 10), words }
}

// RULE 3 — confidence must be content-driven. "High" requires both a strong
// content score AND at least 3 practice-area-specific keywords actually
// found in the content — filename bonus is never sufficient on its own.
// "Medium" covers a decent content score on its own, or a low content score
// that only cleared the classification threshold because of the filename
// bonus (i.e. the bonus was needed).
function confidenceForContent(contentScore, matchedContentCount, bonus, finalScore) {
  if (contentScore >= 70 && matchedContentCount >= 3) return 'High'
  if (contentScore >= 40) return 'Medium'
  if (bonus > 0 && finalScore >= 40) return 'Medium'
  return 'Low'
}

// RULE 4 — human-readable classification reasoning, surfaced in the UI
// (Classification tab) and the Excel export (Sheet 1).
function buildClassificationReason({ documentType, matched, bonus, bonusWords, overrideName, isUnknown }) {
  if (isUnknown) {
    return `Classified as Unknown / Review Required — content match score is below the confidence threshold${matched.length ? ` (partial matches: ${matched.slice(0, 6).join(', ')})` : ' (no matching keywords found in content)'}.`
  }
  let reason = overrideName
    ? `Classified as ${documentType} because content contains ${matched.length} indicator keyword(s): ${matched.slice(0, 8).join(', ')}.`
    : `Classified as ${documentType} because content contains: ${matched.length ? matched.slice(0, 8).join(', ') : 'no strong keyword matches'}.`
  if (bonus > 0) {
    reason += ` Filename bonus: +${bonus} (filename contains ${bonusWords.map(w => `'${w}'`).join(', ')}).`
  }
  return reason
}

// Returns { originalFileName, detectedType, confidence, confidenceScore,
// classificationReason, matchedKeywords, missedKeywords, practiceAreas,
// expectedEvidence, allScores }. Never throws.
export function classifyDocument(documentText, originalFileName, ruleCatalog, documentStructure = {}) {
  if (!documentText || !documentText.trim()) {
    return {
      originalFileName,
      detectedType: 'Unknown / Review Required',
      confidence: 'Low',
      confidenceScore: 0,
      classificationReason: 'Classified as Unknown / Review Required — no extractable text content found in this document.',
      matchedKeywords: [],
      missedKeywords: [],
      practiceAreas: [],
      expectedEvidence: '',
      allScores: [],
      documentRole: classifyDocumentRole(documentText, documentStructure),
      reasonCodes: ['NO_EXTRACTABLE_TEXT'],
    }
  }

  const catalogTypes = ruleCatalog?.documentTypes?.length ? ruleCatalog.documentTypes : DOCUMENT_TYPE_CONFIG
  const scored = catalogTypes.map(entry => {
    const { matched, missed } = matchKeywords(documentText, entry.keywords)
    const structural = structuralMatches(documentStructure, entry.keywords)
    const total = entry.keywords.length
    // Spreadsheet headers are a separate, higher-confidence signal. Their
    // weight stays deterministic and is kept with the imported catalogue,
    // rather than allowing file names to dictate classification.
    const keywordScore = total > 0 ? matched.length / total : 0
    const structureScore = total > 0 ? structural.length / total : 0
    const score = Math.round((keywordScore * 0.75 + structureScore * 0.25) * 100)
    return { entry, matched, missed, structural, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const allScores = scored.slice(0, 5).map(s => ({ documentType: s.entry.documentType, score: s.score }))

  // RULE 2 — specific-shape overrides take priority over the generic score.
  const override = checkOverrides(documentText)
  if (override) {
    const { rule, matched, missed } = override
    const scorePct = Math.round((matched.length / rule.keywords.length) * 100)
    return {
      originalFileName,
      detectedType: rule.documentType,
      confidence: overrideConfidence(matched, rule),
      confidenceScore: scorePct,
      classificationReason: buildClassificationReason({ documentType: rule.documentType, matched, bonus: 0, bonusWords: [], overrideName: rule.name, isUnknown: false }),
      matchedKeywords: matched,
      missedKeywords: missed,
      practiceAreas: rule.practiceAreas,
      expectedEvidence: rule.expectedEvidence,
      allScores,
      documentRole: classifyDocumentRole(documentText, documentStructure),
      reasonCodes: matched.map(keyword => `MATCHED_KEYWORD:${normReasonCode(keyword)}`),
    }
  }

  const top = scored[0]
  const contentScore = top ? top.score : 0
  // RULE 1 — never classify (even weakly) on filename alone when content
  // score is below 20; filename bonus is not even computed in that case.
  const isUnknown = contentScore < 20

  const { bonus, words: bonusWords } = (!isUnknown && top) ? filenameBonus(originalFileName, top.entry.keywords) : { bonus: 0, words: [] }
  const finalScore = isUnknown ? contentScore : Math.min(100, contentScore + bonus)

  return {
    originalFileName,
    detectedType: isUnknown ? 'Unknown / Review Required' : top.entry.documentType,
    confidence: isUnknown ? 'Low' : confidenceForContent(contentScore, top.matched.length, bonus, finalScore),
    confidenceScore: finalScore,
    classificationReason: buildClassificationReason({
      documentType: isUnknown ? 'Unknown / Review Required' : top.entry.documentType,
      matched: top ? top.matched : [],
      bonus: isUnknown ? 0 : bonus,
      bonusWords: isUnknown ? [] : bonusWords,
      overrideName: null,
      isUnknown,
    }),
    matchedKeywords: top ? top.matched : [],
    missedKeywords: top ? top.missed : [],
    practiceAreas: top ? top.entry.practiceAreas : [],
    expectedEvidence: top ? top.entry.expectedEvidence : '',
    allScores,
    documentRole: classifyDocumentRole(documentText, documentStructure),
    reasonCodes: [
      ...(top?.matched || []).map(keyword => `MATCHED_KEYWORD:${normReasonCode(keyword)}`),
      ...(top?.structural || []).map(keyword => `MATCHED_SCHEMA:${normReasonCode(keyword)}`),
    ],
  }
}

function normReasonCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}
