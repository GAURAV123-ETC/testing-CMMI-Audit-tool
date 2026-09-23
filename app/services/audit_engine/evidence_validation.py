"""Server-side port of the legacy document classification, evidence validation,
and gap-summary pipeline. Browser code is not used at runtime."""
import json
import re
from pathlib import Path
from app.services.document_processing.tabular import cell_text, select_tabular_table

SEED = Path(__file__).parents[2] / 'db' / 'seed_data'
RULES = json.loads((SEED / 'cmmi_rules.json').read_text(encoding='utf-8'))
DOCUMENT_TYPES = json.loads((SEED / 'document_types.json').read_text(encoding='utf-8'))
DOMAIN_WORD_LISTS = [
    (('reviewed','approved','sign-off'), ['reviewed','approved','sign-off','signoff','approval','authorised','authorized','signed','endorsement']),
    (('traceability','rtm','traced'), ['traceability','RTM','traced','traceable','linked','mapped','matrix']),
    (('test',), ['tested','test case','test result','pass','fail','executed','UAT']),
    (('risk',), ['risk','probability','impact','mitigation','contingency','owner','status']),
    (('defect','bug'), ['defect','bug','severity','priority','resolution','retest','closure']),
]
STOPWORDS = {'a','an','the','is','are','was','were','be','been','being','of','to','in','on','for','and','or','by','with','from','at','as','that','this','these','those','it','its','their','there','has','have','had','do','does','did','if','not','no','all','any','each','per','which','who','whom','can','will','would','should','could','into','than','then','so','such','also','both','other','more','most','some','only','own','same','too','very','just','about','after','before','between','during','over','under','again','once','here','when','where','why','how','they','them','what'}
CLUSTERS = {'approv':['approved','approval','sign-off','authorised'],'review':['reviewed','review'],'trace':['traceability','traced','linked'],'test':['tested','test','verified'],'defect':['defect','issue'],'risk':['risk','mitigation','impact'],'mitigat':['mitigation','contingency'],'train':['training','trained'],'requirement':['requirement','requirements'],'criteri':['criteria','acceptance'],'schedul':['schedule','milestone'],'status':['status','closure'],'record':['record','log'],'measur':['measurement','metric'],'audit':['audit','review'],'scope':['scope','boundaries'],'plan':['plan','planned'],'document':['documented','recorded'],'monitor':['monitored','tracking'],'report':['reported','reporting'],'role':['role','responsibility'],'chang':['change','impact'],'configur':['configuration','baseline'],'governanc':['governance','oversight'],'decision':['decision','rationale'],'correct':['corrective','action'],'prevent':['preventive','action'],'secur':['security','access'],'incident':['incident','resolution']}
_NAME_STOPWORDS = {'and', 'or', 'the', 'a', 'an', 'of', 'for', 'to', 'with', 'document', 'evidence'}
TABULAR_SUFFIXES = ('.xlsx', '.xls', '.csv')
MAX_VALIDATED_TABLE_ROWS = 10_000
_HEADER_SYNONYMS = {
    'id': {'identifier', 'number', 'reference', 'code'},
    'number': {'id', 'identifier', 'reference', 'code'},
    'reference': {'id', 'identifier', 'number', 'code'},
    'requestor': {'requester', 'originator', 'initiator'},
    'requester': {'requestor', 'originator', 'initiator'},
    'author': {'originator', 'owner', 'prepared'},
    'title': {'description', 'subject', 'name'},
    'description': {'detail', 'details', 'title', 'subject'},
    'approver': {'approval', 'authority', 'approved'},
    'approval': {'approver', 'authority', 'approved'},
    'owner': {'responsible', 'assignee', 'originator'},
    'module': {'component', 'application'},
    'category': {'type', 'classification'},
    'type': {'category', 'classification'},
    'date': {'raised', 'created', 'planned', 'target', 'execution'},
    'status': {'state', 'closure'},
    'effort': {'hours', 'hour', 'days', 'day', 'cost'},
    'risk': {'impact', 'dependency', 'dependencies'},
    'requirement': {'requirementid', 'req'},
    'doc': {'document', 'fsd'},
    'document': {'doc', 'fsd'},
    'acceptance': {'criteria', 'criterion'},
    'condition': {'criteria', 'criterion'},
    'planned': {'plan'},
    'signoff': {'approval', 'approved'},
    # Governed abbreviations used by the supplied audit templates. These are
    # semantic aliases, not fuzzy substring matches.
    'cr': {'change'},
    'test': {'ut', 'unit'},
    'case': {'ut'},
    'due': {'target'},
    'target': {'due'},
    'defect': {'finding', 'issue', 'bug'},
}
# Filenames are secondary evidence only, but these are stable, governed
# abbreviations for the supplied 14 document types. They let an otherwise
# well-formed worksheet such as ``Effort_Tracking.xlsx`` be identified without
# relaxing the content/schema requirement.
_CATALOGUE_FILENAME_ALIASES = {
    'trackingofactualeffortsagainstplanned': ('effort tracking',),
}
_MANIFEST_FILENAME_TERMS = {'manifest', 'mapping'}
_COMBINED_DOCUMENT_RULE_SCOPES = {
    'change log / fsd': {'CR': 'CHANGE_LOG', 'FSD': 'FSD'},
}
_REQUIRED_HEADER_CONCEPTS = {
    'author', 'approval', 'approver', 'closure', 'dependency', 'effort',
    'implementation', 'owner', 'planned', 'reference', 'requestor',
    'requester', 'review', 'reviewer', 'risk', 'target',
}
_GENERIC_HEADER_TOKENS = {
    'change', 'date', 'document', 'field', 'id', 'name', 'number',
    'project', 'record', 'status', 'value',
}
_DETECTION_DESCRIPTORS = {
    'calculation', 'definition', 'description', 'field', 'formula', 'list',
    'logic', 'name', 'names', 'narrative', 'pattern', 'reference', 'references',
    'record', 'records', 'result', 'results', 'statement', 'statements', 'table',
    'text', 'value', 'values', 'unique', 'not', 'reuse', 'reused',
    'link', 'linked', 'parent',
}
# Some approved master controls describe a governed relationship in prose
# rather than listing the spreadsheet headers verbatim. These profiles retain
# strict, field-level matching while allowing equivalent source terminology
# and separate columns (for example Priority + Response Target).
HeaderTokenRequirement = set[str] | tuple[set[str], ...]

