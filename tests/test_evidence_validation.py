from app.services.audit_engine.evidence_validation import (
    _condition_applies, build_tabular_context, classify_document, generate_gap_report, validate_evidence,
)
from app.services.audit_engine.document_classification import classify_document as classify_document_candidates

def test_classification_never_uses_filename_alone():
    catalogue = [{'document_type': 'Requirements Traceability Matrix', 'practice_areas': ['RDM'],
                  'keywords': ['requirement id', 'traceability']}]
    result = classify_document('unrelated prose without evidence terms', 'Requirements Traceability Matrix.xlsx', catalogue)
    assert result['detected_type'] == 'Unknown / Review Required'

def test_catalogue_name_match_outranks_broader_shared_keywords():
    catalogue = [
        {'document_type': 'Change Log / FSD', 'practice_areas': ['RDM'],
         'keywords': ['Impact', 'Approval', 'Status']},
        {'document_type': 'Impact Analysis and TSD', 'practice_areas': ['TS'],
         'keywords': ['Impact', 'Dependency', 'Interface', 'Module', 'Risk', 'Effort'], 'include_in_afr': True},
    ]
    result = classify_document(
        'Impact Analysis Report. Impacted module, dependency, risk, effort, approval and status.',
        'EPA Impact Analysis Report CR 2.docx', catalogue,
    )
    assert result['detected_type'] == 'Impact Analysis and TSD'
    assert result['practice_areas'] == ['TS']
    assert result['afr_eligible'] is True
    assert 'Catalogue name matched uploaded file and content' in result['classification_reason']


def test_manifest_is_a_reference_and_cannot_be_assessed_as_project_evidence():
    catalogue = [{'document_type': 'WBS', 'practice_areas': ['PMC'],
                  'keywords': ['WBS ID', 'Work Package', 'Owner', 'Status']}]
    result = classify_document(
        'WBS ID Work Package Owner Status Evidence File Mapping',
        'Project/00_Manifest_and_Mapping.xlsx', catalogue,
    )
    assert result['detected_type'] == 'Manifest / Mapping Reference'
    assert result['document_role'] == 'PROCESS_REFERENCE'
    assert result['document_type_rule_id'] is None


def test_exact_filename_identity_beats_a_broader_shared_schema():
    catalogue = [
        {'document_type': 'Change Log / FSD', 'practice_areas': ['RDM'],
         'keywords': ['Change ID', 'Requirement ID', 'Impact', 'Approval', 'Status']},
        {'document_type': 'Impact Analysis and TSD', 'practice_areas': ['TS'],
         'keywords': ['Impact ID', 'Change ID', 'Requirement ID', 'Module', 'Impact', 'Dependency', 'Risk', 'Effort']},
    ]
    headers = ['Impact ID', 'Change ID', 'Requirement ID', 'Affected Module',
               'Impact', 'Dependency', 'Risk Impact', 'Effort Impact', 'Approval']
    result = classify_document(' '.join(headers), '03_Impact_Analysis.xlsx', catalogue, {
        'is_spreadsheet': True, 'headers': headers,
        'header_rows': [{'sheet': 'Impact', 'row_index': 0, 'values': headers}],
        'populated_rows': 3,
    })
    assert result['detected_type'] == 'Impact Analysis and TSD'


def test_sparse_effort_tracking_sheet_maps_from_approved_filename_and_variance_header():
    catalogue = [{
        'document_type': 'Tracking of actual efforts against planned', 'practice_areas': ['EST'],
        'keywords': ['Planned Effort', 'Actual Effort', 'Variance', 'Effort Variance', 'Hours', 'Productivity'],
    }]
    headers = ['Tracking ID', 'Change ID', 'Requirement ID', 'Plan', 'Actual', 'Variance', 'Variance %']
    result = classify_document(' '.join(headers), '07_Effort_Tracking.xlsx', catalogue, {
        'is_spreadsheet': True, 'headers': headers,
        'header_rows': [{'sheet': 'Effort', 'row_index': 0, 'values': headers}],
        'populated_rows': 4,
    })
    assert result['detected_type'] == 'Tracking of actual efforts against planned'
    assert result['practice_areas'] == ['EST']


def test_irp_filename_and_issue_log_schema_outrank_an_incidental_defect_tab():
    catalogue = [
        {'document_type': 'Incident Log – 2 Months', 'practice_areas': ['IRP'],
         'keywords': ['Incident ID', 'Date', 'Priority', 'Impact', 'Urgency', 'Category', 'SLA', 'Resolution', 'Status'],
         'aliases': ['Issue Log', 'Issue Register', 'IRP'], 'include_in_afr': True},
        {'document_type': 'Testing Defects', 'practice_areas': ['VV'],
         'keywords': ['Defect ID', 'Severity', 'Priority', 'Root Cause', 'Status', 'Fix', 'Retest', 'Closure'],
         'include_in_afr': True},
    ]
    issue_headers = ['Issue ID', 'Issue Date', 'Issue Status', 'Issue Category', 'Issue Description',
                     'Impact', 'Priority Level', 'Response', 'Final Resolution']
    defect_headers = ['Defect ID', 'Severity', 'Priority', 'Root Cause', 'Status', 'Retest', 'Closure']
    result = classify_document(' '.join([*issue_headers, *defect_headers]), 'Beta/01_IRP_dummy_data.xlsx', catalogue, {
        'is_spreadsheet': True, 'populated_rows': 20,
        'header_rows': [
            {'sheet': 'Issue log', 'row_index': 0, 'values': issue_headers},
            {'sheet': 'Defect log', 'row_index': 0, 'values': defect_headers},
        ],
    })
    assert result['detected_type'] == 'Incident Log – 2 Months'
    assert result['practice_areas'] == ['IRP']


def test_cam_filename_with_generic_capacity_fields_requires_a_cam_identifier_anchor():
    catalogue = [{
        'document_type': 'CAM Sheet', 'practice_areas': ['SDM'],
        'keywords': ['Corrective Action', 'Action Owner', 'Due Date', 'Root Cause', 'Preventive Action', 'Status', 'Closure'],
        'aliases': ['CAM Sheet'], 'include_in_afr': True,
    }]
    headers = ['Capacity', 'Root Causal analysis', 'Corrective Action/ Preventive Action', 'Status']
    result = classify_document(' '.join(headers), 'Beta/11_CAM_SHEET.xls', catalogue, {
        'is_spreadsheet': True, 'populated_rows': 7,
        'header_rows': [{'sheet': 'Capacity plan', 'row_index': 3, 'values': headers}],
    })
    assert result['detected_type'] == 'Unknown / Review Required'
    assert result['reason_codes'] == ['MISSING_REQUIRED_SCHEMA_ANCHOR']


