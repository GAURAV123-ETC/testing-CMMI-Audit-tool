"""Server-side port of the legacy document classification, evidence validation,
and gap-summary pipeline. Browser code is not used at runtime."""
import json
import re
from pathlib import Path

SEED = Path(__file__).parents[2] / 'db' / 'seed_data'
RULES = json.loads((SEED / 'cmmi_rules.json').read_text(encoding='utf-8'))
DOCUMENT_TYPES = json.loads((SEED / 'document_types.json').read_text(encoding='utf-8'))
OVERRIDES = [
    ('Issue/Defect tracking override','Issue Log / Defect Tracker',['CAR','MPM'],3,['defect','bug','issue id','severity','priority','resolution','retest','root cause','defect log','bug tracker'],'Defect/bug log with severity, priority, root cause and resolution/retest status'),
    ('RACI/RASCI matrix override','RACI / Responsibility Matrix',['DAR','PLAN'],2,['raci','rasci','responsible','accountable','consulted','informed','role matrix'],'RACI/RASCI matrix identifying Responsible, Accountable, Consulted and Informed roles'),
    ('Requirements/Traceability override','Requirements / RTM',['RDM','VV'],3,['requirement id','req-','traceability','srs','brtm','rtm','functional requirement','non-functional requirement','use case'],'Requirements Traceability Matrix linking requirements to design/test cases'),
]
DOMAIN_WORD_LISTS = [
    (('reviewed','approved','sign-off'), ['reviewed','approved','sign-off','signoff','approval','authorised','authorized','signed','endorsement']),
    (('traceability','rtm','traced'), ['traceability','RTM','traced','traceable','linked','mapped','matrix']),
    (('test',), ['tested','test case','test result','pass','fail','executed','UAT']),
    (('risk',), ['risk','probability','impact','mitigation','contingency','owner','status']),
    (('defect','bug'), ['defect','bug','severity','priority','resolution','retest','closure']),
]
EVIDENCE_SCAN_KEYWORDS = {
    'IRP': ['sla', 'rca', 'priority'],
    'PLAN': ['planning', 'schedule', 'milestone'],
    'RSK': ['risk', 'impact', 'owner'],
    'RDM': ['requirement', 'scope'],
}
STOPWORDS = {'a','an','the','is','are','was','were','be','been','being','of','to','in','on','for','and','or','by','with','from','at','as','that','this','these','those','it','its','their','there','has','have','had','do','does','did','if','not','no','all','any','each','per','which','who','whom','can','will','would','should','could','into','than','then','so','such','also','both','other','more','most','some','only','own','same','too','very','just','about','after','before','between','during','over','under','again','once','here','when','where','why','how','they','them','what'}
CLUSTERS = {'approv':['approved','approval','sign-off','authorised'],'review':['reviewed','review'],'trace':['traceability','traced','linked'],'test':['tested','test','verified'],'defect':['defect','issue'],'risk':['risk','mitigation','impact'],'mitigat':['mitigation','contingency'],'train':['training','trained'],'requirement':['requirement','requirements'],'criteri':['criteria','acceptance'],'schedul':['schedule','milestone'],'status':['status','closure'],'record':['record','log'],'measur':['measurement','metric'],'audit':['audit','review'],'scope':['scope','boundaries'],'plan':['plan','planned'],'document':['documented','recorded'],'monitor':['monitored','tracking'],'report':['reported','reporting'],'role':['role','responsibility'],'chang':['change','impact'],'configur':['configuration','baseline'],'governanc':['governance','oversight'],'decision':['decision','rationale'],'correct':['corrective','action'],'prevent':['preventive','action'],'secur':['security','access'],'incident':['incident','resolution']}

def classify_document_role(text: str, structure: dict | None = None) -> str:
    lower = (text or '').lower(); structure = structure or {}
    populated_rows = int(structure.get('populated_rows') or 0)
    if structure.get('is_spreadsheet') and populated_rows == 0:
        return 'BLANK_TEMPLATE'
    is_template = re.search(r'\b(template|sample|example|placeholder|to be completed|tbd)\b', lower)
    implementation_markers = re.search(r'\b(project|requirement|srs|brd|risk|test|approved|baseline|release)\b', lower)
    if is_template and populated_rows < 2 and not implementation_markers:
        return 'TEMPLATE'
    if re.search(r'\b(policy|process|procedure|guideline|standard)\b', lower) and not re.search(r'\b(project|release|sprint|risk id|requirement id)\b', lower):
        return 'PROCESS_REFERENCE'
    return 'PROJECT_IMPLEMENTATION_EVIDENCE'


