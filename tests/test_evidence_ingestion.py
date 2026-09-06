from io import BytesIO
import zipfile

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.models import AuditSession, EvidenceFile
from app.services import evidence_ingestion


def test_project_zip_is_expanded_to_scanable_evidence(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    class Settings:
        upload_dir = tmp_path / 'uploads'
        max_upload_mb = 10

    monkeypatch.setattr(evidence_ingestion, 'get_settings', lambda: Settings())
    archive = BytesIO()
    with zipfile.ZipFile(archive, 'w') as zip_file:
        zip_file.writestr('Project Alpha/plan.md', 'approved mitigation plan')
        zip_file.writestr('Project Alpha/evidence.csv', 'ID,Status\n1,Closed\n')

    with session_factory() as db:
        db.add(AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1))
        db.commit()
        assert evidence_ingestion.persist_uploaded_evidence(
            db, 1, 1, 'Project Alpha.zip', archive.getvalue(), 'application/zip'
        ) == 2
        db.commit()
        files = db.scalars(select(EvidenceFile).order_by(EvidenceFile.relative_path)).all()

    assert [file.relative_path for file in files] == [
        'Project Alpha.zip/Project Alpha/evidence.csv',
        'Project Alpha.zip/Project Alpha/plan.md',
    ]
    assert all((tmp_path / file.storage_path).exists() for file in files)