def test_tabular_context_excludes_sparse_section_rows_but_keeps_substantive_missing_id_rows(tmp_path):
    from openpyxl import Workbook

    path = tmp_path / 'defects.xlsx'
    workbook = Workbook(); sheet = workbook.active
    sheet.append(['Defect ID', 'Phase', 'Defect Description'])
    sheet.append([None, 'Pre-Release Check', None])
    sheet.append(['DEF-1', 'System Test', 'A real defect'])
    sheet.append([None, 'System Test', 'A real record missing its ID'])
    workbook.save(path)
    context = build_tabular_context(str(path), {
        'required_keywords': ['Defect ID', 'Phase', 'Defect Description'],
    })
    assert context['row_count'] == 2
    assert context['rows'] == [
        ['DEF-1', 'System Test', 'A real defect'],
        [None, 'System Test', 'A real record missing its ID'],
    ]


def test_tabular_context_never_selects_a_data_row_with_side_summary_labels_as_headers(tmp_path):
    from datetime import datetime
    from openpyxl import Workbook

    path = tmp_path / 'issue-log.xlsx'
    workbook = Workbook(); sheet = workbook.active
    sheet.append(['Issue ID', 'Issue Date', 'Issue Status', 'Issue Category', 'Impact', 'Priority Level'])
    sheet.append([
        'ISS-1', datetime(2026, 1, 1), 'Resolved', 'Operational', 'Moderate', 'High',
        'Category', 'Impact', 'Issue Priority', 'Status',
    ])
    workbook.save(path)
    context = build_tabular_context(str(path), {
        'detected_type': 'Incident Log – 2 Months',
        'required_keywords': ['Incident ID', 'Date', 'Priority', 'Impact', 'Category', 'Status'],
    })
    assert context['header_row_index'] == 0
    assert context['headers'][:6] == [
        'Issue ID', 'Issue Date', 'Issue Status', 'Issue Category', 'Impact', 'Priority Level',
    ]


def test_spreadsheet_schema_outranks_incidental_test_case_references():
    catalogue = [
        {'document_type': 'Change Log / FSD', 'practice_areas': ['RDM'],
         'keywords': ['Change ID', 'Requirement ID', 'Change Description', 'Impact', 'Approval', 'Status', 'Affected Module']},
        {'document_type': 'Unit Test Cases & Results', 'practice_areas': ['VV'],
         'keywords': ['Test Case ID', 'Requirement ID', 'Expected Result', 'Actual Result', 'Pass', 'Fail', 'Execution Date', 'Defect ID']},
    ]
    headers = ['Change ID', 'Requirement ID', 'Change Description', 'Impact', 'Approval', 'Status', 'Affected Module', 'Affected Test Case']
    result = classify_document(' '.join(headers), 'CR_Log Project 1.xlsx', catalogue, {
        'is_spreadsheet': True, 'sheet_names': ['CR Log'], 'headers': headers,
        'header_rows': [{'sheet': 'CR Log', 'row_index': 0, 'values': headers}], 'populated_rows': 5,
    })
    assert result['detected_type'] == 'Change Log / FSD'
    assert result['practice_areas'] == ['RDM']

def test_catalogue_title_match_survives_a_renamed_upload():
    catalogue = [
        {'document_type': 'Change Log / FSD', 'practice_areas': ['RDM'],
         'keywords': ['Impact', 'Approval', 'Status']},
        {'document_type': 'Impact Analysis and TSD', 'practice_areas': ['TS'],
         'keywords': ['Impact', 'Dependency', 'Interface', 'Module', 'Risk', 'Effort']},
    ]
    result = classify_document(
        'Impact Analysis Report. Impacted module, dependency, risk, effort, approval and status.',
        'uploads/final-v2.docx', catalogue,
    )
    assert result['detected_type'] == 'Impact Analysis and TSD'
    assert result['practice_areas'] == ['TS']
    assert 'Catalogue name matched extracted content' in result['classification_reason']


def test_catalogue_mapping_never_invents_an_irp_practice_area():
    catalogue = [{'document_type': 'Issue Log', 'practice_areas': ['MC'],
                  'keywords': ['Issue ID', 'Priority', 'Resolution']}]
    classification = classify_document('Issue Log Issue ID Priority Resolution', 'Project/Issue Log.xlsx', catalogue)
    validation = validate_evidence('Issue Log Issue ID Priority Resolution', classification, [
        {'rule_id': 'IRP-G1', 'practice_area': 'IRP', 'level': 'L1-Gate', 'is_gate': True,
         'audit_check': 'Locate incident log.', 'gap_text': 'Incident log missing.'},
    ])
    assert classification['practice_areas'] == ['MC']
    assert validation['results'] == []


def test_archive_folder_names_and_substrings_cannot_manufacture_a_match():
    catalogue = [
        {'document_type': 'Project Metrics / Dashboard', 'practice_areas': ['MPM'],
         'keywords': ['effort', 'schedule', 'defects', 'quality']},
        {'document_type': 'Impact Analysis and TSD', 'practice_areas': ['TS'],
         'keywords': ['impact', 'dependency', 'interface', 'module']},
    ]
    result = classify_document(
        'AIQC Implementation Status. Stakeholder technical issues and actions.',
        'archive.zip/Project-2/Issue during UAT II.xlsx', catalogue,
        {'is_spreadsheet': True, 'populated_rows': 10,
         'header_rows': [{'sheet': 'Sheet1', 'row_index': 1,
                          'values': ['Stakeholder', 'Technical issues', 'Action']}]},
    )
    assert result['detected_type'] == 'Unknown / Review Required'
    assert result['practice_areas'] == []
    metrics = next(item for item in result['candidates']
                   if item['document_type'] == 'Project Metrics / Dashboard')
    assert metrics['filename_score'] == 0
    assert 'impact' not in result['matched_keywords']