_CONTROL_HEADER_PROFILES: dict[str, list[tuple[str, HeaderTokenRequirement, bool]]] = {
    'FSD-01': [('Document ID', {'doc', 'id'}, False), ('Version', {'version'}, False)],
    'FSD-02': [('Change Request reference', {'cr', 'number'}, False)],
    'FSD-12': [('Acceptance criteria', {'acceptance', 'condition'}, False)],
    'EST-01': [('Estimate ID', {'estimate', 'id'}, False), ('Change reference', {'change', 'id'}, False)],
    'EST-09': [('Planned effort', {'planned', 'effort'}, False)],
    'EST-17': [('Approval', {'approval'}, False)],
    'EFF-01': [('Planned effort', {'planned', 'effort'}, False)],
    'EFF-02': [('Actual effort', {'actual', 'effort'}, False)],
    'EFF-04': [('Variance', {'variance'}, False)],
    # A change log can contain related sub-statuses. Only the lifecycle
    # status belongs to the CR-status control; Impact/Approval/Closure status
    # must not make a complete CR status column appear partial.
    'CR-18': [('Change lifecycle status', {'status'}, False)],
    # Impact Analysis and TSD use their own governed record identifiers.
    # Either is a valid technical-document ID, but a Change ID must still be
    # present to demonstrate the CR/FSD linkage; a generic Requirement ID is
    # deliberately not accepted as a substitute.
    'TSD-01': [
        ('Technical document ID', ({'impact', 'id'}, {'tsd', 'id'}, {'doc', 'id'}), False),
        ('Change reference', {'change', 'id'}, False),
    ],
    'TSD-06': [('Technical design', {'technical', 'design'}, False)],
    # These RCA controls are proven by explicit structured fields. More
    # subjective RCA controls intentionally stay review-required unless the
    # workbook has a governed field that can establish them.
    'RCA-02': [('RCA identifier', {'rca', 'id'}, False), ('Incident reference', {'incident', 'id'}, False)],
    'RCA-04': [('Problem statement', {'problem', 'statement'}, False)],
    'RCA-07': [('5 Why completion', {'5', 'why'}, False)],
    'SLA-01': [('Priority', {'priority'}, False), ('Response target', {'response', 'target'}, False)],
    'SLA-02': [('Priority', {'priority'}, False), ('Resolution target', {'resolution', 'target'}, False)],
    'SLA-03': [('Incident ID', {'incident', 'id'}, False), ('Actual response', {'actual', 'response'}, False)],
    'SLA-04': [('Incident ID', {'incident', 'id'}, False), ('Actual resolution', {'actual', 'resolution'}, False)],
    'SLA-05': [('Achievement status', {'achievement'}, False)],
}
_PROFILE_FORBIDDEN_HEADER_TOKENS = {
    'CR-18': {'approval', 'impact', 'closure'},
}
_AFFIRMATIVE_VALUE_PROFILE_RULES = {'RCA-07'}

def classify_document_role(text: str, structure: dict | None = None) -> str:
    lower = (text or '').lower(); structure = structure or {}
    populated_rows = int(structure.get('populated_rows') or 0)
    if structure.get('is_spreadsheet') and populated_rows == 0:
        return 'BLANK_TEMPLATE'
    is_template = re.search(r'\b(template|sample|example|placeholder|to be completed|tbd)\b', lower)
    implementation_markers = re.search(
        r'\b(project|requirement|srs|brd|risk|test|approved|baseline|release|'
        r'incident id|action id|cam id|rca id|change id)\b', lower
    )
    if is_template and populated_rows < 2 and not implementation_markers:
        return 'TEMPLATE'
    if re.search(r'\b(policy|process|procedure|guideline|standard)\b', lower) and not implementation_markers:
        return 'PROCESS_REFERENCE'
    return 'PROJECT_IMPLEMENTATION_EVIDENCE'


def _name_tokens(value: str) -> list[str]:
    """Return stable, meaningful terms from a stored document type or alias."""
    return [token for token in re.findall(r'[a-z0-9]{2,}', value.lower()) if token not in _NAME_STOPWORDS]


def _stem_token(value: str) -> str:
    """Normalise common plural forms without fuzzy substring matching."""
    if value == 'ids':
        return 'id'
    if value == 'statuses':
        return 'status'
    if value in {'status', 'process', 'business', 'analysis', 'progress', 'address', 'access'}:
        return value
    if len(value) > 4 and value.endswith('ies'):
        return value[:-3] + 'y'
    if len(value) > 4 and value.endswith('s') and not value.endswith('ss'):
        return value[:-1]
    return value


def _search_tokens(value: str) -> list[str]:
    return [_stem_token(token) for token in re.findall(r'[a-z0-9]+', (value or '').lower())]


def _indicator_present(indicator: str, search_tokens: list[str]) -> bool:
    """Match complete configured words/phrases, never arbitrary substrings."""
    wanted = _search_tokens(indicator)
    if not wanted or len(wanted) > len(search_tokens):
        return False
    if len(wanted) == 1:
        return wanted[0] in set(search_tokens)
    width = len(wanted)
    return any(search_tokens[index:index + width] == wanted
               for index in range(len(search_tokens) - width + 1))


def _matched_indicators(indicators: list[str], value: str) -> list[str]:
    tokens = _search_tokens(value)
    return [indicator for indicator in indicators if _indicator_present(indicator, tokens)]


def _unique_indicators(indicators: list[str]) -> list[str]:
    result, seen = [], set()
    for indicator in indicators:
        key = tuple(_search_tokens(indicator))
        if key and key not in seen:
            result.append(indicator)
            seen.add(key)
    return result


def _uploaded_basename(value: str) -> str:
    """Return only the uploaded leaf name, independent of archive/folder labels."""
    return (value or '').replace('\\', '/').rsplit('/', 1)[-1]


def _structured_search_text(structure: dict | None) -> str:
    structure = structure or {}
    values = [*(structure.get('sheet_names') or []), *(structure.get('headers') or [])]
    for row in structure.get('header_rows') or []:
        values.extend(row.get('values') or [])
    return '\n'.join(cell_text(value) for value in values)


