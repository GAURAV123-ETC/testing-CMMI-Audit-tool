from app.services.audit_engine.evidence_validation import classify_document, generate_gap_report, validate_evidence

def test_classification_never_uses_filename_alone():
    result = classify_document('unrelated prose without evidence terms', 'Requirements Traceability Matrix.xlsx')
    assert result['detected_type'] == 'Unknown / Review Required'

def test_raci_override_maps_to_legacy_practice_areas():
    result = classify_document('RACI responsible accountable consulted informed role matrix', 'matrix.docx')
    assert result['practice_areas'] == ['DAR', 'PLAN']

def test_validation_returns_only_mapped_practice_area_rules():
    classification = classify_document('RACI responsible accountable consulted informed role matrix', 'matrix.docx')
    validation = validate_evidence('RACI responsible accountable consulted informed role matrix', classification)
    assert all(row['practice_area'] in {'DAR', 'PLAN'} for row in validation['results'])


def test_blank_spreadsheet_template_never_counts_as_implementation_evidence():
    catalog = [{'document_type':'Risk Register','practice_areas':['RSK'],
                'keywords':['Risk ID','Probability','Impact','Owner','Mitigation']}]
    rules = [{'rule_id':'RSK-G1','practice_area':'RSK','level':'L1-Gate','is_gate':True,
              'audit_check':'Locate the Risk Register.','gap_text':'Risk Register missing.'}]
    classification = classify_document('Risk ID Probability Impact Owner Mitigation', 'abc123.xlsx', catalog,
                                       {'is_spreadsheet':True,'populated_rows':0})
    validation = validate_evidence('Risk ID Probability Impact Owner Mitigation', classification, rules)
    assert classification['document_role'] == 'BLANK_TEMPLATE'
    assert validation['results'][0]['status'] == 'NOT_APPLICABLE'


def test_project_report_uses_strongest_document_and_blocks_downstream_rules_when_gate_fails():
    base={'original_file_name':'risk.xlsx','detected_type':'Risk Register','confidence':'Low','confidence_score':10,
          'classification_reason':'weak','matched_keywords':[],'missed_keywords':[],'practice_areas':['RSK'],
          'expected_evidence':'','document_role':'PROJECT_IMPLEMENTATION_EVIDENCE'}
    rules=[
        {'rule_id':'RSK-G1','practice_area':'RSK','level':'L1-Gate','is_gate':True,'audit_check':'Locate risk register.','gap_text':'Missing register.'},
        {'rule_id':'RSK-1','practice_area':'RSK','level':'L3-Check','is_gate':False,'audit_check':'Are risks reviewed?','gap_text':'Review missing.'},
    ]
    report=generate_gap_report([validate_evidence('risk',base,rules)])
    statuses={row['rule_id']:row['status'] for row in report['rule_results']}
    assert statuses == {'RSK-G1':'PARTIAL','RSK-1':'BLOCKED'}
    base['detected_type']='Unknown / Review Required'
    report=generate_gap_report([validate_evidence('',base,rules)])
    statuses={row['rule_id']:row['status'] for row in report['rule_results']}
    assert statuses == {'RSK-G1':'MISSING','RSK-1':'BLOCKED'}


def test_catalogue_rule_is_missing_when_only_a_blank_template_is_uploaded():
    catalog = [{'document_type':'Risk Register','practice_areas':['RSK'],
                'keywords':['Risk ID','Probability','Impact','Owner','Mitigation']}]
    rules = [
        {'rule_id':'RSK-G1','practice_area':'RSK','level':'L1-Gate','is_gate':True,
         'audit_check':'Locate the Risk Register.','gap_text':'Risk Register missing.'},
        {'rule_id':'RSK-1','practice_area':'RSK','level':'L3-Check','is_gate':False,
         'audit_check':'Are risks reviewed?','gap_text':'Review missing.'},
    ]
    classification = classify_document('Risk ID Probability Impact Owner Mitigation', 'risk.xlsx', catalog,
                                       {'is_spreadsheet':True,'populated_rows':0})
    report = generate_gap_report([
        validate_evidence('Risk ID Probability Impact Owner Mitigation', classification, rules)
    ], rules)
    statuses = {row['rule_id']:row['status'] for row in report['rule_results']}
    assert statuses == {'RSK-G1':'MISSING','RSK-1':'BLOCKED'}
