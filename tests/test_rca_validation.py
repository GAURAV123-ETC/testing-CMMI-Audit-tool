from app.services.audit_engine import rca_validation


def test_five_why_rca_checks_completeness_duplicates_and_incident_traceability(monkeypatch):
    monkeypatch.setattr(rca_validation, 'read_tabular_rows', lambda _: [
        ['Issue ID', 'Problem Description', 'Analysis Date', 'RCA Method', 'Root Cause', 'Corrective Action', 'Responsible', 'Why 1', 'Why 2', 'Why 3', 'Why 4', 'Why 5'],
        ['INC-1', 'Service unavailable', '2026-01-10', '5 Why', 'Capacity exhaustion', 'Scale workers', 'Ops', 'Why one', 'Why two', '', 'Why four', 'Why five'],
        ['INC-1', 'Service unavailable', 'bad-date', '5 Why', 'Capacity exhaustion', 'Scale workers', 'Ops', '1', '2', '3', '4', '5'],
        ['UNKNOWN', 'Issue', '2026-01-10', 'Fishbone', 'Cause', 'Action', 'Owner', '', '', '', '', ''],
    ])

    findings = rca_validation.validate_rca_workbook('rca.xlsx', incident_ids={'INC-1'}, breached_ids={'INC-1', 'INC-2'})
    rule_ids = {finding['rule_id'] for finding in findings}

    assert {'IRP-5WHY', 'IRP-RCA-DUPLICATE', 'IRP-RCA-DATE', 'IRP-RCA-TRACEABILITY', 'IRP-RCA-SLA'} <= rule_ids