def _leading_document_text(text: str, limit: int = 2000) -> str:
    """Return the opening document region where a title and purpose belong.

    Document-type names found in a design's later evidence-reference section
    must not override its title.  This is deliberately content, not filename,
    based: DOCX/PDF extraction retains the title near the start even when a
    user has renamed the uploaded file.
    """
    return (text or '')[:limit]


def _adjacent_name_hits(terms: list[str], content_tokens: list[str]) -> list[str]:
    """Return the longest adjacent run of catalogue-name terms in content."""
    wanted = [_stem_token(term) for term in terms]
    best: list[str] = []
    for start in range(len(wanted)):
        for end in range(start + 2, len(wanted) + 1):
            phrase = wanted[start:end]
            width = len(phrase)
            if any(content_tokens[index:index + width] == phrase
                   for index in range(len(content_tokens) - width + 1)):
                if width > len(best):
                    best = terms[start:end]
    return best


def _catalogue_names(entry: dict) -> list[str]:
    """Use only names explicitly configured in the active document catalogue."""
    configured = [entry.get('document_type', ''), *(entry.get('aliases') or [])]
    document_key = re.sub(r'[^a-z0-9]+', '', str(entry.get('document_type', '')).lower())
    configured.extend(_CATALOGUE_FILENAME_ALIASES.get(document_key, ()))
    # Composite catalogue labels commonly list governed alternatives such as
    # "BRD / SRS / Requirements Specification / RFP". Treat each segment as
    # a data-derived alias instead of requiring code-level acronym lists.
    segments = [part.strip() for name in configured for part in re.split(r'\s*/\s*', name) if part.strip()]
    return list(dict.fromkeys([*configured, *segments]))


def _filename_match(entry: dict, file_name: str, lower_text: str) -> tuple[int, int, list[str]]:
    """Match a catalogue name against both path and extracted title/content.

    A filename alone never changes the audit scope.  Content must confirm the
    catalogue name, while a confirmed multi-word name (for example, Impact
    Analysis) takes precedence over broad shared terms such as approval.
    """
    # ``file_name`` is normally a ZIP-relative path. Parent folder names such
    # as "Project-2" describe storage, not the evidence document, and must
    # never become classification signals.
    filename_tokens = set(_name_tokens(_uploaded_basename(file_name)))
    ordered_content_tokens = _search_tokens(lower_text)
    content_tokens = set(ordered_content_tokens)
    best_filename = best_content = 0
    confirmed_terms: list[str] = []
    for name in _catalogue_names(entry):
        terms = _name_tokens(name)
        if not terms:
            continue
        filename_hits = [term for term in terms if term in filename_tokens]
        content_hits = [term for term in terms if _stem_token(term) in content_tokens]
        adjacent_content_hits = _adjacent_name_hits(terms, ordered_content_tokens)
        best_filename = max(best_filename, round(100 * len(filename_hits) / len(terms)))
        best_content = max(best_content, round(100 * len(content_hits) / len(terms)))
        # A document title inside extracted content is equally valid evidence
        # when a user has renamed the upload.  A filename alone is never
        # enough, but two catalogue-name terms in the content are specific
        # enough to outrank broad shared keywords.
        content_coverage = len(content_hits) / len(terms)
        if len(adjacent_content_hits) >= 2 and content_coverage >= .6:
            confirmed_terms = adjacent_content_hits
    return best_filename, best_content, confirmed_terms


