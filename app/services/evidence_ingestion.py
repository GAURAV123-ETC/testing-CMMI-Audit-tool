"""Shared persistence for local and remote audit evidence."""
from io import BytesIO
import hashlib
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.validators import ALLOWED_EXTENSIONS, safe_filename, validate_evidence_content
from app.db.models import (AuditProject, AuditSession, AuditSessionPracticeArea,
                           ChecklistVersion, EvidenceFile, EvidenceSource,
                           Customer, PracticeArea)


def _safe_archive_members(name: str, body: bytes) -> list[tuple[str, bytes]]:
    """Validate every ZIP member before any evidence is written to disk."""
    members: list[tuple[str, bytes]] = []
    with zipfile.ZipFile(BytesIO(body)) as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue
            normalized = member.filename.replace('\\', '/')
            parts = PurePosixPath(normalized).parts
            if not parts or PurePosixPath(normalized).is_absolute() or '..' in parts:
                raise ValueError('ZIP archive contains an unsafe file path.')
            safe_name = safe_filename(PurePosixPath(normalized).name)
            suffix = Path(safe_name).suffix.lower()
            if suffix not in ALLOWED_EXTENSIONS or suffix == '.zip':
                raise ValueError(f'Unsupported file in ZIP archive: {safe_name}')
            members.append(('/'.join(parts), archive.read(member)))
    if not members:
        raise ValueError('ZIP archive does not contain any evidence files.')
    return members


def _add_evidence_files(db: Session, audit_session_id: int, user_id: int,
                        source_type: str, source_uri: str | None,
                        files: list[tuple[str, bytes]], mime_type: str | None = None) -> int:
    """Persist already-validated evidence with its relative paths intact."""
    settings = get_settings()
    target = settings.upload_dir / str(audit_session_id)
    target.mkdir(parents=True, exist_ok=True)
    source = EvidenceSource(audit_session_id=audit_session_id, source_type=source_type,
                            source_uri=source_uri, created_by_id=user_id)
    db.add(source)
    db.flush()
    for relative_path, data in files:
        safe_name = safe_filename(PurePosixPath(relative_path).name)
        stored = target / f'{uuid.uuid4().hex}_{safe_name}'
        stored.write_bytes(data)
        db.add(EvidenceFile(
            source_id=source.id, relative_path=relative_path,
            storage_path=str(stored.relative_to(settings.upload_dir.parent)),
            sha256=hashlib.sha256(data).hexdigest(), mime_type=mime_type,
            size_bytes=len(data),
        ))
    return len(files)


def persist_uploaded_evidence(db: Session, audit_session_id: int, user_id: int,
                              filename: str, content: bytes, mime_type: str | None,
                              source_type: str = 'upload') -> int:
    """Persist a user upload and safely expand a ZIP into scanable evidence files.

    A ZIP is accepted by the UI as a convenient way to upload a project folder.
    Saving only the archive would make the later scanner report it as an unsupported
    document, so archive members are stored as individual evidence records instead.
    """
    settings = get_settings()
    name, body = validate_evidence_content(filename, content, settings.max_upload_mb * 1024 * 1024)
    if Path(name).suffix.lower() != '.zip':
        return _add_evidence_files(db, audit_session_id, user_id, source_type, None, [(name, body)], mime_type)
    members = _safe_archive_members(name, body)
    return _add_evidence_files(db, audit_session_id, user_id, source_type, name,
                               [(f'{name}/{path}', data) for path, data in members], mime_type)


