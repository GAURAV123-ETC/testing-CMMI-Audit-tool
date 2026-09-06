from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.database import Base
from app.db.models import AuditSession, Finding
from app.services.reports.afr_report import create_gap_report


def test_gap_report_creates_persisted_xlsx_from_filtered_findings(tmp_path, monkeypatch):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    monkeypatch.setattr(get_settings(), 'output_dir', tmp_path)
    with Session(engine) as db:
        audit = AuditSession(project_id=1, checklist_version_id=1, created_by_id=1, audit_name='Internal Audit')
        db.add(audit); db.flush()
        db.add(Finding(audit_session_id=audit.id, rule_id='RSK-001', practice_area_code='RSK', severity='major',
                       title='Risk evidence incomplete', description='Missing risk review evidence.', recommendation='Upload the review.'))
        db.commit()

        report = create_gap_report(db, audit.id, user_id=1, fmt='xlsx', practice_area_codes=['RSK'])

    assert report.report_type == 'gap_xlsx'
    assert report.storage_path.endswith('.xlsx')
    assert (tmp_path / report.storage_path.split('\\')[-1]).exists()