def classify_document(text: str, file_name: str, document_types: list[dict] | None = None,
                      structure: dict | None = None) -> dict:
    """Classify evidence from the active catalogue before evaluating CMMI rules."""
    text = text or ''
    lower = text.lower()
    structured_text = _structured_search_text(structure)
    leading_text = _leading_document_text(text)
    role = classify_document_role(text, structure)
    filename_terms = set(_name_tokens(_uploaded_basename(file_name)))
    # A manifest is an index of evidence, not evidence for every artefact it
    # lists. Never turn its keyword column into false WBS/CR/FSD findings.
    if _MANIFEST_FILENAME_TERMS & filename_terms:
        return {'original_file_name': file_name, 'detected_type': 'Manifest / Mapping Reference',
                'confidence': 'High', 'confidence_score': 100,
                'classification_reason': 'Filename identifies an evidence manifest/mapping reference, not an implementation artefact.',
                'matched_keywords': [], 'missed_keywords': [], 'practice_areas': [],
                'expected_evidence': '', 'document_role': 'PROCESS_REFERENCE',
                'afr_eligible': False, 'document_type_rule_id': None,
                'required_keywords': [], 'reason_codes': ['MANIFEST_REFERENCE'], 'candidates': []}
    if not text.strip():
        return {'original_file_name': file_name, 'detected_type': 'Unknown / Review Required',
                'confidence': 'Low', 'confidence_score': 0,
                'classification_reason': 'No extractable text content found.', 'matched_keywords': [],
                'missed_keywords': [], 'practice_areas': [], 'expected_evidence': '',
                'document_role': role, 'afr_eligible': False, 'document_type_rule_id': None,
                'required_keywords': [],
                'reason_codes': ['NO_EXTRACTABLE_TEXT'], 'candidates': []}

    scored = []
    for entry in (document_types or DOCUMENT_TYPES):
        indicators = _unique_indicators(entry['keywords'])
        matched = _matched_indicators(indicators, text)
        structured_matched = _matched_indicators(indicators, structured_text)
        missed = [word for word in indicators if word not in matched]
        content_score = round(100 * len(matched) / len(indicators)) if indicators else 0
        structured_score = round(100 * len(structured_matched) / len(indicators)) if indicators else 0
        filename_score, name_content_score, confirmed_terms = _filename_match(entry, file_name, lower)
        _, title_name_score, title_confirmed_terms = _filename_match(entry, '', leading_text)
        evidence_score = max(content_score, structured_score)
        supporting_filename = filename_score >= 50 and len(matched) >= 2 and evidence_score >= 30
        # A spreadsheet's populated columns are a stronger document identity
        # than incidental prose in its rows.  For example a Change Request
        # log can legitimately reference test cases, but a schema containing
        # seven Change Request fields must not be classified as a Unit Test
        # sheet just because the words "test case" occur in one column.
        strong_structured_schema = (
            structure and structure.get('is_spreadsheet')
            and structured_score >= 60 and len(structured_matched) >= 3
        )
        # A recognised title/purpose in the opening document content is more
        # specific than a later reference to another evidence artifact. This
        # prevents, for example, a Technical Solution Design from becoming a
        # Code Review Record merely because it records its review history.
        # An exact approved filename/title identity plus corroborating content
        # is more specific than a broader shared spreadsheet schema. This
        # prevents Impact Analysis and Test Cases files being claimed by the
        # combined CR/FSD or Unit Test catalogue entries.
        exact_filename_identity = filename_score == 100 and len(matched) >= 1
        ranking_score = (1400 + evidence_score if exact_filename_identity
                         else 1000 + structured_score if strong_structured_schema
                         else 400 + title_name_score if title_confirmed_terms
                         else 200 + filename_score + name_content_score if confirmed_terms
                         else 100 + evidence_score + filename_score if supporting_filename
                         else evidence_score)
        scored.append((ranking_score, evidence_score, content_score, structured_score,
                       filename_score, name_content_score, entry, matched, missed,
                       structured_matched, confirmed_terms, supporting_filename,
                       title_name_score, title_confirmed_terms))
    scored.sort(key=lambda item: (item[0], item[1], len(item[7]), item[4]), reverse=True)
    (_, evidence_score, content_score, structured_score, filename_score,
     name_content_score, entry, matched, missed, structured_matched,
     confirmed_terms, supporting_filename, title_name_score,
     title_confirmed_terms) = scored[0]
    candidates = [
        {'document_type': item[6]['document_type'], 'score': item[2],
         'structured_score': item[3], 'filename_score': item[4],
         'title_score': item[12],
         'matched_keywords': item[7], 'afr_eligible': bool(item[6].get('include_in_afr'))}
        for item in scored[:5]
    ]
    # A generic word such as status, date, project, or dashboard is not a
    # document schema. Require either a corroborated catalogue name or at
    # least two configured content indicators meeting the score threshold.
    # A governed, exact filename plus one matching structured indicator is
    # sufficient for sparse worksheets.  For example, an effort-tracking
    # sheet can label its numeric columns simply ``Plan`` and ``Actual`` but
    # still has the stable ``Variance`` column.  Filename-only matches remain
    # rejected.
    exact_filename_with_evidence = filename_score == 100 and len(matched) >= 1
    has_content_evidence = (bool(title_confirmed_terms) or bool(confirmed_terms)
                            or supporting_filename or exact_filename_with_evidence or (
        (len(matched) >= 3 and evidence_score >= 30)
        or (len(matched) >= 2 and evidence_score >= 40)
    ))
    if not has_content_evidence:
        return {'original_file_name': file_name, 'detected_type': 'Unknown / Review Required',
                'confidence': 'Low', 'confidence_score': evidence_score,
                'classification_reason': 'No stored document-type match was supported by extracted content.',
                'matched_keywords': matched, 'missed_keywords': missed, 'practice_areas': [],
                'expected_evidence': '', 'document_role': role, 'afr_eligible': False,
                'document_type_rule_id': None, 'required_keywords': [],
                'reason_codes': [], 'candidates': candidates}
    confidence = ('High' if title_confirmed_terms
                  else 'High' if confirmed_terms and (filename_score >= 50 or name_content_score >= 50)
                  else 'Medium' if supporting_filename
                  else 'High' if evidence_score >= 70 and len(matched) >= 3
                  else 'Medium' if evidence_score >= 40 and len(matched) >= 3 else 'Low')
    reason = (f'Catalogue name matched uploaded file and content (opening document content): {", ".join(title_confirmed_terms)}.'
              if title_confirmed_terms and filename_score
              else f'Catalogue name matched extracted content (opening document content): {", ".join(title_confirmed_terms)}.'
              if title_confirmed_terms
              else f'Catalogue name matched uploaded file and content: {", ".join(confirmed_terms)}.'
              if confirmed_terms and filename_score
              else f'Catalogue name matched extracted content: {", ".join(confirmed_terms)}.'
              if confirmed_terms
              else f'Uploaded filename supported by catalogue content indicators: {", ".join(matched[:8])}.'
              if supporting_filename
              else f'Catalogue content indicators: {", ".join(matched[:8]) or "none"}.')
    artifact_scope = None
    if re.sub(r'[^a-z0-9]+', '', entry['document_type'].lower()) == 'changelogfsd':
        header_text = structured_text.lower()
        if 'fsd id' in header_text or 'functional requirement' in header_text:
            artifact_scope = 'FSD'
        elif ('change date' in header_text or 'approval status' in header_text
              or {'change', 'log'} <= filename_terms):
            artifact_scope = 'CHANGE_LOG'
    return {'original_file_name': file_name, 'detected_type': entry['document_type'],
            'confidence': confidence, 'confidence_score': min(100, max(evidence_score, filename_score, name_content_score)),
            'classification_reason': reason, 'matched_keywords': matched, 'missed_keywords': missed,
            'matched_structured_keywords': structured_matched,
            'practice_areas': entry['practice_areas'], 'expected_evidence': entry.get('expected_evidence', ''),
            'document_role': role, 'afr_eligible': bool(entry.get('include_in_afr')),
            'document_type_rule_id': entry.get('document_type_rule_id'),
            'artifact_scope': artifact_scope,
            'required_keywords': _unique_indicators(entry.get('keywords') or []),
            'reason_codes': [f'MATCHED_KEYWORD:{re.sub("[^A-Z0-9]+", "_", word.upper()).strip("_")}' for word in matched],
            'candidates': candidates}

def _check_words(rule: dict, classification: dict) -> tuple[list[str], bool]:
    # SAP controls include an explicit, field-level detection instruction.
    # Prefer it over the prose audit question so each master-row control is
    # evaluated independently instead of sharing broad CMMI keyword clusters.
    detection = (rule.get('detection') or '').lower()
    if detection:
        words = list(dict.fromkeys(
            token for token in re.findall(r'[a-z][a-z-]*', detection)
            if token not in STOPWORDS and len(token) >= 3
        ))
        if words:
            return words[:6], False
    check=rule['audit_check'].lower()
    for indicators, words in DOMAIN_WORD_LISTS:
        if any(indicator in check for indicator in indicators): return words, True
    if classification['matched_keywords']: return classification['matched_keywords'], False
    words=[]
    for token in re.findall(r'[a-z][a-z-]*', check):
        if token in STOPWORDS or len(token)<3: continue
        for root, expanded in CLUSTERS.items():
            if token.startswith(root): words.extend(expanded)
    words=list(dict.fromkeys(words))
    return (words or ['evidence','documented','reviewed','approved'])[:6], False


