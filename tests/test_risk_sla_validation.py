from app.services.audit_engine.risk_sla_validation import validate_risk_sla
from app.services.audit_engine.irp_validation import _FIELD_DEFINITIONS, incident_context, validate_incident_log


def test_risk_sla_reports_breach_and_missing_reason_from_csv(tmp_path):
    register = tmp_path / 'risk-register.csv'
    register.write_text(
        'Issue ID,Priority,Status,Date Raised,Closed Date,SLA Breach Reason\n'
        'RISK-1,High,Closed,2025-01-01,2025-01-03,\n'
        'RISK-2,Low,Closed,2025-01-01,2025-01-02,completed on time\n', encoding='utf-8')

    findings = validate_risk_sla(str(register))

    assert [item['rule_id'] for item in findings] == ['IRP-RISK-SLA', 'IRP-RISK-SLA-REASON']
    assert 'RISK-1' in findings[0]['title']


def test_risk_sla_never_calculates_when_mandatory_headers_are_missing(tmp_path):
    register = tmp_path / 'risk-register.csv'
    register.write_text('Issue ID,Priority,Status\nRISK-1,High,Closed\n', encoding='utf-8')

    findings = validate_risk_sla(str(register))

    assert {item['rule_id'] for item in findings} == {'IRP-RISK-SLA-HEADER'}


def test_risk_sla_uses_legacy_semantic_header_matching(tmp_path):
    register = tmp_path / 'risk-register.csv'
    register.write_text(
        'Ticket_ID,Priority (P1-P4),Current Status,Opened-Date,Resolved On,Comments\n'
        'RISK-1,High,Closed,2025-01-01,2025-01-03,\n', encoding='utf-8')

    findings = validate_risk_sla(str(register))

    assert {item['rule_id'] for item in findings} == {'IRP-RISK-SLA', 'IRP-RISK-SLA-REASON'}


def test_irp_issue_log_uses_all_legacy_synonyms_without_reusing_a_column(tmp_path):
    source = tmp_path / 'incident-log.csv'
    headers = [field['canonical'] for field in _FIELD_DEFINITIONS]
    headers[0] = 'Incident_ID'
    headers[12] = 'Non-Conformity Status (NC)'
    headers[19] = 'Reported Date & Time'
    source.write_text(','.join(headers) + '\n' + ','.join('' for _ in headers) + '\n', encoding='utf-8')

    findings = validate_incident_log(str(source))

    assert not [item for item in findings if item['rule_id'] == 'IRP-HEADER']


def test_incident_context_identifies_records_that_require_rca(tmp_path):
    source = tmp_path / 'incident-log.csv'
    headers = [field['canonical'] for field in _FIELD_DEFINITIONS] + ['First Response Date']
    row = ['' for _ in headers]
    by_key = {field['key']: index for index, field in enumerate(_FIELD_DEFINITIONS)}
    row[by_key['issueId']] = 'INC-9'
    row[by_key['priority']] = 'P1'
    row[by_key['dateTimeReported']] = '2025-01-01 09:00:00'
    row[by_key['closedDateTime']] = '2025-01-01 13:30:00'
    row[-1] = '2025-01-01 10:00:00'
    source.write_text(','.join(headers) + '\n' + ','.join(row) + '\n', encoding='utf-8')

    ids, breaches = incident_context(str(source))

    assert ids == {'INC-9'}
    assert breaches == {'INC-9'}