def test_renamed_testing_defect_sheet_maps_from_schema_content():
    catalogue = [
        {'document_type': 'Testing Defects', 'practice_areas': ['VV'],
         'keywords': ['Defect ID', 'Severity', 'Priority', 'Root Cause', 'Status', 'Fix', 'Retest', 'Closure'],
         'include_in_afr': True},
        {'document_type': 'Project Metrics / Dashboard', 'practice_areas': ['MPM'],
         'keywords': ['Effort', 'schedule', 'defects', 'productivity', 'quality']},
    ]
    text = 'D-1 Severity High Priority P1 Root Cause missing validation Status Fixed Fix deployed Retest passed Closure date'
    result = classify_document(text, 'renamed-upload.xlsx', catalogue, {
        'is_spreadsheet': True, 'populated_rows': 1,
        'header_rows': [{'sheet': 'Results', 'row_index': 3,
                         'values': ['Defect ID', 'Severity', 'Priority', 'Root Cause', 'Status', 'Fix', 'Retest', 'Closure']}],
    })
    assert result['detected_type'] == 'Testing Defects'
    assert result['practice_areas'] == ['VV']
    assert result['afr_eligible'] is True
    assert set(result['matched_structured_keywords']) == set(catalogue[0]['keywords'])


def test_causal_analysis_body_maps_to_rca_without_relying_on_filename():
    catalogue = [
        {'document_type': 'RCA for P1/P2', 'practice_areas': ['RSK'],
         'keywords': ['Root Cause', '5 Why', 'Fishbone', 'Corrective Action',
                      'Preventive Action', 'Recurrence', 'P1', 'P2'],
         'include_in_afr': True},
        {'document_type': 'CAM Sheet', 'practice_areas': ['SDM'],
         'keywords': ['Corrective Action', 'Action Owner', 'Due Date', 'Root Cause',
                      'Preventive Action', 'Status', 'Closure'],
         'include_in_afr': True},
    ]
    result = classify_document(
        'Causal Analysis Report. Investigation using 5 Why. Root Cause of the issue. '
        'Corrective Action Plan and Preventive Action Plan.',
        'renamed-document.doc', catalogue,
    )
    assert result['detected_type'] == 'RCA for P1/P2'
    assert result['practice_areas'] == ['RSK']


def test_opening_technical_design_title_outweighs_later_code_review_section():
    catalogue = [
        {'document_type_rule_id': 35, 'document_type': 'Impact Analysis and TSD',
         'practice_areas': ['TS'],
         'keywords': ['Impact', 'Dependency', 'Interface', 'Module', 'Risk', 'Effort',
                      'Design Change', 'impacted programme', 'impacted table'],
         'aliases': ['Impact Analysis and TSD', 'Impact Analysis',
                     'Technical Solution Design', 'Technical Solution Design Document'],
         'include_in_afr': True},
        {'document_type_rule_id': 39, 'document_type': 'Code Review Records & Defects',
         'practice_areas': ['PR'],
         'keywords': ['Code Review', 'Reviewer', 'Review Date', 'Findings', 'Defect',
                      'Severity', 'Action', 'Closure'],
         'aliases': ['Code Review Records & Defects'], 'include_in_afr': True},
    ]
    text = (
        'TECHNICAL SOLUTION DESIGN DOCUMENT\n'
        'This Technical Solution Design defines architecture, component modules, interfaces, '
        'risk, dependency and effort for the approved design baseline.\n'
        'The technical design review includes Code Review, Reviewer, Review Date, Findings, '
        'Defect Severity, Action and Closure.'
    )

    result = classify_document(text, 'renamed-evidence.docx', catalogue)

    assert result['detected_type'] == 'Impact Analysis and TSD'
    assert result['document_type_rule_id'] == 35
    assert result['practice_areas'] == ['TS']
    assert 'opening document content' in result['classification_reason']


def test_legacy_candidate_adapter_uses_the_canonical_content_classifier():
    candidates = classify_document_candidates(
        'Technical_Solution_Design.docx',
        'Technical Solution Design Document. Architecture, interface, dependency, risk and effort.',
    )

    assert candidates[0]['document_type'] == 'Impact Analysis and TSD'


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