def _required_evidence(rule: dict, classification: dict | None = None) -> list[str]:
    """Return the governed requirement independently of the scan outcome.

    A finding's Required Keys must describe what the control requires, never
    be reconstructed from whichever values happened to be found or missing.
    Field-level controls carry this explicitly in ``detection``; older
    narrative controls retain their individual evidence terms.
    """
    detection = str(rule.get('detection') or '').strip()
    if detection:
        return [detection]
    if classification is not None and not rule.get('is_gate'):
        words, _ = _check_words(rule, classification)
        if words:
            return words
    audit_check = str(rule.get('audit_check') or '').strip()
    return [audit_check] if audit_check else []


def _condition_applies(condition: str | None, lower_text: str) -> bool:
    """Apply explicit SAP applicability triggers conservatively.

    ``Where applicable`` is intentionally assessed: it is an auditor's
    judgement call and suppressing it merely because a document omits the
    trigger would hide the very gap being checked.  Specific ``When`` and
    ``Before/After`` triggers are assessed only when their event is evidenced.
    """
    value = (condition or 'Always').strip().lower()
    lower_text = (lower_text or '').lower()
    if value in {'', 'always', 'where applicable', 'where required by project governance'}:
        return True
    # These conditions express a concrete lifecycle state.  Require the
    # state itself, never a generic companion word such as "status", before
    # evaluating its dependent control.  Other conditions remain assessed so
    # an omitted trigger cannot become a loophole that suppresses a finding.
    if 'status = closed' in value or 'when closed' in value:
        return 'closed' in lower_text
    if 'fixed or beyond' in value:
        return any(word in lower_text for word in ('fixed', 'resolved', 'closed'))
    if 'resolved/closed' in value:
        return any(word in lower_text for word in ('resolved', 'closed'))
    if 'when breached' in value:
        return any(word in lower_text for word in ('breach', 'breached'))
    if 'when test fails' in value:
        return any(word in lower_text for word in ('fail', 'failed', 'failure'))
    if 'linked defect is fixed' in value:
        return 'defect' in lower_text and any(word in lower_text for word in ('fixed', 'resolved', 'closed'))
    if 'when resolved' in value:
        return any(word in lower_text for word in ('resolved', 'closed'))
    if 'when completed' in value:
        return any(word in lower_text for word in ('completed', 'complete', 'closed'))
    if 'when overdue' in value:
        return 'overdue' in lower_text
    if 'priority = p1/p2' in value:
        return any(word in lower_text for word in ('p1', 'p2'))
    return True


def _conditional_tabular_context(condition: str | None, context: dict | None) -> tuple[dict | None, bool]:
    """Restrict row-level controls to rows where their condition is true.

    A workbook can legitimately contain both passing and failing tests, or
    both met and breached SLAs. Checking a conditional field against every
    row creates false missing-key findings on rows where the field must be
    blank. The boolean return value indicates that a reliable condition
    column was found; an empty filtered table then means NOT_APPLICABLE.
    """
    if not context or not context.get('headers'):
        return context, False
    value = (condition or 'Always').strip().lower()
    match_terms: set[str] | None = None
    header_terms: set[str] = set()
    findings_mode = False
    if 'when test fails' in value:
        header_terms = {'status', 'result', 'outcome'}
        match_terms = {'fail', 'failed', 'failure'}
    elif 'linked defect is fixed' in value or 'fixed or beyond' in value or 'after fix is deployed' in value:
        header_terms = {'status', 'state', 'closure'}
        match_terms = {'fixed', 'resolved', 'closed'}
    elif 'resolved/closed' in value or 'when resolved' in value:
        header_terms = {'status', 'state', 'closure'}
        match_terms = {'resolved', 'closed'}
    elif 'status = closed' in value or 'when closed' in value or 'before closure' in value:
        header_terms = {'status', 'state', 'closure'}
        match_terms = {'closed'}
    elif 'when completed' in value:
        header_terms = {'status', 'state', 'completion'}
        match_terms = {'completed', 'complete', 'closed'}
    elif 'when overdue' in value:
        header_terms = {'status', 'state', 'overdue'}
        match_terms = {'overdue'}
    elif 'when breached' in value:
        header_terms = {'status', 'state', 'achievement', 'sla'}
        match_terms = {'breach', 'breached'}
    elif 'priority = p1/p2' in value:
        header_terms = {'priority'}
        match_terms = {'p1', 'p2'}
    elif 'when findings exist' in value:
        header_terms = {'finding'}
        findings_mode = True
    else:
        return context, False

    header_terms = {_stem_token(term) for term in header_terms}
    if match_terms:
        match_terms = {_stem_token(term) for term in match_terms}

    indices = [
        index for index, header in enumerate(context['headers'])
        if set(_search_tokens(header)) & header_terms
    ]
    if not indices:
        return context, False

    def row_matches(row: list) -> bool:
        for index in indices:
            raw = cell_text(row[index]).strip() if index < len(row) else ''
            if findings_mode:
                if raw and raw.casefold() not in {'0', '0.0', 'no', 'none', 'n/a', 'na', 'false'}:
                    return True
            elif set(_search_tokens(raw)) & (match_terms or set()):
                return True
        return False

    filtered = dict(context)
    filtered['rows'] = [row for row in context.get('rows', []) if row_matches(row)]
    filtered['row_count'] = len(filtered['rows'])
    return filtered, True


def _rule_applies_to_document(rule: dict, classification: dict) -> bool:
    document_type_rule_id = rule.get('document_type_rule_id')
    if document_type_rule_id is not None:
        if document_type_rule_id != classification.get('document_type_rule_id'):
            return False
        scope_by_prefix = _COMBINED_DOCUMENT_RULE_SCOPES.get(
            (classification.get('detected_type') or '').lower(), {}
        )
        expected_scope = scope_by_prefix.get((rule.get('rule_id') or '').split('-', 1)[0])
        # The governed 14-entry index combines Change Log and FSD, while the
        # master has distinct CR-* and FSD-* controls. Once a sheet's schema
        # identifies its subtype, never apply the other subtype's controls.
        # Older callers and narrowly scoped unit validations may not have a
        # sheet subtype yet.  In that case retain the catalogue match; the
        # scanner itself always supplies ``artifact_scope`` for the combined
        # Change Log/FSD entry before applying this guard.
        artifact_scope = classification.get('artifact_scope')
        return expected_scope is None or artifact_scope is None or expected_scope == artifact_scope
    return rule['practice_area'] in classification['practice_areas']


