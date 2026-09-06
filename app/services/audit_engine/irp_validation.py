import json
from datetime import datetime
from pathlib import Path
from app.services.document_processing.tabular import read_tabular_rows
from app.services.audit_engine.header_matching import match_fields_exclusive, normalize_header

_MAPPING_FILE = Path(__file__).parents[2] / 'db' / 'seed_data' / 'irp_field_mappings.json'
_FIELD_DEFINITIONS = json.loads(_MAPPING_FILE.read_text(encoding='utf-8'))
# Exact 24-field/synonym registry migrated from the legacy IRP engine.
ISSUE_LOG_FIELDS = {field['key']: [field['canonical'], *field['synonyms']] for field in _FIELD_DEFINITIONS}
ALLOWED_CATEGORIES = {'software errors','hardware failures','network outages','user-reported problems'}
PRIORITY_MATRIX = {'high':{'high':'P1','medium':'P1','low':'P2'}, 'medium':{'high':'P2','medium':'P3','low':'P3'}, 'low':{'high':'P3','medium':'P4','low':'P4'}}
SLA_MINUTES = {'P1':{'response':30,'resolution':120}, 'P2':{'response':60,'resolution':480}, 'P3':{'response':240,'resolution':960}, 'P4':{'response':1440,'resolution':4320}}
RESPONSE_TIME_HEADERS = {
    'response date time', 'first response date', 'response time', 'date responded',
    'response date & time', 'first response',
}

def _normal(value): return normalize_header(value)
def _level(value):
    value=_normal(value)
    if value in {'h','high'}: return 'high'
    if value in {'m','med','medium'}: return 'medium'
    if value in {'l','low'}: return 'low'
    return None
def _priority(value):
    value=_normal(value)
    for candidate in ('P1','P2','P3','P4'):
        if value == candidate.lower() or value == candidate[1:]: return candidate
    return None
def _date(value):
    if isinstance(value, datetime): return value
    if not value: return None
    for pattern in ('%Y-%m-%d %H:%M:%S','%Y-%m-%d','%d/%m/%Y %H:%M','%d/%m/%Y','%d-%b-%Y %H:%M','%d-%b-%Y'):
        try: return datetime.strptime(str(value).strip(),pattern)
        except ValueError: pass
    return None
def _finding(rule_id, severity, title, description, recommendation):
    return {'rule_id':rule_id,'severity':severity,'title':title,'description':description,'recommendation':recommendation}
def _closed(value) -> bool:
    return any(token in _normal(value) for token in ('closed', 'resolved', 'completed', 'done'))
def _meaningful(value) -> bool:
    return _normal(value) not in {'', 'na', 'n a', 'none', 'not applicable', 'tbd', 'unknown', 'nil', '-'}


def incident_context(path: str) -> tuple[set[str], set[str]]:
    """Return Incident Log IDs and IDs with a calculated response/resolution SLA breach."""
    rows = read_tabular_rows(path)
    mapped = match_fields_exclusive(rows[0] if rows else [], _FIELD_DEFINITIONS)
    response_index = next((index for index, header in enumerate(_normal(value) for value in (rows[0] if rows else []))
                           if header in RESPONSE_TIME_HEADERS), None)
    incident_ids, breached_ids = set(), set()
    for row in rows[1:]:
        value = lambda key: row[mapped[key]] if mapped.get(key) is not None and len(row) > mapped[key] else None
        incident_id = str(value('issueId') or '').strip()
        if not incident_id:
            continue
        incident_ids.add(incident_id)
        priority, reported, closed = _priority(value('priority')), _date(value('dateTimeReported')), _date(value('closedDateTime'))
        response = _date(row[response_index] if response_index is not None and len(row) > response_index else None)
        if priority not in SLA_MINUTES or not reported:
            continue
        if closed and (closed - reported).total_seconds() / 60 > SLA_MINUTES[priority]['resolution']:
            breached_ids.add(incident_id)
        if response and (response - reported).total_seconds() / 60 > SLA_MINUTES[priority]['response']:
            breached_ids.add(incident_id)
    return incident_ids, breached_ids
