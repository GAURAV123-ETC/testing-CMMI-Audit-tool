from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.models import (AuditProject, AuditSession, ChecklistVersion, Customer,
                           EvidenceFile, EvidenceSource, PracticeArea)
from app.gui.pages.evidence_scan import AUTO_SESSION_NAME, _ensure_scan_session


def test_ruleset_change_creates_internal_run_and_reuses_project_evidence():
    engine=create_engine('sqlite://'); Base.metadata.create_all(engine); factory=sessionmaker(bind=engine)
    with factory() as db:
        db.add(Customer(id=1,name='Customer'))
        db.add(AuditProject(id=1,customer_id=1,name='Project',owner_id=1))
        db.add(PracticeArea(id=1,code='RSK',name='Risk'))
        db.add_all([
            ChecklistVersion(id=1,version='v1',source='old',checksum='1'*64,status='RETIRED',is_active=False),
            ChecklistVersion(id=2,version='v2',source='new',checksum='2'*64,status='ACTIVE',is_active=True),
        ])
        old=AuditSession(id=1,project_id=1,checklist_version_id=1,audit_name=AUTO_SESSION_NAME,created_by_id=1)
        db.add(old); source=EvidenceSource(id=1,audit_session_id=1,source_type='upload',created_by_id=1); db.add(source)
        db.add(EvidenceFile(source_id=1,relative_path='RSK/risk.xlsx',storage_path='uploads/1/risk.xlsx',sha256='a'*64,size_bytes=10))
        db.commit()
        current=_ensure_scan_session(db,1,1); db.commit()
        cloned=db.scalar(select(EvidenceFile).join(EvidenceSource).where(EvidenceSource.audit_session_id==current.id))
        assert current.audit_name == AUTO_SESSION_NAME and current.checklist_version_id == 2
        assert cloned.relative_path == 'RSK/risk.xlsx' and cloned.storage_path == 'uploads/1/risk.xlsx'
