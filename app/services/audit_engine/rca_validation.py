"""RCA / 5-Why and lesson-learned validation migrated from the legacy engines."""
from datetime import datetime

from app.services.audit_engine.header_matching import match_fields_exclusive, normalize_header
from app.services.document_processing.tabular import read_tabular_rows


RCA_FIELDS = [
    {'key': 'incident', 'canonical': 'incident id', 'synonyms': ['issue id', 'ticket id', 'iro id', 'reference id']},
    {'key': 'problem', 'canonical': 'problem statement', 'synonyms': ['problem description', 'issue description', 'problem']},
    {'key': 'date', 'canonical': 'rca date', 'synonyms': ['analysis date', 'date of rca', 'root cause date']},
    {'key': 'method', 'canonical': 'analysis method', 'synonyms': ['rca method', 'methodology', 'analysis technique']},
    {'key': 'root', 'canonical': 'root cause', 'synonyms': ['root cause summary', 'cause']},
    {'key': 'action', 'canonical': 'corrective action', 'synonyms': ['action', 'action plan', 'corrective action plan']},
    {'key': 'owner', 'canonical': 'owner', 'synonyms': ['action owner', 'responsible', 'responsible owner']},
    *[{'key': f'why{i}', 'canonical': f'why {i}', 'synonyms': [f'why{i}', f'why-{i}', ('first' if i == 1 else 'second' if i == 2 else 'third' if i == 3 else 'fourth' if i == 4 else 'fifth') + ' why']} for i in range(1, 6)],
]


def _finding(rule_id, severity, title, description, recommendation):
    return {'rule_id': rule_id, 'severity': severity, 'title': title, 'description': description, 'recommendation': recommendation}


def _value(row, index):
    return str(row[index] or '').strip() if index is not None and index < len(row) else ''


def _is_date(value):
    if isinstance(value, datetime):
        return True
    for fmt in ('%Y-%m-%d', '%Y-%m-%d %H:%M:%S', '%d/%m/%Y', '%d/%m/%Y %H:%M', '%d-%b-%Y'):
        try:
            datetime.strptime(str(value).strip(), fmt)
            return True
        except ValueError:
            pass
    return False


def validate_rca_workbook(path: str, incident_ids: set[str] | None = None, breached_ids: set[str] | None = None) -> list[dict]:
    rows = read_tabular_rows(path)
    if not rows:
        return [_finding('IRP-RCA', 'major', 'Empty RCA register', 'No RCA rows were found.', 'Provide RCA records for qualifying incidents.')]
    columns = match_fields_exclusive(rows[0], RCA_FIELDS)
    required = ('incident', 'problem', 'date', 'method', 'root', 'action', 'owner')
    findings = [_finding('IRP-RCA-HEADER', 'major', f'Missing RCA column: {key}', 'Required RCA traceability field is missing.', 'Add the field to the RCA register.') for key in required if columns[key] is None]
    seen, covered = set(), set()
    for number, row in enumerate(rows[1:], 2):
        if not any(str(cell or '').strip() for cell in row):
            continue
        value = lambda key: _value(row, columns[key])
        incident = value('incident')
        if not incident:
            findings.append(_finding('IRP-RCA-ID', 'major', f'RCA missing incident link (row {number})', 'RCA must be traceable to an incident.', 'Link the RCA to an incident ID.'))
        else:
            if incident in seen:
                findings.append(_finding('IRP-RCA-DUPLICATE', 'major', f'Duplicate RCA record: {incident}', 'More than one RCA record references the same incident.', 'Consolidate or explicitly version duplicate RCA records.'))
            seen.add(incident); covered.add(incident)
            if incident_ids is not None and incident not in incident_ids:
                findings.append(_finding('IRP-RCA-TRACEABILITY', 'major', f'Unknown RCA incident: {incident}', 'The RCA reference does not exist in the Incident Log.', 'Correct the incident reference or add the incident to the log.'))
        for key, label in (('problem', 'Problem Statement'), ('root', 'Root Cause'), ('action', 'Corrective Action'), ('owner', 'Owner')):
            if columns[key] is not None and not value(key):
                findings.append(_finding('IRP-RCA', 'major', f'Missing {label} (row {number})', 'RCA record is incomplete.', f'Provide {label.lower()} for the linked incident.'))
        if columns['date'] is not None and not _is_date(value('date')):
            findings.append(_finding('IRP-RCA-DATE', 'minor', f'Invalid RCA date (row {number})', 'RCA date is missing or not a recognised date.', 'Record the RCA completion date.'))
        method = normalize_header(value('method'))
        if columns['method'] is not None and not method:
            findings.append(_finding('IRP-RCA-METHOD', 'major', f'Missing RCA method (row {number})', 'An analysis method is required.', 'Record the approved RCA method.'))
        if 'why' in method:
            missing = [str(i) for i in range(1, 6) if not value(f'why{i}')]
            if missing:
                findings.append(_finding('IRP-5WHY', 'major', f'Incomplete 5-Why analysis (row {number})', f'Missing Why level(s): {", ".join(missing)}.', 'Populate all five Why levels for a 5-Why RCA method.'))
    for incident in sorted(breached_ids or set()):
        if incident not in covered:
            findings.append(_finding('IRP-RCA-SLA', 'major', f'RCA required for SLA breach: {incident}', 'A response or resolution SLA breach has no corresponding RCA.', 'Perform and document RCA for this SLA-breached incident.'))
    return findings


def validate_lessons_learned_workbook(path: str) -> list[dict]:
    rows = read_tabular_rows(path)
    if not rows:
        return [_finding('IRP-LESSON', 'major', 'Empty lesson-learned register', 'No lessons were found.', 'Record lessons learned and preventive actions.')]
    headers = [normalize_header(value) for value in rows[0]]
    required = {'incident link': {'incident id', 'issue id', 'reference id'}, 'lesson': {'lesson learned', 'lesson', 'learning'}, 'action': {'action', 'preventive action', 'improvement action'}}
    return [_finding('IRP-LESSON-HEADER', 'major', f'Missing lesson-learned column: {label}', 'Required lesson-learned traceability is absent.', 'Add the required column.') for label, aliases in required.items() if not any(header in aliases for header in headers)]