def build_tabular_context(path: str, classification: dict) -> dict | None:
    """Return a bounded, auditable table view for spreadsheet evidence.

    The classifier's configured document keys locate the real header row on
    any worksheet.  Values are retained only for this scan and a compact
    summary is persisted with the classification result.
    """
    if not path.lower().endswith(TABULAR_SUFFIXES):
        return None
    keys = list(classification.get('required_keywords') or [])
    if not keys:
        return None
    fields = [{'key': f'field_{index}', 'canonical': key} for index, key in enumerate(keys)]
    try:
        # Formula expressions are evidence of a configured calculation even
        # when a workbook was saved without Excel's cached result value.
        selected = select_tabular_table(path, fields, data_only=False)
    except Exception:
        return None
    if not selected.rows:
        return None
    headers = [cell_text(value).strip() for value in selected.rows[0]]
    rows = [list(row) for row in selected.rows[1:MAX_VALIDATED_TABLE_ROWS + 1]
            if any(cell_text(value).strip() for value in row)]
    return {
        'sheet_name': selected.sheet_name,
        'header_row_index': selected.header_row_index,
        'headers': headers,
        'rows': rows,
        'row_count': len(rows),
        'truncated': len(selected.rows) > MAX_VALIDATED_TABLE_ROWS + 1,
    }


def tabular_context_summary(context: dict | None) -> dict | None:
    if not context:
        return None
    return {
        'sheet_name': context['sheet_name'], 'header_row_index': context['header_row_index'],
        'headers': context['headers'], 'row_count': context['row_count'],
        'truncated': context['truncated'],
    }


def _header_score(header: str, rule: dict) -> int:
    header_tokens = set(_search_tokens(header))
    rule_tokens = set(_search_tokens(f"{rule.get('audit_check', '')} {rule.get('detection', '')}"))
    score = 0
    for token in rule_tokens:
        if token in header_tokens:
            score += 1 if token in _GENERIC_HEADER_TOKENS else 3
        elif any(alias in header_tokens for alias in _HEADER_SYNONYMS.get(token, set())):
            score += 2
    return score


def _detection_requirement_groups(rule: dict) -> list[tuple[str, HeaderTokenRequirement, bool]]:
    """Split a governed detection instruction into independently mappable fields."""
    profile = _CONTROL_HEADER_PROFILES.get(str(rule.get('rule_id') or '').upper())
    if profile is not None:
        return profile
    detection = str(rule.get('detection') or '').strip()
    if not detection:
        return []
    groups = []
    for part in re.split(r'\s*(?:\+|,|/|;|\band\b)\s*', detection, flags=re.I):
        tokens = {
            _stem_token(token) for token in _search_tokens(part)
            if token not in _DETECTION_DESCRIPTORS
        }
        requires_percent = '%' in part or 'percent' in tokens
        tokens.discard('percent')
        if tokens or requires_percent:
            groups.append((part.strip(), tokens, requires_percent))
    return groups


def _header_matches_detection_group(header: str, tokens: HeaderTokenRequirement,
                                    requires_percent: bool) -> tuple[bool, int]:
    """Match one governed header requirement, including safe alternatives."""
    header_tokens = set(_search_tokens(header))
    if not header_tokens:
        return False, 0
    alternatives = tokens if isinstance(tokens, tuple) else (tokens,)
    scores: list[int] = []
    for alternative in alternatives:
        matched = 0
        for token in alternative:
            aliases = _HEADER_SYNONYMS.get(token, set())
            if token in header_tokens or aliases & header_tokens:
                matched += 1
            else:
                break
        else:
            if requires_percent:
                normalized_header = str(header or '').casefold()
                if '%' not in normalized_header and 'percent' not in header_tokens:
                    continue
                matched += 1
            if matched:
                # Prefer exact, specific language over a generic alias.
                scores.append(sum(
                    1 if token in _GENERIC_HEADER_TOKENS else 3 for token in alternative
                ) + (3 if requires_percent else 0))
    return (True, max(scores)) if scores else (False, 0)


def _profile_allows_header(rule: dict, header: str) -> bool:
    """Reject look-alike headers that belong to a different governed field."""
    forbidden = _PROFILE_FORBIDDEN_HEADER_TOKENS.get(str(rule.get('rule_id') or '').upper(), set())
    return not (set(_search_tokens(header)) & forbidden)


def _is_affirmative_value(value: str) -> bool:
    return _stem_token(value.strip().casefold()) in {'yes', 'true', 'complete', 'completed', 'done'}


def _header_requires_uniqueness(header: str, rule: dict) -> bool:
    """Return whether this exact governed field carries the unique constraint."""
    detection = str(rule.get('detection') or '')
    if 'unique' in _search_tokens(detection):
        unique_parts = [part for part in re.split(r'\s*(?:\+|,|/|;|\band\b)\s*', detection, flags=re.I)
                        if 'unique' in _search_tokens(part)]
    else:
        audit_check = str(rule.get('audit_check') or '')
        match = re.search(
            r'\bunique\s+(.+?)(?=\s+(?:is|are|has|have|linked|assigned|recorded)\b|[,.;]|$)',
            audit_check, flags=re.I,
        )
        unique_parts = [match.group(1)] if match else []
    for part in unique_parts:
        tokens = {
            _stem_token(token) for token in _search_tokens(part)
            if token not in _DETECTION_DESCRIPTORS and token not in STOPWORDS
        }
        if tokens and _header_matches_detection_group(header, tokens, False)[0]:
            return True
    return False


