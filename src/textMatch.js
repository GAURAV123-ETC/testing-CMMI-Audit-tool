// ─── Shared Semantic Text Matching Utilities ───────────────────────────────
//
// Header/filename/value matching helpers shared across the row-level
// validation engines (irpEngine.js and friends). Matching is meaning-based
// rather than exact-text: a candidate counts as an Exact Match when it
// equals the canonical name (ignoring case/spacing/punctuation), an
// Equivalent Match when it matches a known synonym or is close enough
// (substring, singular/plural, minor spelling variance), or Missing
// otherwise.
//
// NOTE: riskSlaEngine.js keeps its own private copy of these functions
// (written before this module existed) to avoid any risk to that
// already-working engine — this shared version is for new engines only.

export function normalizeText(h) {
  if (!h) return ''
  return String(h)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-zA-Z0-9&/ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[m][n]
}

// Strip a trailing plural 's' (but not 'ss') so "Learnings" ~ "Learning".
export function singularize(s) {
  return s.length > 3 && s.endsWith('s') && !s.endsWith('ss') ? s.slice(0, -1) : s
}

// True if two normalized strings mean the same thing: identical,
// singular/plural variants, one contains the other, or within a small edit
// distance (tolerates minor spelling mistakes without changing meaning).
export function textsAreEquivalent(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (singularize(a) === singularize(b)) return true
  if (a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a))) return true
  const maxLen = Math.max(a.length, b.length)
  if (maxLen >= 4) {
    const threshold = maxLen <= 6 ? 1 : 2
    if (levenshtein(a, b) <= threshold) return true
  }
  return false
}

// Matches a single field (canonical name + synonyms) against a list of raw
// header strings. Returns { columnIndex, matchedHeader, matchType }.
export function matchFieldToHeaders(rawHeaders, canonicalName, synonyms = []) {
  const normalizedHeaders = rawHeaders.map(normalizeText)
  const canonical = normalizeText(canonicalName)

  for (let i = 0; i < normalizedHeaders.length; i++) {
    const h = normalizedHeaders[i]
    if (!h) continue
    if (h === canonical || singularize(h) === singularize(canonical)) {
      return { columnIndex: i, matchedHeader: rawHeaders[i], matchType: 'Exact Match' }
    }
  }

  const candidates = [canonical, ...synonyms.map(normalizeText)]
  for (let i = 0; i < normalizedHeaders.length; i++) {
    const h = normalizedHeaders[i]
    if (!h) continue
    if (candidates.some(c => textsAreEquivalent(h, c))) {
      return { columnIndex: i, matchedHeader: rawHeaders[i], matchType: 'Equivalent Match' }
    }
  }

  return { columnIndex: -1, matchedHeader: null, matchType: 'Missing Header' }
}

// Maps MANY fields against a header row at once, each header claimed by at
// most one field. Needed whenever field synonym lists can overlap (e.g. an
// "Action Item Status" synonym like "Improvement Action Status" contains an
// unrelated "Improvement Action" header as a substring) — matching each
// field independently would let two fields claim the same header and starve
// the field that should have matched it. Resolved in three passes, most
// specific first, so exact synonym hits always win over loose fuzzy ones:
//   1. header exactly equals a field's canonical name
//   2. header exactly equals one of a field's synonyms
//   3. fuzzy/substring equivalence (matchFieldToHeaders' Equivalent Match)
// against whatever headers and fields remain unclaimed.
export function matchFieldsExclusive(rawHeaders, fields) {
  const normalizedHeaders = rawHeaders.map(normalizeText)
  const claimed = new Array(rawHeaders.length).fill(false)
  const result = {}

  const tryAssign = (field, isCandidateMatch, matchType) => {
    if (result[field.key]) return
    for (let i = 0; i < normalizedHeaders.length; i++) {
      if (claimed[i] || !normalizedHeaders[i]) continue
      if (isCandidateMatch(normalizedHeaders[i])) {
        claimed[i] = true
        result[field.key] = { columnIndex: i, matchedHeader: rawHeaders[i], matchType, label: field.label }
        return
      }
    }
  }

  // Pass 1 — exact canonical name.
  for (const field of fields) {
    const canonical = normalizeText(field.canonical)
    tryAssign(field, h => h === canonical || singularize(h) === singularize(canonical), 'Exact Match')
  }
  // Pass 2 — exact synonym.
  for (const field of fields) {
    const synonyms = (field.synonyms || []).map(normalizeText)
    tryAssign(field, h => synonyms.some(s => h === s || singularize(h) === singularize(s)), 'Equivalent Match')
  }
  // Pass 3 — fuzzy/substring equivalence against whatever remains.
  for (const field of fields) {
    const candidates = [normalizeText(field.canonical), ...(field.synonyms || []).map(normalizeText)]
    tryAssign(field, h => candidates.some(c => textsAreEquivalent(h, c)), 'Equivalent Match')
  }

  for (const field of fields) {
    if (!result[field.key]) result[field.key] = { columnIndex: -1, matchedHeader: null, matchType: 'Missing Header', label: field.label }
  }
  return result
}

// True if `name` semantically matches any of `keywords` (substring or
// fuzzy-equivalent match on normalized text) — used for locating files or
// sheets by name (e.g. "Lessons Learnt Register.xlsx" ~ "lesson learned").
export function nameMatchesKeywords(name, keywords) {
  const normalized = normalizeText(name)
  if (!normalized) return false
  return keywords.some(k => {
    const nk = normalizeText(k)
    return normalized.includes(nk) || textsAreEquivalent(normalized, nk)
  })
}