def import_parent_folder_archive(db: Session, customer_id: int, user_id: int,
                                 filename: str, content: bytes, mime_type: str | None = None) -> list[dict]:
    """Port the legacy parent-folder scan into persisted project/session imports.

    The archive must contain one top-level folder per project. Each folder gets
    a project (reused by name when it already exists), a fresh audit session,
    all governed practice areas, and evidence retaining its path below that
    project. ZIP is used because browsers do not reliably transmit folder
    relative paths through ordinary multipart folder uploads.
    """
    settings = get_settings()
    name, body = validate_evidence_content(filename, content, settings.max_upload_mb * 1024 * 1024)
    if Path(name).suffix.lower() != '.zip':
        raise ValueError('Upload a ZIP archive containing one top-level folder per project.')
    members = _safe_archive_members(name, body)
    paths = [(PurePosixPath(path).parts, data) for path, data in members]
    if not db.get(Customer, customer_id):
        raise ValueError('Selected customer no longer exists.')
    roots = {parts[0] for parts, _ in paths if len(parts) >= 2}
    if len(roots) < 2 or any(len(parts) < 2 for parts, _ in paths):
        raise ValueError(
            'Bulk project import requires at least two top-level project folders. '
            'For one selected project, use the regular evidence files / project ZIP upload instead.'
        )
    groups: dict[str, list[tuple[str, bytes]]] = {}
    for parts, data in paths:
        project_name = parts[0].strip()
        relative_path = '/'.join(parts[1:])
        if not project_name or not relative_path:
            raise ValueError('A project folder name cannot be empty.')
        groups.setdefault(project_name, []).append((relative_path, data))
    checklist = db.query(ChecklistVersion).filter(ChecklistVersion.is_active.is_(True)).order_by(ChecklistVersion.id.desc()).first()
    if not checklist:
        raise ValueError('No active checklist version is available. Initialise the database before importing evidence.')
    practice_area_ids = [row.id for row in db.query(PracticeArea).all()]
    if not practice_area_ids:
        raise ValueError('No practice areas are available. Initialise the database before importing evidence.')
    created: list[dict] = []
    for project_name, project_files in sorted(groups.items()):
        project = db.query(AuditProject).filter(AuditProject.customer_id == customer_id, AuditProject.name == project_name).first()
        if not project:
            project = AuditProject(customer_id=customer_id, name=project_name, owner_id=user_id)
            db.add(project)
            db.flush()
        audit = AuditSession(project_id=project.id, checklist_version_id=checklist.id,
                             audit_name='Evidence Scan (automatic)', created_by_id=user_id)
        db.add(audit)
        db.flush()
        db.add_all([AuditSessionPracticeArea(audit_session_id=audit.id, practice_area_id=practice_area_id)
                    for practice_area_id in practice_area_ids])
        count = _add_evidence_files(db, audit.id, user_id, 'parent_folder_archive', name, project_files, mime_type)
        created.append({'project_id': project.id, 'project_name': project_name, 'audit_session_id': audit.id, 'files_imported': count})
    return created


def persist_remote_evidence(db: Session, audit_session_id: int, user_id: int, source_type: str,
                            source_uri: str, artifacts: list[tuple[str, bytes]]) -> int:
    """Persist validated remote artifacts, retaining their safe relative paths."""
    settings = get_settings()
    target = settings.upload_dir / str(audit_session_id)
    target.mkdir(parents=True, exist_ok=True)
    source = EvidenceSource(audit_session_id=audit_session_id, source_type=source_type,
                            source_uri=source_uri[:2048], created_by_id=user_id)
    db.add(source)
    db.flush()
    count = 0
    for remote_path, content in artifacts:
        parts = PurePosixPath(remote_path).parts
        if not parts or PurePosixPath(remote_path).is_absolute() or '..' in parts:
            raise ValueError('Remote evidence path contains an unsafe parent-directory segment.')
        filename, body = validate_evidence_content(PurePosixPath(remote_path).name, content,
                                                   settings.max_upload_mb * 1024 * 1024)
        stored = target / f'{uuid.uuid4().hex}_{filename}'
        stored.write_bytes(body)
        db.add(EvidenceFile(source_id=source.id, relative_path='/'.join(parts),
                            storage_path=str(stored.relative_to(settings.upload_dir.parent)),
                            sha256=hashlib.sha256(body).hexdigest(), mime_type=None, size_bytes=len(body)))
        count += 1
    return count