def _header_satisfies_required_concepts(header: str, rule: dict) -> bool:
    """Reject a generic date/status column for a qualified field control.

    A header named ``Change Date`` cannot prove a rule about a closure,
    target, author, reviewer, or approval date. Such controls stay in the
    auditable review queue until a reliable column mapping is available.
    """
    header_tokens = set(_search_tokens(header))
    rule_tokens = set(_search_tokens(f"{rule.get('audit_check', '')} {rule.get('detection', '')}"))
    required = rule_tokens & _REQUIRED_HEADER_CONCEPTS
    for concept in required:
        aliases = _HEADER_SYNONYMS.get(concept, set())
        if concept not in header_tokens and not (aliases & header_tokens):
            return False
    return True


def _tabular_rule_assessment(rule: dict, context: dict | None) -> tuple[str, list[str], list[str]] | None:
    """Assess a field control from headers and cells, never prose alone.

    A ``None`` return means this rule cannot be mapped safely to a table
    field.  The caller records it as review-required instead of inventing a
    missing-evidence conclusion.
    """
    if not context or not context.get('headers'):
        return None
    headers = context['headers']
    detection_groups = _detection_requirement_groups(rule)
    unmapped_groups: list[str] = []
    if detection_groups:
        candidates_by_index: dict[int, str] = {}
        for label, tokens, requires_percent in detection_groups:
            scored = [
                (index, header, score)
                for index, header in enumerate(headers)
                if str(header or '').strip()
                if _profile_allows_header(rule, header)
                for matched, score in [_header_matches_detection_group(header, tokens, requires_percent)]
                if matched
            ]
            best_score = max((score for _, _, score in scored), default=0)
            if not best_score:
                unmapped_groups.append(label)
                continue
            for index, header, score in scored:
                if score == best_score:
                    candidates_by_index[index] = header
        candidates = sorted(candidates_by_index.items())
    else:
        scored = [(index, header, _header_score(header, rule))
                  for index, header in enumerate(headers) if str(header or '').strip()]
        best_score = max((score for _, _, score in scored), default=0)
        # Legacy controls without a governed detection instruction retain the
        # narrower token matcher, with generic words deliberately low weight.
        candidates = [(index, header) for index, header, score in scored
                      if score >= 2 and score == best_score
                      and _header_satisfies_required_concepts(header, rule)]
    if not candidates:
        return None

    # Header names that only share a generic token never qualify for governed
    # controls. For multi-field controls, each required field has its own
    # explicit mapping above rather than assuming all concepts share a cell.
    found, missing = [], []
    integrity_failure = False
    data_rows = context['rows']
    affirmative_values_required = str(rule.get('rule_id') or '').upper() in _AFFIRMATIVE_VALUE_PROFILE_RULES
    for index, header in candidates:
        values = [cell_text(row[index]).strip() if index < len(row) else '' for row in data_rows]
        populated = [value for value in values if value]
        blank_count = len(values) - len(populated)
        if not values:
            missing.append(f'{header}: no data rows')
            continue
        if affirmative_values_required:
            affirmative_count = sum(_is_affirmative_value(value) for value in populated)
            if affirmative_count:
                found.append(f'{header}: {affirmative_count} affirmative value(s)')
            else:
                missing.append(f'{header}: no affirmative value(s)')
                integrity_failure = True
        elif populated:
            found.append(f'{header}: {len(populated)} populated value(s)')
        if blank_count:
            missing.append(f'{header}: {blank_count} blank value(s)')
        if _header_requires_uniqueness(header, rule):
            duplicates = sorted({value for value in populated if populated.count(value) > 1})
            if duplicates:
                missing.append(f'{header}: duplicate value(s) {", ".join(duplicates[:5])}')
                integrity_failure = True
            elif populated:
                found.append(f'{header}: values are unique')
    if unmapped_groups:
        missing.extend(f'No reliable column mapping for: {label}.' for label in unmapped_groups)
        return 'REVIEW_REQUIRED', found, missing
    if not missing:
        return 'FOUND', found, []
    if found and not integrity_failure:
        return 'PARTIAL', found, missing
    # Retain populated values even when duplicates or blanks make the control
    # fail. They are still available evidence and must reach the AFR.
    return 'MISSING', found, missing

def validate_evidence(text: str, classification: dict, rules: list[dict] | None = None,
                      tabular_context: dict | None = None) -> dict:
    lower=(text or '').lower(); results=[]
    excluded = classification.get('document_role') in {'TEMPLATE','BLANK_TEMPLATE','PROCESS_REFERENCE','DUPLICATE','SUPERSEDED_VERSION'}
    for rule in (rule for rule in (rules or RULES) if _rule_applies_to_document(rule, classification)):
        not_applicable_reason = None
        applicable_context, row_condition_checked = _conditional_tabular_context(
            rule.get('condition'), tabular_context
        )
        if excluded:
            status='NOT_APPLICABLE'; found=[]; missing=[]
            not_applicable_reason = 'excluded_document_role'
        elif ((row_condition_checked and not applicable_context.get('rows'))
              or (not row_condition_checked and not _condition_applies(rule.get('condition'), lower))):
            status='NOT_APPLICABLE'; found=[]; missing=[]
            not_applicable_reason = 'condition_not_met'
        elif rule['is_gate']:
            status='FOUND' if classification['confidence'] in {'High','Medium'} else 'PARTIAL' if classification['detected_type'] != 'Unknown / Review Required' else 'MISSING'; found=[]; missing=[]
        else:
            table_result = _tabular_rule_assessment(rule, applicable_context) if rule.get('document_type_rule_id') else None
            if table_result:
                status, found, missing = table_result
            elif applicable_context and rule.get('document_type_rule_id'):
                status = 'REVIEW_REQUIRED'; found = []
                missing = ['No reliable column mapping for this narrative or multi-field control.']
            else:
                words,presence=_check_words(rule,classification)
                found=_matched_indicators(words, text); missing=[word for word in words if word not in found]
                ratio=len(found)/len(words) if words else 0
                status='FOUND' if ratio==1 else 'PARTIAL' if (len(found)>0 if presence else ratio>=.3) else 'MISSING'
        results.append({'rule_id':rule['rule_id'],'practice_area':rule['practice_area'],'level':rule['level'],'audit_check':rule['audit_check'],'status':status,'required_evidence':_required_evidence(rule, classification),'found_evidence':found,'missing_evidence':missing,'gap_text':rule['gap_text'],'condition':rule.get('condition'), 'detection':rule.get('detection'), 'not_applicable_reason':not_applicable_reason,
                        'recommendation':'No action required.' if status in {'FOUND', 'NOT_APPLICABLE'} else (rule.get('recommendation') or f"Provide clear evidence of: {', '.join(missing)}.")})
    return {'classification':classification,'results':results,'found_count':sum(r['status']=='FOUND' for r in results),'partial_count':sum(r['status']=='PARTIAL' for r in results),'missing_count':sum(r['status']=='MISSING' for r in results), 'review_count':sum(r['status']=='REVIEW_REQUIRED' for r in results)}