def classify_document(text: str, file_name: str, document_types: list[dict] | None = None,
                      structure: dict | None = None) -> dict:
    text = text or ''; lower = text.lower()
    role = classify_document_role(text, structure)
    if not text.strip(): return {'original_file_name':file_name,'detected_type':'Unknown / Review Required','confidence':'Low','confidence_score':0,'classification_reason':'No extractable text content found.','matched_keywords':[],'missed_keywords':[],'practice_areas':[],'expected_evidence':'','document_role':role,'reason_codes':['NO_EXTRACTABLE_TEXT'],'candidates':[]}
    scored=[]
    for entry in (document_types or DOCUMENT_TYPES):
        matched=[word for word in entry['keywords'] if word.lower() in lower]; missed=[word for word in entry['keywords'] if word.lower() not in lower]
        scored.append((round(100*len(matched)/len(entry['keywords'])) if entry['keywords'] else 0,entry,matched,missed))
    file_name_lower = file_name.lower()
    def filename_specificity(item) -> int:
        words = re.findall(r'[a-z0-9]{3,}', item[1]['document_type'].lower())
        return sum(word in file_name_lower for word in words if word not in {'document', 'evidence'})
    scored.sort(key=lambda item: (item[0], filename_specificity(item)), reverse=True)
    candidates=[{'document_type': item[1]['document_type'], 'score': item[0]} for item in scored[:5]]
    for name, doc_type, areas, minimum, words, expected in OVERRIDES:
        matched=[word for word in words if word in lower]
        if len(matched) >= minimum:
            return {'original_file_name':file_name,'detected_type':doc_type,'confidence':'High' if len(matched)>=minimum+2 and len(matched)/len(words)>=.5 else 'Medium','confidence_score':round(100*len(matched)/len(words)),'classification_reason':f'{name}: {len(matched)} content indicators found.','matched_keywords':matched,'missed_keywords':[word for word in words if word not in matched],'practice_areas':areas,'expected_evidence':expected,'document_role':role,'reason_codes':[f'MATCHED_KEYWORD:{re.sub("[^A-Z0-9]+", "_", word.upper()).strip("_")}' for word in matched],'candidates':candidates}
    score, entry, matched, missed = scored[0]
    # Legacy Evidence Scan has a focused four-PA keyword classifier. Apply it
    # only when the general document taxonomy cannot identify the document;
    # evidence content—not the filename—remains the deciding signal.
    scan_candidates = sorted(
        ((sum(keyword in lower for keyword in keywords), code, keywords) for code, keywords in EVIDENCE_SCAN_KEYWORDS.items()),
        reverse=True,
    )
    scan_matches, scan_code, scan_words = scan_candidates[0]
    if score < 20 and scan_matches:
        scan_matched = [word for word in scan_words if word in lower]
        return {
            'original_file_name': file_name,
            'detected_type': f'{scan_code} evidence',
            'confidence': 'High' if scan_matches == len(scan_words) else 'Medium',
            'confidence_score': round(100 * scan_matches / len(scan_words)),
            'classification_reason': f'Legacy Evidence Scan content mapping matched {scan_matches} {scan_code} keyword(s).',
            'matched_keywords': scan_matched,
            'missed_keywords': [word for word in scan_words if word not in scan_matched],
            'practice_areas': [scan_code],
            'expected_evidence': f'{scan_code} evidence identified from document content.',
            'document_role': role, 'reason_codes': [f'MATCHED_KEYWORD:{word.upper()}' for word in scan_matched],
            'candidates': candidates,
        }
    if score < 20: return {'original_file_name':file_name,'detected_type':'Unknown / Review Required','confidence':'Low','confidence_score':score,'classification_reason':'Content match score is below the 20% threshold.','matched_keywords':matched,'missed_keywords':missed,'practice_areas':[],'expected_evidence':'','document_role':role,'reason_codes':[],'candidates':candidates}
    bonus_words=[]
    for word in entry['keywords']:
        if len(word.strip())>3 and word.lower() in file_name.lower() and len(bonus_words)<2: bonus_words.append(word)
    final=min(100,score+5*len(bonus_words)); confidence='High' if score>=70 and len(matched)>=3 else 'Medium' if score>=40 or final>=40 and bonus_words else 'Low'
    return {'original_file_name':file_name,'detected_type':entry['document_type'],'confidence':confidence,'confidence_score':final,'classification_reason':f'Content indicators: {", ".join(matched[:8]) or "none"}.','matched_keywords':matched,'missed_keywords':missed,'practice_areas':entry['practice_areas'],'expected_evidence':entry.get('expected_evidence',''),'document_role':role,'reason_codes':[f'MATCHED_KEYWORD:{re.sub("[^A-Z0-9]+", "_", word.upper()).strip("_")}' for word in matched],'candidates':candidates}

def _check_words(rule: dict, classification: dict) -> tuple[list[str], bool]:
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

