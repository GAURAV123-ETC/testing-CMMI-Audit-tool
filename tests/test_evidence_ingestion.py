from io import BytesIO
import zipfile
import pytest

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.models import AuditSession, EvidenceFile, EvidenceSource, ScanJob
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
        outcome = evidence_ingestion.persist_uploaded_evidence(
            db, 1, 1, 'Project Alpha.zip', archive.getvalue(), 'application/zip'
        )
        assert outcome.files_persisted == 2
        assert outcome.duplicates_skipped == 0
        db.commit()
        files = db.scalars(select(EvidenceFile).order_by(EvidenceFile.relative_path)).all()

    assert [file.relative_path for file in files] == [
        'Project Alpha.zip/Project Alpha/evidence.csv',
        'Project Alpha.zip/Project Alpha/plan.md',
    ]
    assert all((tmp_path / file.storage_path).exists() for file in files)


def test_session_upload_skips_exact_duplicates_and_replacement_preserves_history(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    class Settings:
        upload_dir = tmp_path / 'uploads'
        max_upload_mb = 10

    monkeypatch.setattr(evidence_ingestion, 'get_settings', lambda: Settings())
    with session_factory() as db:
        db.add(AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1))
        db.commit()
        first = evidence_ingestion.persist_uploaded_evidence(db, 1, 1, 'legacy.doc', b'old legacy content', None)
        repeated = evidence_ingestion.persist_uploaded_evidence(db, 1, 1, 'copy.doc', b'old legacy content', None)
        db.commit()
        original = db.get(EvidenceFile, first.evidence_file_ids[0])
        original.processing_status = 'error'
        # Simulate a historical duplicate from before SHA deduplication existed.
        source = EvidenceSource(audit_session_id=1, source_type='legacy', created_by_id=1)
        db.add(source); db.flush()
        duplicate = EvidenceFile(source_id=source.id, relative_path='old-copy.doc', storage_path='uploads/1/old-copy.doc',
                                 sha256=original.sha256, size_bytes=original.size_bytes, processing_status='error')
        db.add(duplicate); db.commit()

        assert first.files_persisted == 1
        assert repeated.files_persisted == 0
        assert repeated.duplicates_skipped == 1
        assert evidence_ingestion.mark_session_duplicate_evidence(db, 1) == 1
        db.refresh(duplicate)
        assert duplicate.processing_status == 'duplicate'

        replacement = evidence_ingestion.replace_unreadable_evidence(
            db, original.id, 1, 'corrected.md', b'approved corrected evidence', 'text/markdown'
        )
        db.commit()
        db.refresh(original)

    assert replacement.files_persisted == 1
    assert original.processing_status == 'replaced'
    assert original.classification_json['replacement_evidence_file_id'] == replacement.evidence_file_ids[0]


def test_zip_members_with_identical_content_but_distinct_paths_are_retained(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    class Settings:
        upload_dir = tmp_path / 'uploads'
        max_upload_mb = 10

    monkeypatch.setattr(evidence_ingestion, 'get_settings', lambda: Settings())
    archive = BytesIO()
    with zipfile.ZipFile(archive, 'w') as zip_file:
        zip_file.writestr('Project/Evidence/approved.txt', 'same approved evidence')
        zip_file.writestr('Project/Archive/approved.txt', 'same approved evidence')

    with session_factory() as db:
        db.add(AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1))
        db.commit()
        outcome = evidence_ingestion.persist_uploaded_evidence(
            db, 1, 1, 'Project.zip', archive.getvalue(), 'application/zip'
        )
        db.commit()
        files = db.scalars(select(EvidenceFile).order_by(EvidenceFile.relative_path)).all()
        assert outcome.files_persisted == 2
        assert outcome.duplicates_skipped == 0
        assert len(files) == 2
        assert evidence_ingestion.mark_session_duplicate_evidence(db, 1) == 0


def test_folder_upload_retains_paths_and_uses_the_same_safe_zip_expansion(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    class Settings:
        upload_dir = tmp_path / 'uploads'
        max_upload_mb = 10

    monkeypatch.setattr(evidence_ingestion, 'get_settings', lambda: Settings())
    archive = BytesIO()
    with zipfile.ZipFile(archive, 'w') as zip_file:
        zip_file.writestr('Nested/meeting-notes.md', 'approved evidence from archive')

    with session_factory() as db:
        db.add(AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1))
        db.commit()
        outcome = evidence_ingestion.persist_uploaded_folder_evidence(
            db, 1, 1,
            [
                ('Project Alpha/Plans/approved.md', 'approved.md', b'same approved evidence', 'text/markdown'),
                ('Project Alpha/Archive/approved.md', 'approved.md', b'same approved evidence', 'text/markdown'),
                ('Project Alpha/Packages/evidence.zip', 'evidence.zip', archive.getvalue(), 'application/zip'),
            ],
        )
        db.commit()
        files = db.scalars(select(EvidenceFile).order_by(EvidenceFile.relative_path)).all()
        source = db.scalar(select(EvidenceSource))

    assert outcome.files_persisted == 3
    assert outcome.duplicates_skipped == 0
    assert [file.relative_path for file in files] == [
        'Project Alpha/Archive/approved.md',
        'Project Alpha/Packages/evidence.zip/Nested/meeting-notes.md',
        'Project Alpha/Plans/approved.md',
    ]
    assert source.source_uri == 'folder:Project Alpha'
    assert all((tmp_path / file.storage_path).exists() for file in files)
    assert [file.mime_type for file in files] == [
        'text/markdown',
        'application/zip',
        'text/markdown',
    ]


def test_folder_upload_rejects_path_traversal_before_writing_files(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    class Settings:
        upload_dir = tmp_path / 'uploads'
        max_upload_mb = 10

    monkeypatch.setattr(evidence_ingestion, 'get_settings', lambda: Settings())
    with session_factory() as db:
        db.add(AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1))
        db.commit()
        with pytest.raises(ValueError, match='unsafe file path'):
            evidence_ingestion.persist_uploaded_folder_evidence(
                db, 1, 1, [('../outside.md', 'outside.md', b'not allowed', 'text/markdown')],
            )
        assert db.scalars(select(EvidenceFile)).all() == []


def test_evidence_upload_is_rejected_while_the_session_scan_is_running(monkeypatch, tmp_path):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    class Settings:
        upload_dir = tmp_path / 'uploads'
        max_upload_mb = 10

    monkeypatch.setattr(evidence_ingestion, 'get_settings', lambda: Settings())
    with session_factory() as db:
        db.add_all([
            AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1),
            ScanJob(audit_session_id=1, job_type='master_rule_and_irp_scan', status='running'),
        ])
        db.commit()
        with pytest.raises(ValueError, match='scan is running'):
            evidence_ingestion.persist_uploaded_evidence(db, 1, 1, 'new.md', b'new evidence', 'text/markdown')


def test_zip_evidence_rejects_a_high_compression_member_before_expansion():
    archive = BytesIO()
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zip_file:
        zip_file.writestr('Project Alpha/evidence.md', b'A' * (2 * 1024 * 1024))

    with pytest.raises(ValueError, match='compression ratio'):
        evidence_ingestion._safe_archive_members('Project Alpha.zip', archive.getvalue())