def validate_incident_log(path: str) -> list[dict]:
    rows = read_tabular_rows(path)
    mapped = match_fields_exclusive(rows[0] if rows else [], _FIELD_DEFINITIONS)
    normalized_headers = [_normal(header) for header in (rows[0] if rows else [])]
    response_index = next((index for index, header in enumerate(normalized_headers) if header in RESPONSE_TIME_HEADERS), None)
    findings = [_finding('IRP-HEADER','major',f'Missing IRP column: {key}','Required Incident Log field was not found using configured synonym mapping.','Add the required field to the Incident Log.') for key,i in mapped.items() if i is None]
    seen = set()
    for number, row in enumerate(rows[1:], 2):
        value = lambda key: row[mapped[key]] if mapped.get(key) is not None and len(row) > mapped[key] else None
        incident_id = str(value('issueId') or '').strip()
        if not incident_id: findings.append(_finding('IRP-ID','major',f'Missing incident ID (row {number})','Every incident requires a unique identifier.','Assign an immutable incident ID.')); continue
        if incident_id in seen: findings.append(_finding('IRP-ID','major',f'Duplicate incident ID: {incident_id}','Incident IDs must be unique.','Correct the duplicate record.'))
        seen.add(incident_id)
        category = _normal(value('issueCategory'))
        if not category or category == 'blank': findings.append(_finding('IRP-CATEGORY','major',f'Missing issue category: {incident_id}','Issue Category is mandatory.','Assign an approved issue category.'))
        elif category not in ALLOWED_CATEGORIES: findings.append(_finding('IRP-CATEGORY','major',f'Invalid issue category: {incident_id}',f'Category "{value("issueCategory")}" is outside the configured taxonomy.','Use an approved category or update governed taxonomy.'))
        impact, urgency, actual_priority = _level(value('impact')), _level(value('urgency')), _priority(value('priority'))
        if not impact: findings.append(_finding('IRP-IMPACT','major',f'Missing or invalid impact: {incident_id}','Impact must be High, Medium, or Low.','Set a governed impact level.'))
        if not urgency: findings.append(_finding('IRP-URGENCY','major',f'Missing or invalid urgency: {incident_id}','Urgency must be High, Medium, or Low.','Set a governed urgency level.'))
        if impact and urgency:
            expected=PRIORITY_MATRIX[impact][urgency]
            if actual_priority != expected: findings.append(_finding('IRP-PRIORITY','major',f'Priority matrix mismatch: {incident_id}',f'Impact {impact.title()} and urgency {urgency.title()} require {expected}; recorded value is {value("priority") or "blank"}.','Correct priority using the approved priority matrix.'))
        reported, closed = _date(value('dateTimeReported')), _date(value('closedDateTime'))
        response = _date(row[response_index] if response_index is not None and len(row) > response_index else None)
        if _closed(value('issueStatus')) and not closed:
            findings.append(_finding('IRP-CLOSE-DATE','major',f'Missing close date/time: {incident_id}','A closed incident must record its actual close date and time.','Populate the close date/time before marking the incident closed.'))
        if _closed(value('issueStatus')) and not _meaningful(value('rootCause')):
            findings.append(_finding('IRP-ROOT-CAUSE','minor',f'Missing root cause: {incident_id}','A closed incident must include a meaningful root cause.','Document a specific root cause for the closed incident.'))
        if reported and closed and closed < reported: findings.append(_finding('IRP-DATE','major',f'Closure precedes report date: {incident_id}','Closure date/time is earlier than report date/time.','Correct the incident chronology.'))
        if reported and response and response < reported:
            findings.append(_finding('IRP-RESPONSE-DATE','major',f'Response precedes report date: {incident_id}','Response date/time is earlier than report date/time.','Correct the response chronology.'))
        if actual_priority in SLA_MINUTES and reported and closed:
            elapsed=(closed-reported).total_seconds()/60
            allowed=SLA_MINUTES[actual_priority]['resolution']
            if elapsed > allowed: findings.append(_finding('IRP-SLA','major',f'Resolution SLA breached: {incident_id}',f'{actual_priority} resolution took {round(elapsed)} minutes; allowed {allowed} minutes.','Record the breach reason, RCA, corrective action, and approval.'))
        if actual_priority in SLA_MINUTES and reported and response:
            elapsed = (response - reported).total_seconds() / 60
            allowed = SLA_MINUTES[actual_priority]['response']
            if elapsed > allowed:
                findings.append(_finding('IRP-RESPONSE-SLA','major',f'Response SLA breached: {incident_id}',f'{actual_priority} response took {round(elapsed)} minutes; allowed {allowed} minutes.','Record the breach reason and perform RCA for the response delay.'))
    return findings
