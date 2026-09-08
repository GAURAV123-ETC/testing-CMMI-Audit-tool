from openpyxl import Workbook

from app.services.audit_engine.evidence_validation import classify_document
from app.services.audit_engine.header_matching import match_fields_exclusive
from app.services.audit_engine.risk_sla_validation import validate_risk_sla
from app.services.audit_engine.risk_sla_validation import FIELDS
from app.services.document_processing.extractors import extract_text


def test_risk_validator_selects_later_worksheet_and_real_header_row(tmp_path):
    source = tmp_path / 'customer-risk-register.xlsx'
    workbook = Workbook()
    revision = workbook.active
    revision.title = 'Revision History'
    revision.append(['Version', 'Date', 'Description'])
    revision.append([1, '2026-01-01', 'Initial release'])
    register = workbook.create_sheet('Risk Log')
    register.append(['Risk Log'])
    register.append(['ID#', 'Risk Level', 'Status', 'Date Identified', 'Date of Actual Closure', 'Remarks'])
    register.append(['RISK-1', 'High', 'Closed', '2026-01-01', '2026-01-03', ''])
    workbook.save(source)

    findings = validate_risk_sla(str(source))

    assert [item['rule_id'] for item in findings] == ['IRP-RISK-SLA', 'IRP-RISK-SLA-REASON']


def test_excel_extraction_includes_later_worksheets(tmp_path):
    source = tmp_path / 'traceability.xlsx'
    workbook = Workbook()
    workbook.active.title = 'Revision History'
    workbook.active.append(['Version', 'Date'])
    evidence = workbook.create_sheet('BRTM')
    evidence.append(['Requirement ID', 'System Test Cases'])
    evidence.append(['REQ-1', 'TC-1'])
    workbook.save(source)

    text = extract_text(str(source))

    assert '[Sheet: BRTM]' in text
    assert 'Requirement ID' in text


def test_risk_validator_accepts_date_resolved_header(tmp_path):
    source = tmp_path / 'issue-log.csv'
    source.write_text(
        'Issue ID,Priority,Status,Date Raised,Date Resolved\n'
        'ISSUE-1,High,Closed,2026-01-01,2026-01-03\n', encoding='utf-8'
    )

    findings = validate_risk_sla(str(source))

    assert not [item for item in findings if item['rule_id'] == 'IRP-RISK-SLA-HEADER']


def test_later_header_is_found_after_large_leading_blank_area(tmp_path):
    source = tmp_path / 'spaced-risk-register.xlsx'
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Risk Log'
    sheet.cell(251, 1, 'Issue ID')
    sheet.cell(251, 2, 'Priority')
    sheet.cell(251, 3, 'Status')
    sheet.cell(251, 4, 'Date Raised')
    sheet.cell(251, 5, 'Date Resolved')
    sheet.append(['RISK-1', 'High', 'Closed', '2026-01-01', '2026-01-03'])
    workbook.save(source)

    findings = validate_risk_sla(str(source))

    assert not [item for item in findings if item['rule_id'] == 'IRP-RISK-SLA-HEADER']


def test_formula_text_is_preserved_for_document_classification(tmp_path):
    source = tmp_path / 'formula-evidence.xlsx'
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(['Requirement ID', 'Approval'])
    sheet.append(['REQ-1', '=CONCAT("approved", " baseline")'])
    workbook.save(source)

    text = extract_text(str(source))

    assert 'CONCAT' in text


def test_fuzzy_matching_does_not_treat_resolution_as_a_closure_date():
    matched = match_fields_exclusive(['Resolution'], FIELDS)

    assert matched['closed'] is None


def test_detailed_srs_with_template_language_remains_implementation_evidence():
    result = classify_document(
        'Project scope stakeholders priority version requirements are approved. This template contains an example.',
        'Agriculture_SRS.docx',
    )

    assert result['detected_type'] == 'BRD / SRS / Requirements Specification/RFP'
    assert result['document_role'] == 'PROJECT_IMPLEMENTATION_EVIDENCE'