def test_untriggered_conditional_control_is_not_a_false_catalogue_gap():
    classification = {
        'original_file_name': 'unit-test.xlsx', 'evidence_file_id': 42,
        'document_type_rule_id': 101, 'practice_areas': ['VER'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'unit test cases and results',
    }
    rule = {
        'rule_id': 'UT-10', 'practice_area': 'VER', 'level': 'L3-Check',
        'is_gate': False, 'document_type_rule_id': 101,
        'condition': 'When test fails', 'detection': 'Defect ID reference',
        'audit_check': 'Failed test cases have a linked defect ID.',
        'gap_text': 'Failed test case has no defect ID.',
    }
    validation = validate_evidence('Status Pass Pass Pass', classification, [rule], {
        'headers': ['Test Case ID', 'Status', 'Defect ID'],
        'rows': [['UT-1', 'Pass', '']],
    })
    assert validation['results'][0]['not_applicable_reason'] == 'condition_not_met'

    report = generate_gap_report([validation], [rule])
    outcome = report['rule_results'][0]
    assert outcome['status'] == 'NOT_APPLICABLE'
    assert outcome['files'] == ['unit-test.xlsx']
    assert report['evidence_gap_report'] == []
    assert report['gap_summary']['by_practice_area']['VER']['not_applicable'] == 1


def test_not_applicable_file_cannot_hide_an_applicable_failure_in_another_file():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['VER'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'unit test cases and results',
    }
    rule = {
        'rule_id': 'UT-10', 'practice_area': 'VER', 'level': 'L3-Check',
        'is_gate': False, 'document_type_rule_id': 101,
        'condition': 'When test fails', 'detection': 'Defect ID reference',
        'audit_check': 'Failed test cases have a linked defect ID.',
        'gap_text': 'Failed test case has no defect ID.',
    }
    passing = validate_evidence('Status Pass', {
        **classification, 'original_file_name': 'passing.xlsx', 'evidence_file_id': 42,
    }, [rule], {'headers': ['Status', 'Defect ID'], 'rows': [['Pass', '']]})
    failing = validate_evidence('Status Failed', {
        **classification, 'original_file_name': 'failing.xlsx', 'evidence_file_id': 43,
    }, [rule], {'headers': ['Status', 'Defect ID'], 'rows': [['Failed', '']]})

    report = generate_gap_report([passing, failing], [rule])
    outcome = report['rule_results'][0]
    assert outcome['status'] == 'MISSING'
    assert outcome['files'] == ['failing.xlsx']
    assert outcome['evidence_file_ids'] == [43]
    assert len(report['evidence_gap_report']) == 1


def test_conditional_test_field_is_checked_only_on_failed_rows():
    classification = {
        'original_file_name': 'mixed-tests.xlsx',
        'document_type_rule_id': 101, 'practice_areas': ['VER'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'unit test cases and results',
    }
    rule = {
        'rule_id': 'UT-10', 'practice_area': 'VER', 'level': 'L3-Check',
        'is_gate': False, 'document_type_rule_id': 101,
        'condition': 'When test fails', 'detection': 'Defect ID reference',
        'audit_check': 'Failed test cases have a linked defect ID.',
        'gap_text': 'Failed test case has no defect ID.',
    }
    context = {
        'headers': ['Test Case ID', 'Status', 'Defect ID'],
        'rows': [['UT-1', 'Pass', ''], ['UT-2', 'Failed', 'DEF-2']],
    }
    result = validate_evidence('Pass Failed DEF-2', classification, [rule], context)['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == ['Defect ID: 1 populated value(s)']

    context['rows'] = [['UT-1', 'Pass', 'DEF-WRONG'], ['UT-2', 'Failed', '']]
    result = validate_evidence('Pass Failed DEF-WRONG', classification, [rule], context)['results'][0]
    assert result['status'] == 'MISSING'
    assert result['found_evidence'] == []
    assert result['missing_evidence'] == ['Defect ID: 1 blank value(s)']


def test_findings_condition_uses_only_rows_with_an_actual_finding():
    classification = {
        'original_file_name': 'reviews.xlsx',
        'document_type_rule_id': 101, 'practice_areas': ['PR'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'code review records and defects',
    }
    rule = {
        'rule_id': 'CRV-09', 'practice_area': 'PR', 'level': 'L3-Check',
        'is_gate': False, 'document_type_rule_id': 101,
        'condition': 'When findings exist',
        'detection': 'Defect ID + parent Review ID link',
        'audit_check': 'Each finding has a unique Defect ID, linked to its parent Review ID.',
        'gap_text': 'Finding linkage is missing.',
    }
    result = validate_evidence('Findings 0 1 DEF-2', classification, [rule], {
        'headers': ['Review ID', 'Findings', 'Finding IDs'],
        'rows': [
            ['REV-1', 0, ''],
            ['REV-2', 1, 'DEF-2'],
            ['REV-2', 1, 'DEF-3'],
        ],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == [
        'Review ID: 2 populated value(s)',
        'Finding IDs: 2 populated value(s)', 'Finding IDs: values are unique',
    ]

    duplicate = validate_evidence('Findings 1 DEF-2', classification, [rule], {
        'headers': ['Review ID', 'Findings', 'Finding IDs'],
        'rows': [['REV-2', 1, 'DEF-2'], ['REV-3', 1, 'DEF-2']],
    })['results'][0]
    assert duplicate['status'] == 'MISSING'
    assert any('Finding IDs: duplicate value(s) DEF-2' == value
               for value in duplicate['missing_evidence'])


def test_not_applicable_gate_does_not_block_an_applicable_downstream_control():
    rules = [
        {'rule_id': 'VER-G1', 'practice_area': 'VER', 'level': 'L1-Gate', 'is_gate': True,
         'condition': 'When test fails', 'audit_check': 'Locate failed test evidence.',
         'gap_text': 'Failed test evidence missing.'},
        {'rule_id': 'VER-01', 'practice_area': 'VER', 'level': 'L3-Check', 'is_gate': False,
         'audit_check': 'Test results are recorded.', 'gap_text': 'Test result missing.'},
    ]
    classification = {
        'original_file_name': 'tests.xlsx', 'practice_areas': ['VER'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'unit test cases and results', 'matched_keywords': ['test'],
    }
    report = generate_gap_report([
        validate_evidence('All tests pass and test results are recorded.', classification, rules)
    ], rules)
    outcomes = {row['rule_id']: row['status'] for row in report['rule_results']}
    assert outcomes['VER-G1'] == 'NOT_APPLICABLE'
    assert outcomes['VER-01'] != 'BLOCKED'


def test_unmatched_practice_area_is_an_uploaded_scope_gap_without_file_provenance():
    rules = [
        {'rule_id':'BC-G1','practice_area':'BC','level':'L1-Gate','is_gate':True,
         'audit_check':'Locate the Business Continuity Plan or Disaster Recovery Plan.','gap_text':'BCP/DR plan missing.'},
        {'rule_id':'BC-1','practice_area':'BC','level':'L3-Check','is_gate':False,
         'audit_check':'Are recovery procedures documented?','gap_text':'Recovery procedures incomplete.'},
    ]
    unrelated = {
        'classification': {'original_file_name':'risk-register.xlsx', 'evidence_file_id':9,
                           'practice_areas':['RSK'], 'document_role':'PROJECT_IMPLEMENTATION_EVIDENCE'},
        'results': [],
    }
    report = generate_gap_report([unrelated], rules)
    outcomes = {row['rule_id']: row for row in report['rule_results']}
    assert outcomes['BC-G1']['status'] == 'MISSING'
    assert outcomes['BC-G1']['evidence_file_ids'] == []
    assert outcomes['BC-1']['status'] == 'BLOCKED'
    assert outcomes['BC-1']['evidence_file_ids'] == []


def test_sap_state_conditions_require_the_actual_lifecycle_state_not_generic_status_text():
    assert not _condition_applies('When status = Closed', 'Status: Open; owner: Audit Team')
    assert _condition_applies('When status = Closed', 'Status: Closed; closure date: 2026-09-16')
    assert not _condition_applies('When a linked defect is fixed', 'Defect is open')
    assert _condition_applies('When a linked defect is fixed', 'Defect DEF-12 is fixed and closed')


def test_sap_field_controls_are_scoped_to_the_classified_document_not_only_its_practice_area():
    classification = {
        'original_file_name': 'change-request.xlsx', 'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE',
        'document_type_rule_id': 101, 'practice_areas': ['RDM'], 'confidence': 'High',
        'detected_type': 'Change Log / FSD',
    }
    rules = [
        {'rule_id': 'CR-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
         'document_type_rule_id': 101, 'detection': 'Unique CR number',
         'audit_check': 'CR has a unique number.', 'gap_text': 'CR ID missing.'},
        {'rule_id': 'OTHER-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
         'document_type_rule_id': 202, 'detection': 'Functional requirement ID',
         'audit_check': 'Requirement is identified.', 'gap_text': 'Requirement ID missing.'},
    ]
    result = validate_evidence('CR number CR-42', classification, rules)
    assert [row['rule_id'] for row in result['results']] == ['CR-01']


def test_combined_change_log_and_fsd_controls_follow_the_sheet_subtype():
    base = {
        'original_file_name': 'project.xlsx', 'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE',
        'document_type_rule_id': 101, 'practice_areas': ['RDM'], 'confidence': 'High',
        'detected_type': 'Change Log / FSD',
    }
    rules = [
        {'rule_id': 'CR-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
         'document_type_rule_id': 101, 'audit_check': 'Change Request ID is assigned.',
         'detection': 'Change Request ID', 'gap_text': 'CR ID missing.'},
        {'rule_id': 'FSD-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
         'document_type_rule_id': 101, 'audit_check': 'Functional Specification ID is assigned.',
         'detection': 'FSD ID', 'gap_text': 'FSD ID missing.'},
    ]
    fsd = validate_evidence('', {**base, 'artifact_scope': 'FSD'}, rules,
                            {'headers': ['FSD ID'], 'rows': [['FSD-1']]})
    change_log = validate_evidence('', {**base, 'artifact_scope': 'CHANGE_LOG'}, rules,
                                   {'headers': ['Change ID'], 'rows': [['CR-1']]})
    assert [row['rule_id'] for row in fsd['results']] == ['FSD-01']
    assert [row['rule_id'] for row in change_log['results']] == ['CR-01']


def test_catalogue_gap_keeps_the_master_recommended_action():
    report = generate_gap_report([], [{
        'rule_id': 'RCA-01', 'practice_area': 'CAR', 'level': 'L3-Check',
        'audit_check': 'RCA ID is present.', 'gap_text': 'RCA ID missing.',
        'recommendation': 'Assign a unique RCA ID.',
    }])
    assert report['evidence_gap_report'][0]['recommendation'] == 'Assign a unique RCA ID.'


def test_sap_tabular_validation_checks_header_values_and_duplicate_ids():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Change Log / FSD',
    }
    rule = {
        'rule_id': 'CR-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Unique Change Request ID is assigned.',
        'detection': 'Unique CR number pattern', 'gap_text': 'Change Request ID is missing.',
        'recommendation': 'Assign a unique CR ID.',
    }
    complete = {'headers': ['Change ID', 'Status'], 'rows': [['CR-1', 'Open'], ['CR-2', 'Closed']]}
    duplicate = {'headers': ['Change ID', 'Status'], 'rows': [['CR-1', 'Open'], ['CR-1', 'Closed']]}
    assert validate_evidence('', classification, [rule], complete)['results'][0]['status'] == 'FOUND'
    result = validate_evidence('', classification, [rule], duplicate)['results'][0]
    assert result['status'] == 'MISSING'
    assert result['required_evidence'] == ['Unique CR number pattern']
    assert result['found_evidence'] == ['Change ID: 2 populated value(s)']
    assert 'duplicate value(s) CR-1' in result['missing_evidence'][0]


def test_tabular_validation_treats_zero_as_a_populated_evidence_value():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['EST'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'effort tracking',
    }
    rule = {
        'rule_id': 'EFF-05', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Effort variance percentage is calculated.',
        'detection': 'Variance % formula/value', 'gap_text': 'Variance is missing.',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Variance Hours', 'Variance %'], 'rows': [[1, 0], [2, 7.5]],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == ['Variance %: 2 populated value(s)']
    assert result['missing_evidence'] == []


def test_effort_tracking_identifier_duplicate_is_a_confirmed_integrity_gap():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['EST'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Tracking of actual efforts against planned',
    }
    rule = {
        'rule_id': 'EFF-01', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Planned hours/PD per task',
        'audit_check': 'Planned effort per task/resource is recorded.', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Tracking ID', 'Planned Hours'],
        'rows': [['ET-001', 16], ['ET-001', 24]],
    })['results'][0]
    assert result['status'] == 'MISSING'
    assert 'Tracking ID: duplicate value(s) ET-001' in result['missing_evidence']
    assert 'Tracking ID: 2 populated value(s)' in result['found_evidence']


def test_sla_profiles_identify_invalid_measurements_and_duplicate_incident_rows():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['SDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'SLA Target vs Achievement Report',
    }
    response_rule = {
        'rule_id': 'SLA-03', 'practice_area': 'SDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Actual vs target timestamps',
        'audit_check': 'Actual response times are measured per incident.', 'gap_text': 'Missing',
    }
    response_result = validate_evidence('', classification, [response_rule], {
        'headers': ['Incident ID', 'Response Target (Minutes)', 'Actual Response (Minutes)'],
        'rows': [['INC-204', 30, 25], ['INC-204', 0, '#####']],
    })['results'][0]
    assert response_result['status'] == 'MISSING'
    assert 'Incident ID: duplicate value(s) INC-204' in response_result['missing_evidence']
    assert any('Response Target' in item and 'invalid, zero, or unreadable' in item
               for item in response_result['missing_evidence'])
    assert any('Actual Response' in item and 'invalid, zero, or unreadable' in item
               for item in response_result['missing_evidence'])

    priority_rule = {**response_rule, 'rule_id': 'SLA-01',
                     'detection': 'Target table by priority',
                     'audit_check': 'Response time SLA targets are defined per priority.'}
    priority_result = validate_evidence('', classification, [priority_rule], {
        'headers': ['Priority', 'Response Target (Minutes)'],
        'rows': [['P1', 30], ['#####', 60]],
    })['results'][0]
    assert priority_result['status'] == 'MISSING'
    assert 'Priority: invalid or unreadable governed value(s)' in priority_result['missing_evidence']


def test_estimation_presence_control_uses_classified_artifact_not_a_fictitious_header():
    classification = {
        'original_file_name': 'project-sizing.xlsx', 'document_type_rule_id': 101,
        'practice_areas': ['EST'], 'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE',
        'confidence': 'Medium', 'detected_type': 'Estimation sheet',
    }
    rule = {
        'rule_id': 'EST-01', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'File/record found matching the CR/FSD reference',
        'audit_check': 'The Estimation Sheet exists and is available for audit', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Category', 'Estimated Effort (Hours)'], 'rows': [['Installation', 8]],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == ['Matched Estimation sheet file: project-sizing.xlsx']


def test_rca_approval_and_closure_headers_are_shown_without_claiming_review_date_evidence():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['CAR'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'Medium',
        'detected_type': 'RCA for P1/P2',
    }
    rule = {
        'rule_id': 'RCA-15', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Reviewer + approval date',
        'audit_check': 'RCA is reviewed, approved and formally closed with date', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['RCA Approval', 'Closure Status'], 'rows': [['Approved', 'Closed']],
    })['results'][0]
    assert result['status'] == 'PARTIAL'
    assert result['found_evidence'] == [
        'RCA Approval: 1 populated value(s)', 'Closure Status: 1 populated value(s)',
    ]
    assert any('Reviewer' in item for item in result['missing_evidence'])
    assert any('Approval date' in item for item in result['missing_evidence'])


def test_field_control_checks_every_relevant_sheet_in_a_workbook_context():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['PR'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'Medium',
        'detected_type': 'Code Review Records & Defects',
    }
    register = {
        'sheet_name': 'Review Register', 'headers': ['Review ID', 'Findings'],
        'rows': [['REV-1', 0]], 'row_count': 1,
    }
    approvals = {
        'sheet_name': 'Approval Evidence', 'headers': ['Review ID', 'Review Date'],
        'rows': [['REV-1', '2026-09-23']], 'row_count': 1,
    }
    context = {**register, 'all_table_contexts': [register, approvals]}
    rule = {
        'rule_id': 'CRV-05', 'practice_area': 'PR', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Review date',
        'audit_check': 'Review date is recorded.', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [rule], context)['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == ['Review Date: 1 populated value(s)']


def test_conditional_control_ignores_supporting_sheet_without_the_condition_column():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['VV'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'Medium',
        'detected_type': 'Unit Test Cases & Results',
    }
    test_register = {
        'sheet_name': 'Unit Tests', 'headers': ['Test ID', 'Status', 'Defect ID'],
        'rows': [['UT-1', 'Pass', '']], 'row_count': 1,
    }
    supporting_log = {
        'sheet_name': 'Defect Notes', 'headers': ['Defect ID', 'Comment'],
        'rows': [['', 'No defects were raised']], 'row_count': 1,
    }
    rule = {
        'rule_id': 'UT-10', 'practice_area': 'VV', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'condition': 'When test fails',
        'detection': 'Defect ID reference',
        'audit_check': 'Failed test cases have a linked defect ID.', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [rule], {
        **test_register, 'all_table_contexts': [test_register, supporting_log],
    })['results'][0]
    assert result['status'] == 'NOT_APPLICABLE'
    assert result['not_applicable_reason'] == 'condition_not_met'


def test_unmapped_master_field_is_confirmed_missing_but_narrative_control_stays_review_required():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'Medium',
        'detected_type': 'Change Log / FSD',
    }
    context = {'headers': ['Change ID', 'Approval Decision'], 'rows': [['CR-1', 'Approved']]}
    field_rule = {
        'rule_id': 'CR-17', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Decision + date',
        'audit_check': 'Approval date and decision are recorded.', 'gap_text': 'Missing',
    }
    field_result = validate_evidence('', classification, [field_rule], context)['results'][0]
    assert field_result['status'] == 'PARTIAL'
    assert field_result['found_evidence'] == ['Approval Decision: 1 populated value(s)']
    assert field_result['missing_evidence'] == ['No reliable column mapping for: date.']

    narrative_rule = {
        'rule_id': 'CR-04', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Business need and rationale text',
        'audit_check': 'Business justification is documented.', 'gap_text': 'Missing',
    }
    narrative_result = validate_evidence('', classification, [narrative_rule], context)['results'][0]
    assert narrative_result['status'] == 'REVIEW_REQUIRED'


def test_alternative_governed_reference_fields_do_not_create_a_false_gap():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['VV'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Unit Test Cases & Results',
    }
    rule = {
        'rule_id': 'UT-01', 'practice_area': 'VV', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Requirement/FSD/TSD/CR reference',
        'audit_check': 'Each test case links to its requirement, FSD, TSD, or change request.',
        'gap_text': 'Reference missing.',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Test ID', 'Change ID'], 'rows': [['UT-1', 'CR-44']],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == ['Change ID: 1 populated value(s)']


def test_custom_development_control_is_not_applicable_without_a_custom_trigger():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['EST'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Estimation sheet',
    }
    rule = {
        'rule_id': 'EST-04', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'condition': 'When custom development applies',
        'detection': 'Complexity rating', 'audit_check': 'Complexity is recorded for custom development.',
        'gap_text': 'Complexity missing.',
    }
    result = validate_evidence('Standard configuration estimate', classification, [rule], {
        'headers': ['Activity', 'Estimated Hours'], 'rows': [['Configuration', 8]],
    })['results'][0]
    assert result['status'] == 'NOT_APPLICABLE'
    assert result['not_applicable_reason'] == 'condition_not_met'


def test_governance_condition_with_missing_evidence_stays_a_review_not_a_confirmed_gap():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['EST'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Estimation sheet',
    }
    rule = {
        'rule_id': 'EST-17', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'condition': 'Where required by project governance',
        'detection': 'Approval date', 'audit_check': 'Approval date is recorded.',
        'gap_text': 'Approval missing.',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Activity', 'Estimated Hours'], 'rows': [['Build', 8]],
    })['results'][0]
    assert result['status'] == 'REVIEW_REQUIRED'
    assert result['missing_evidence'][0].startswith('Applicability requires auditor confirmation:')


def test_detection_specific_matching_rejects_a_related_but_wrong_header():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['EST'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'effort tracking',
    }
    rule = {
        'rule_id': 'EFF-06', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Variance threshold is defined.',
        'detection': 'Threshold definition', 'gap_text': 'Threshold is missing.',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Variance Hours', 'Variance %', 'Variance Reason'], 'rows': [[1, 5, 'Reviewed']],
    })['results'][0]
    assert result['status'] == 'REVIEW_REQUIRED'
    assert result['found_evidence'] == []
    assert result['missing_evidence'] == ['No reliable column mapping for this narrative or multi-field control.']


def test_multi_field_detection_maps_each_governed_header_independently():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['CAR'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'RCA',
    }
    rule = {
        'rule_id': 'RCA-12', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Corrective action has an owner and due date.',
        'detection': 'Corrective action + owner + due date', 'gap_text': 'Action tracking is incomplete.',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Corrective Action', 'Owner', 'Target Date'],
        'rows': [['Correct the issue', 'Asha', '2026-09-30']],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == [
        'Corrective Action: 1 populated value(s)',
        'Owner: 1 populated value(s)',
        'Target Date: 1 populated value(s)',
    ]


def test_semantic_header_profiles_match_equivalent_alpha_fsd_estimation_sla_and_tsd_fields():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Change Log / FSD',
    }
    scenarios = [
        (
            {'rule_id': 'FSD-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Doc ID / version field',
             'audit_check': 'Document ID and version number are present', 'gap_text': 'Missing'},
            ['FSD ID', 'Version'], [['FSD-001', '1.0']],
        ),
        (
            {'rule_id': 'FSD-12', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Acceptance condition statements',
             'audit_check': 'Acceptance criteria are defined', 'gap_text': 'Missing'},
            ['Acceptance Criteria'], [['AC-001']],
        ),
        (
            {'rule_id': 'EST-09', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Hours/person-days per activity',
             'audit_check': 'Planned effort is recorded for each activity', 'gap_text': 'Missing'},
            ['Planned Effort (Person-Days)'], [[2]],
        ),
        (
            {'rule_id': 'EST-04', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Complexity rating field (H/M/L) per object',
             'audit_check': 'Complexity is assigned to each object', 'gap_text': 'Missing'},
            ['Complexity'], [['Medium']],
        ),
        (
            {'rule_id': 'SLA-01', 'practice_area': 'SDM', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Target table by priority',
             'audit_check': 'Response time SLA targets are defined per priority', 'gap_text': 'Missing'},
            ['Priority', 'Response Target (Minutes)'], [['P1', 30]],
        ),
        (
            {'rule_id': 'SLA-05', 'practice_area': 'SDM', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Met/Breached flag',
             'audit_check': 'Met/Breached status is recorded per incident', 'gap_text': 'Missing'},
            ['Achievement'], [['Met']],
        ),
        (
            {'rule_id': 'TSD-01', 'practice_area': 'TS', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Doc ID + CR/FSD reference',
             'audit_check': 'Document ID/version and linked FSD/CR reference are present', 'gap_text': 'Missing'},
            ['Impact ID', 'Change ID', 'Requirement ID'], [['IA-001', 'CR-001', 'REQ-101']],
        ),
        (
            {'rule_id': 'TSD-01', 'practice_area': 'TS', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Doc ID + CR/FSD reference',
             'audit_check': 'Document ID/version and linked FSD/CR reference are present', 'gap_text': 'Missing'},
            ['TSD ID', 'Change ID', 'Requirement ID'], [['TSD-001', 'CR-001', 'REQ-101']],
        ),
        (
            {'rule_id': 'TSD-06', 'practice_area': 'TS', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Design narrative/architecture',
             'audit_check': 'Technical solution / design approach is documented', 'gap_text': 'Missing'},
            ['Technical Design'], [['Use existing application architecture.']],
        ),
        (
            {'rule_id': 'RCA-02', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Incident-to-RCA reference',
             'audit_check': 'RCA is available for each qualifying incident', 'gap_text': 'Missing'},
            ['RCA ID', 'Incident ID'], [['RCA-001', 'INC-201']],
        ),
        (
            {'rule_id': 'RCA-04', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Problem description',
             'audit_check': 'Problem statement is documented', 'gap_text': 'Missing'},
            ['Problem Statement'], [['Service issue affecting the customer']],
        ),
        (
            {'rule_id': 'RCA-07', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Method named',
             'audit_check': 'Root cause analysis method used is stated', 'gap_text': 'Missing'},
            ['5 Why Completed'], [['Yes']],
        ),
        (
            {'rule_id': 'FSD-05', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Numbered FR statements',
             'audit_check': 'Functional requirements are individually numbered/traceable', 'gap_text': 'Missing'},
            ['Requirement ID', 'Functional Requirement', 'Traceability'], [['REQ-001', 'The system shall...', 'Yes']],
        ),
        (
            {'rule_id': 'UT-06', 'practice_area': 'VV', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Expected outcome statement',
             'audit_check': 'Expected result is defined', 'gap_text': 'Missing'},
            ['Expected Result'], [['As specified in FSD']],
        ),
        (
            {'rule_id': 'UT-07', 'practice_area': 'VV', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Actual outcome statement',
             'audit_check': 'Actual result is recorded', 'gap_text': 'Missing'},
            ['Actual Result'], [['As expected']],
        ),
        (
            {'rule_id': 'DEF-02', 'practice_area': 'VV', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Descriptive text',
             'audit_check': 'Defect description clearly explains the issue', 'gap_text': 'Missing'},
            ['Defect Description'], [['Validation issue in a module']],
        ),
        (
            {'rule_id': 'CRV-08', 'practice_area': 'PR', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Defect count',
             'audit_check': 'Total review findings are stated', 'gap_text': 'Missing'},
            ['Findings', 'Finding IDs'], [[1, None]],
        ),
        (
            {'rule_id': 'SIT-06', 'practice_area': 'VV', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Expected outcome',
             'audit_check': 'Expected result is defined', 'gap_text': 'Missing'},
            ['Expected Result'], [['Expected behaviour']],
        ),
        (
            {'rule_id': 'DEF-03', 'practice_area': 'VV', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Test case ID reference',
             'audit_check': 'Source test case is recorded', 'gap_text': 'Missing'},
            ['Test ID'], [['TC-001']],
        ),
        (
            {'rule_id': 'TR-01', 'practice_area': 'TS', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'TR number',
             'audit_check': 'Unique transport request number is recorded', 'gap_text': 'Missing'},
            ['Transport ID'], [['TR-001']],
        ),
        (
            {'rule_id': 'TR-02', 'practice_area': 'TS', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'CR/FSD reference',
             'audit_check': 'Transport is linked to an approved change', 'gap_text': 'Missing'},
            ['Change ID'], [['CR-001']],
        ),
        (
            {'rule_id': 'CAM-02', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Source record ID',
             'audit_check': 'Source reference is identified', 'gap_text': 'Missing'},
            ['Incident ID'], [['INC-001']],
        ),
        (
            {'rule_id': 'CAM-06', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
             'document_type_rule_id': 101, 'detection': 'Preventive action text',
             'audit_check': 'Preventive action is defined', 'gap_text': 'Missing'},
            ['Preventive Action'], [['Update monitoring process']],
        ),
    ]
    for rule, headers, rows in scenarios:
        result = validate_evidence('', {**classification, 'practice_areas': [rule['practice_area']]}, [rule], {
            'headers': headers, 'rows': rows,
        })['results'][0]
        assert result['status'] == 'FOUND', rule['rule_id']


def test_change_status_control_excludes_related_impact_and_approval_statuses():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Change Log / FSD', 'artifact_scope': 'CHANGE_LOG',
    }
    rule = {
        'rule_id': 'CR-18', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Status field',
        'audit_check': 'CR status is tracked and current', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Impact Status', 'Approval Status', 'Status'],
        'rows': [['Completed', 'Approved', 'Closed'], ['', 'Approved', 'Closed']],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == ['Status: 2 populated value(s)']


def test_rca_five_why_requires_an_affirmative_completion_value():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['CAR'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'RCA',
    }
    rule = {
        'rule_id': 'RCA-07', 'practice_area': 'CAR', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Method named',
        'audit_check': 'Root cause analysis method used is stated', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['5 Why Completed'], 'rows': [['No']],
    })['results'][0]
    assert result['status'] == 'MISSING'
    assert result['found_evidence'] == []
    assert result['missing_evidence'] == ['5 Why Completed: no affirmative value(s)']


def test_complexity_and_review_count_profiles_reject_invalid_values_and_lookalike_headers():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['EST'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
    }
    complexity = {
        'rule_id': 'EST-04', 'practice_area': 'EST', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Complexity rating field (H/M/L) per object',
        'audit_check': 'Complexity is assigned', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [complexity], {
        'headers': ['Complexity'], 'rows': [['TBD']],
    })['results'][0]
    assert result['status'] == 'MISSING'
    assert result['missing_evidence'] == ['Complexity: invalid value(s) outside allowed values']

    review_count = {
        'rule_id': 'CRV-08', 'practice_area': 'PR', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Defect count',
        'audit_check': 'Total review findings are stated', 'gap_text': 'Missing',
    }
    result = validate_evidence('', {**classification, 'practice_areas': ['PR']}, [review_count], {
        'headers': ['Finding Description'], 'rows': [['Formatting issue']],
    })['results'][0]
    assert result['status'] == 'MISSING'

    result = validate_evidence('', {**classification, 'practice_areas': ['PR']}, [review_count], {
        'headers': ['Findings'], 'rows': [['one']],
    })['results'][0]
    assert result['status'] == 'MISSING'
    assert result['missing_evidence'] == ['Findings: non-numeric value(s)']


def test_irp_profiles_use_issue_register_fields_and_enforce_unique_issue_ids():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['IRP'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Incident Log – 2 Months',
    }
    resolution = {
        'rule_id': 'INC-10', 'practice_area': 'IRP', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Resolution narrative',
        'audit_check': 'Resolution description is recorded', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [resolution], {
        'headers': ['Final Resolution', 'Major Issue & Resolution Report Template link.'],
        'rows': [['Resolved by restart', None]],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['found_evidence'] == ['Final Resolution: 1 populated value(s)']

    identifier = {
        'rule_id': 'INC-02', 'practice_area': 'IRP', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'detection': 'Incident ID',
        'audit_check': 'Unique Incident ID is assigned', 'gap_text': 'Missing',
    }
    result = validate_evidence('', classification, [identifier], {
        'headers': ['Issue ID'], 'rows': [['ISS-1'], ['ISS-1']],
    })['results'][0]
    assert result['status'] == 'MISSING'
    assert 'duplicate value(s) ISS-1' in result['missing_evidence'][0]


def test_unique_change_id_control_does_not_treat_repeated_requirement_ids_as_duplicate_changes():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Change Log / FSD',
    }
    rule = {
        'rule_id': 'CR-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Unique Change Request ID is assigned.',
        'detection': 'Unique CR number pattern', 'gap_text': 'Change Request ID is missing.',
    }
    table = {
        'headers': ['Change ID', 'Requirement ID'],
        'rows': [['CR-1', 'REQ-1'], ['CR-2', 'REQ-1']],
    }
    result = validate_evidence('', classification, [rule], table)['results'][0]
    assert result['status'] == 'FOUND'
    assert all('Requirement ID' not in item for item in result['found_evidence'])


def test_unique_review_detection_does_not_treat_not_reused_as_a_column_name():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['PR'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'code review records and defects',
    }
    rule = {
        'rule_id': 'CRV-01', 'practice_area': 'PR', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101,
        'audit_check': 'Unique Code Review ID is assigned to every review session.',
        'detection': 'Unique review ID pattern, not reused',
        'gap_text': 'Review ID is missing or reused.',
    }
    result = validate_evidence('', classification, [rule], {
        'headers': ['Review ID'], 'rows': [['REV-1'], ['REV-2']],
    })['results'][0]
    assert result['status'] == 'FOUND'
    assert result['missing_evidence'] == []
    assert result['found_evidence'] == [
        'Review ID: 2 populated value(s)', 'Review ID: values are unique',
    ]


def test_project_summary_does_not_allow_a_passing_file_to_mask_a_duplicate_in_another_file():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Change Log / FSD',
    }
    rule = {
        'rule_id': 'CR-01', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Unique Change Request ID is assigned.',
        'detection': 'Unique CR number pattern', 'gap_text': 'Change Request ID is missing.',
    }
    valid = validate_evidence('', {**classification, 'original_file_name': 'project-1.xlsx'}, [rule], {
        'headers': ['Change ID'], 'rows': [['CR-1'], ['CR-2']],
    })
    duplicate = validate_evidence('', {**classification, 'original_file_name': 'project-2.xlsx'}, [rule], {
        'headers': ['Change ID'], 'rows': [['CR-3'], ['CR-3']],
    })
    report = generate_gap_report([valid, duplicate], [rule])
    outcome = report['rule_results'][0]
    assert outcome['status'] == 'MISSING'
    assert outcome['files'] == ['project-1.xlsx', 'project-2.xlsx']


def test_sap_narrative_control_without_a_safe_header_mapping_requires_review():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'change request log/FSD',
    }
    rule = {
        'rule_id': 'CR-04', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Business justification is documented.',
        'detection': 'Business need and rationale text', 'gap_text': 'Business justification is missing.',
    }
    result = validate_evidence('', classification, [rule], {'headers': ['Change ID', 'Status'], 'rows': [['CR-1', 'Open']]})['results'][0]
    assert result['status'] == 'REVIEW_REQUIRED'


def test_change_date_cannot_be_reused_as_a_target_or_closure_date():
    classification = {
        'document_type_rule_id': 101, 'practice_areas': ['RDM'],
        'document_role': 'PROJECT_IMPLEMENTATION_EVIDENCE', 'confidence': 'High',
        'detected_type': 'Change Log / FSD', 'artifact_scope': 'CHANGE_LOG',
    }
    rule = {
        'rule_id': 'CR-19', 'practice_area': 'RDM', 'level': 'L3-Check', 'is_gate': False,
        'document_type_rule_id': 101, 'audit_check': 'Closure date is recorded when status is Closed.',
        'detection': 'Closure date', 'gap_text': 'Closure date is missing.',
    }
    result = validate_evidence('Status: Closed', classification, [rule], {
        'headers': ['Change ID', 'Change Date', 'Status'], 'rows': [['CR-1', '2026-09-01', 'Closed']],
    })['results'][0]
    assert result['status'] == 'MISSING'