def validate_evidence(text: str, classification: dict, rules: list[dict] | None = None) -> dict:
    lower=(text or '').lower(); results=[]
    excluded = classification.get('document_role') in {'TEMPLATE','BLANK_TEMPLATE','PROCESS_REFERENCE','DUPLICATE','SUPERSEDED_VERSION'}
    for rule in (rule for rule in (rules or RULES) if rule['practice_area'] in classification['practice_areas']):
        if excluded:
            status='NOT_APPLICABLE'; found=[]; missing=[]
        elif rule['is_gate']:
            status='FOUND' if classification['confidence'] in {'High','Medium'} else 'PARTIAL' if classification['detected_type'] != 'Unknown / Review Required' else 'MISSING'; found=[]; missing=[]
        else:
            words,presence=_check_words(rule,classification); found=[word for word in words if word.lower() in lower]; missing=[word for word in words if word.lower() not in lower]
            ratio=len(found)/len(words) if words else 0
            status='FOUND' if ratio==1 else 'PARTIAL' if (len(found)>0 if presence else ratio>=.3) else 'MISSING'
        results.append({'rule_id':rule['rule_id'],'practice_area':rule['practice_area'],'level':rule['level'],'audit_check':rule['audit_check'],'status':status,'found_evidence':found,'missing_evidence':missing,'gap_text':rule['gap_text'],'recommendation':'No action required.' if status=='FOUND' else f"Provide clear evidence of: {', '.join(missing)}."})
    return {'classification':classification,'results':results,'found_count':sum(r['status']=='FOUND' for r in results),'partial_count':sum(r['status']=='PARTIAL' for r in results),'missing_count':sum(r['status']=='MISSING' for r in results)}

def generate_gap_report(validations: list[dict], catalog_rules: list[dict] | None = None) -> dict:
    """Evaluate each applicable rule once at project scope and enforce L1 gates.

    ``validations`` only contains rules mapped to documents.  Starting from the
    pinned catalogue ensures a missing artefact is still reported when no
    document (or only an excluded template/reference) maps to that rule.
    """
    rank={'NOT_APPLICABLE':-1,'MISSING':0,'PARTIAL':1,'FOUND':2}; aggregated={}
    for rule in catalog_rules or []:
        aggregated[rule['rule_id']] = {
            'rule_id': rule['rule_id'],
            'practice_area': rule['practice_area'],
            'level': rule['level'],
            'audit_check': rule['audit_check'],
            'status': 'MISSING',
            'found_evidence': [],
            'missing_evidence': ['Required evidence was not found in the project scope.'],
            'gap_text': rule['gap_text'],
            'recommendation': 'Upload project implementation evidence and rerun the scan.',
            'files': [],
            'evidence_file_ids': [],
            '_rank': rank['MISSING'],
            '_seeded': True,
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
                continue
            if current is None:
                aggregated[result['rule_id']]={**result,'files':[classification['original_file_name']],
                    'evidence_file_ids':[evidence_id] if evidence_id else [],'_rank':score,'_seeded':False}
            else:
                current['files']=list(dict.fromkeys(current['files']+[classification['original_file_name']]))
                if evidence_id and evidence_id not in current['evidence_file_ids']: current['evidence_file_ids'].append(evidence_id)
                if score > current['_rank'] or current.get('_seeded'):
                    files, ids=current['files'],current['evidence_file_ids']
                    current.update(result); current.update(files=files,evidence_file_ids=ids,_rank=score,_seeded=False)
    rules=list(aggregated.values())
    gate_by_pa={}
    for rule in rules:
        if rule['level'] == 'L1-Gate':
            gate_by_pa.setdefault(rule['practice_area'], []).append(rule['status'])
    for rule in rules:
        gate_statuses = gate_by_pa.get(rule['practice_area'])
        if rule['level']!='L1-Gate' and gate_statuses is not None and any(status != 'FOUND' for status in gate_statuses):
            rule.update(status='BLOCKED',found_evidence=[],missing_evidence=['Required gate artefact'],
                        gap_text=f"Blocked: {rule['gap_text']}",recommendation='Provide the required gate artefact before assessing this downstream control.')
    gaps=[{**rule,'file':'; '.join(rule['files'])} for rule in rules if rule['status'] in {'PARTIAL','MISSING','BLOCKED'}]
    by_practice_area={}
    for rule in rules:
        tally=by_practice_area.setdefault(rule['practice_area'],{'found':0,'partial':0,'missing':0,'blocked':0,'total':0})
        tally['total']+=1
        key=rule['status'].lower()
        if key in tally: tally[key]+=1
    for rule in rules:
        rule.pop('_rank', None)
        rule.pop('_seeded', None)
    return {'classification_report':[v['classification'] for v in validations],'rule_results':rules,'evidence_gap_report':gaps,
            'gap_summary':{'total_files':len(validations),'total_rules_checked':len(rules),'total_gaps':len(gaps),'by_practice_area':by_practice_area}}
