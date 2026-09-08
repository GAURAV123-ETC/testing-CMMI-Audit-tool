"""Risk and issue register SLA validation migrated from the legacy browser engine.

The validator is intentionally read-only.  It accepts CSV/XLS/XLSX evidence,
checks only closed records with enough data to calculate an SLA, and returns
normal finding dictionaries for the persisted audit scan.
"""
from datetime import datetime
from app.services.document_processing.tabular import select_tabular_table
from app.services.audit_engine.header_matching import normalize_header


FIELDS = [
    {'key': 'id', 'canonical': 'issue id', 'synonyms': ['risk id', 'issue number', 'risk number', 'risk ref', 'reference id', 'ticket id', 'defect id', 'id']},
    {'key': 'priority', 'canonical': 'priority', 'synonyms': ['severity', 'criticality', 'risk level', 'priority level']},
    {'key': 'status', 'canonical': 'status', 'synonyms': ['current status', 'issue status', 'risk status', 'resolution status']},
    {'key': 'raised', 'canonical': 'date raised', 'synonyms': ['raised date', 'created date', 'opened date', 'logged date', 'issue date', 'date identified']},
    {'key': 'closed', 'canonical': 'closed date', 'synonyms': ['resolution date', 'date resolved', 'date closed', 'closed on', 'completed date', 'resolved on', 'date of actual closure', 'actual closure date']},
    {'key': 'reason', 'canonical': 'sla breach reason', 'synonyms': ['delay reason', 'reason', 'remarks', 'comments', 'justification', 'root cause']},
]
MANDATORY = ('priority', 'status', 'raised', 'closed')
PRIORITIES = {
    'high': (('high', 'critical', 'p1', 'urgent'), 1),
    'medium': (('medium', 'med', 'moderate', 'p2'), 2),
    'low': (('low', 'minor', 'p3'), 3),
}
CLOSED_STATUS = ('closed', 'resolved', 'completed', 'done')


def _normal(value) -> str:
    return normalize_header(value)


def _parse_date(value):
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    for pattern in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d', '%d/%m/%Y %H:%M', '%d/%m/%Y', '%d-%b-%Y %H:%M', '%d-%b-%Y'):
        try:
            return datetime.strptime(str(value).strip(), pattern)
        except ValueError:
            pass
    return None


def _value(row: list, index: int | None):
    return row[index] if index is not None and index < len(row) else None


def validate_risk_sla(path: str) -> list[dict]:
    """Return SLA-breach findings for a tabular risk or issue register."""
    selection = select_tabular_table(path, FIELDS, MANDATORY)
    rows, indices = selection.rows, selection.field_indices
    if not rows:
        return [{'rule_id': 'IRP-RISK-SLA', 'severity': 'major', 'title': 'Empty risk or issue register',
                 'description': 'No tabular records were found for SLA validation.',
                 'recommendation': 'Provide a populated CSV or Excel risk/issue register.'}]
    missing = [key for key in MANDATORY if indices[key] is None]
    if missing:
        return [{'rule_id': 'IRP-RISK-SLA-HEADER', 'severity': 'major',
                 'title': f'Missing SLA register column: {key}',
                 'description': 'The register cannot be evaluated safely without this mandatory SLA field.',
                 'recommendation': 'Add the mandatory column and rescan the register.'} for key in missing]

    findings: list[dict] = []
    for row_number, row in enumerate(rows[1:], 2):
        if not any(str(cell or '').strip() for cell in row):
            continue
        status = _normal(_value(row, indices['status']))
        if not any(value in status for value in CLOSED_STATUS):
            continue
        priority_value = _normal(_value(row, indices['priority']))
        priority = next((name for name, (tokens, _) in PRIORITIES.items() if any(token == priority_value or token in priority_value for token in tokens)), None)
        raised, closed = _parse_date(_value(row, indices['raised'])), _parse_date(_value(row, indices['closed']))
        if not priority or not raised or not closed:
            continue
        issue_id = str(_value(row, indices['id']) or f'Row {row_number}').strip()
        duration_days = (closed - raised).total_seconds() / 86400
        allowed_days = PRIORITIES[priority][1]
        if duration_days <= allowed_days:
            continue
        reason = str(_value(row, indices['reason']) or '').strip()
        findings.append({
            'rule_id': 'IRP-RISK-SLA', 'severity': 'major',
            'title': f'SLA breached: {issue_id}',
            'description': f'{priority.title()} priority record was closed after {duration_days:.1f} day(s); the SLA allows {allowed_days} day(s).',
            'recommendation': 'Record the breach reason, root cause, corrective action, and approval.',
        })
        if not reason:
            findings.append({
                'rule_id': 'IRP-RISK-SLA-REASON', 'severity': 'major',
                'title': f'Missing SLA breach reason: {issue_id}',
                'description': 'A breached risk or issue record has no documented breach reason.',
                'recommendation': 'Document the breach reason and link it to an RCA or corrective action.',
            })
    return findings