def generate_gap_report(validations: list[dict], catalog_rules: list[dict] | None = None) -> dict:
    """Evaluate each applicable rule once at project scope and enforce L1 gates.

    ``validations`` only contains rules mapped to documents.  Starting from the
    pinned catalogue ensures a missing artefact is still reported when no
    document (or only an excluded template/reference) maps to that rule.
    """
    rank={'NOT_APPLICABLE':-1,'MISSING':0,'REVIEW_REQUIRED':1,'PARTIAL':2,'FOUND':3}; aggregated={}
    for rule in catalog_rules or []:
        aggregated[rule['rule_id']] = {
            'rule_id': rule['rule_id'],
            'practice_area': rule['practice_area'],
            'level': rule['level'],
            'audit_check': rule['audit_check'],
            'status': 'MISSING',
            'required_evidence': _required_evidence(rule),
            'found_evidence': [],
            'missing_evidence': ['Required evidence was not found in the project scope.'],
            'gap_text': rule['gap_text'],
            'recommendation': rule.get('recommendation') or 'Upload project implementation evidence and rerun the scan.',
            'files': [],
            'evidence_file_ids': [],
            '_rank': rank['MISSING'],
            '_seeded': True,
            '_conditional_result': None,
            '_conditional_files': [],
            '_conditional_evidence_file_ids': [],
        }
    for validation in validations:
        classification=validation['classification']
        for result in validation['results']:
            current=aggregated.get(result['rule_id']); score=rank.get(result['status'],-1)
            evidence_id=classification.get('evidence_file_id')
            # Templates, reference material, exact duplicates, and superseded
            # versions are retained in the classification report but cannot
            # provide evidence or suppress a required-rule finding.
            if result['status'] == 'NOT_APPLICABLE':
                # An excluded template/reference cannot satisfy a catalogue
                # requirement. A real implementation artefact whose explicit
                # condition is false, however, proves that the conditional
                # control is not applicable in this project scope. Keep that
                # outcome only while no applicable assessment exists.
                if result.get('not_applicable_reason') != 'condition_not_met':
                    continue
                if current is None:
                    current = {
                        **result, 'files': [], 'evidence_file_ids': [],
                        '_rank': rank['NOT_APPLICABLE'], '_seeded': True,
                        '_conditional_result': result,
                        '_conditional_files': [],
                        '_conditional_evidence_file_ids': [],
                    }
                    aggregated[result['rule_id']] = current
                current['_conditional_result'] = result
                file_name = classification['original_file_name']
                if file_name not in current['_conditional_files']:
                    current['_conditional_files'].append(file_name)
                if evidence_id and evidence_id not in current['_conditional_evidence_file_ids']:
                    current['_conditional_evidence_file_ids'].append(evidence_id)
                continue
            if current is None:
                aggregated[result['rule_id']]={**result,'files':[classification['original_file_name']],
                    'evidence_file_ids':[evidence_id] if evidence_id else [],'_rank':score,'_seeded':False}
            else:
                current['files']=list(dict.fromkeys(current['files']+[classification['original_file_name']]))
                if evidence_id and evidence_id not in current['evidence_file_ids']: current['evidence_file_ids'].append(evidence_id)
                # Each uploaded implementation artefact is independently in
                # scope for its mapped control.  A compliant workbook must
                # never mask a duplicate, blank, or missing value in another
                # workbook.  Retain the weakest applicable assessment; the
                # file-level findings below preserve the exact provenance.
                if score < current['_rank'] or current.get('_seeded'):
                    files, ids=current['files'],current['evidence_file_ids']
                    current.update(result); current.update(files=files,evidence_file_ids=ids,_rank=score,_seeded=False)
    for current in aggregated.values():
        conditional_result = current.get('_conditional_result')
        if current.get('_seeded') and conditional_result:
            current.update(conditional_result)
            current.update(
                files=current['_conditional_files'],
                evidence_file_ids=current['_conditional_evidence_file_ids'],
                _rank=rank['NOT_APPLICABLE'],
                _seeded=False,
            )
    rules=list(aggregated.values())
    gate_by_pa={}
    for rule in rules:
        if rule['level'] == 'L1-Gate':
            gate_by_pa.setdefault(rule['practice_area'], []).append(rule['status'])
    for rule in rules:
        gate_statuses = gate_by_pa.get(rule['practice_area'])
        if (rule['level']!='L1-Gate' and gate_statuses is not None
                and any(status in {'MISSING', 'PARTIAL', 'BLOCKED', 'REVIEW_REQUIRED'}
                        for status in gate_statuses)):
            rule.update(status='BLOCKED',found_evidence=[],missing_evidence=['Required gate artefact'],
                        gap_text=f"Blocked: {rule['gap_text']}",recommendation='Provide the required gate artefact before assessing this downstream control.')
    gaps=[{**rule,'file':'; '.join(rule['files'])} for rule in rules if rule['status'] in {'PARTIAL','MISSING','BLOCKED','REVIEW_REQUIRED'}]
    by_practice_area={}
    for rule in rules:
        tally=by_practice_area.setdefault(rule['practice_area'],{'found':0,'partial':0,'missing':0,'blocked':0,'review_required':0,'not_applicable':0,'total':0})
        tally['total']+=1
        key=rule['status'].lower()
        if key in tally: tally[key]+=1
    for rule in rules:
        rule.pop('_rank', None)
        rule.pop('_seeded', None)
        rule.pop('_conditional_result', None)
        rule.pop('_conditional_files', None)
        rule.pop('_conditional_evidence_file_ids', None)
    return {'classification_report':[v['classification'] for v in validations],'rule_results':rules,'evidence_gap_report':gaps,
            'gap_summary':{'total_files':len(validations),'total_rules_checked':len(rules),'total_gaps':len(gaps),'by_practice_area':by_practice_area}}
