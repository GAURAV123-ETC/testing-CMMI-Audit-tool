from types import SimpleNamespace
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.models import AuditSession, Comment, Finding, RemediationAction
from app.services.reports import afr_report, finding_export


def test_current_findings_export_contains_only_open_selected_session_findings(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(finding_export, 'get_settings', lambda: SimpleNamespace(output_dir=tmp_path))
    with factory() as db:
        db.add_all([
            AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1),
            AuditSession(id=2, project_id=2, checklist_version_id=1, created_by_id=1),
            Finding(audit_session_id=1, rule_id='PLAN-G1', practice_area_code='PLAN', severity='major',
                    title='=Plan missing', description='No approved plan.', recommendation='Upload the plan.', status='open'),
            Finding(audit_session_id=1, rule_id='PLAN-2', practice_area_code='PLAN', severity='minor',
                    title='Old result', description='Superseded.', recommendation='Ignore.', status='superseded'),
            Finding(audit_session_id=2, rule_id='RSK-G1', practice_area_code='RSK', severity='major',
                    title='Other session', description='Other.', recommendation='Other.', status='open'),
        ])
        db.commit()
        csv_report = finding_export.create_current_findings_export(db, 1, 1, 'csv')
        xlsx_report = finding_export.create_current_findings_export(db, 1, 1, 'xlsx')
        csv_path = csv_report.storage_path
        xlsx_path = xlsx_report.storage_path

    csv_content = Path(csv_path).read_text(encoding='utf-8-sig')
    assert 'PLAN-G1' in csv_content
    assert "'=Plan missing" in csv_content
    assert 'PLAN-2' not in csv_content
    assert 'RSK-G1' not in csv_content
    assert xlsx_path.endswith('.xlsx')


def test_afr_bulk_loads_comments_and_remediation_actions(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(afr_report, 'get_settings', lambda: SimpleNamespace(output_dir=tmp_path))
    with factory() as db:
        db.add(AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1))
        db.flush()
        finding = Finding(
            audit_session_id=1,
            rule_id='PLAN-G1',
            practice_area_code='PLAN',
            severity='major',
            title='Plan missing',
            description='No approved plan.',
            recommendation='Upload the plan.',
            status='open',
        )
        db.add(finding)
        db.flush()
        db.add_all([
            Comment(finding_id=finding.id, author_id=1, body='Reviewed by auditor.'),
            RemediationAction(finding_id=finding.id, action='Publish the approved plan.', status='open'),
        ])
        db.commit()
        report = afr_report.create_afr(db, 1, 1, 'xlsx')

    from openpyxl import load_workbook
    worksheet = load_workbook(report.storage_path, read_only=True)['Detailed Findings']
    row = next(worksheet.iter_rows(min_row=2, values_only=True))
    assert row[8] == 'Reviewed by auditor.'
    assert row[9] == 'open: Publish the approved plan.'
