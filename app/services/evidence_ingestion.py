"""Shared persistence for local audit evidence."""
from io import BytesIO
from dataclasses import dataclass
import hashlib
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.validators import ALLOWED_EXTENSIONS, safe_filename, validate_evidence_content
from app.services.document_processing.file_security import validate_zip
from app.db.models import (AuditProject, AuditSession, AuditSessionPracticeArea,
                           ChecklistVersion, EvidenceFile, EvidenceSource,
                           Customer, PracticeArea, ScanJob)


INACTIVE_EVIDENCE_STATUSES = ('duplicate', 'replaced')
MAX_FOLDER_UPLOAD_FILES = 2_000
MAX_FOLDER_UPLOAD_BYTES = 500 * 1024 * 1024


@dataclass(frozen=True)
class EvidenceIngestionResult:
    """The outcome of one upload, including content duplicates not stored."""
    files_persisted: int
    duplicates_skipped: int
    evidence_file_ids: tuple[int, ...] = ()


def evidence_content_identity(relative_path: str, digest: str, source_uri: str | None = None) -> tuple[str, str]:
    """Return the duplicate key without discarding distinct ZIP members.

    A project archive can legitimately contain byte-identical templates or
    exports in different folders.  Their paths are evidence provenance and
    must both be scanned.  A standalone repeated upload, however, has no
    meaningful archive path, so preserve the historic SHA-only deduplication
    behaviour for that case.
    """
    normalized_path = str(relative_path or '').replace('\\', '/').strip('/').casefold()
    # ``source_uri`` is set only for an archive.  Do not infer archive origin
    # from a slash in a legacy relative_path: older uploads and integrations
    # can use folder-like paths for ordinary single-file uploads.
    return (digest, normalized_path if source_uri and '/' in normalized_path else '')


def _safe_archive_members(name: str, body: bytes) -> list[tuple[str, bytes]]:
    """Validate every ZIP member before any evidence is written to disk."""
    members: list[tuple[str, bytes]] = []
    # Path checks below protect storage layout, but the archive must also be
    # bounded before ``archive.read`` expands any member.  Otherwise a small
    # compressed upload can consume unbounded memory/disk during ingestion.
    validate_zip(
        BytesIO(body), max_members=2_000, max_uncompressed=500 * 1024 * 1024,
        max_depth=20, max_ratio=200,
    )
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


def _safe_folder_relative_path(relative_path: str, filename: str) -> str:
    """Validate a browser-provided folder path without trusting the client.

    Browsers expose ``webkitRelativePath`` for a selected folder.  That path is
    useful evidence provenance, but it is untrusted multipart metadata and is
    never used as a filesystem path on the server.
    """
    normalized = str(relative_path or '').replace('\\', '/').strip()
    if not normalized or normalized.startswith('/') or '\x00' in normalized:
        raise ValueError('Folder upload contains an invalid file path.')
    parts = normalized.split('/')
    if any(part in {'', '.', '..'} or ':' in part or '\x00' in part for part in parts):
        raise ValueError('Folder upload contains an unsafe file path.')
    # The multipart field name carries the folder path; the browser-supplied
    # filename is still checked so a manipulated request cannot mismatch them.
    safe_leaf = safe_filename(filename)
    if safe_filename(parts[-1]) != safe_leaf:
        raise ValueError('Folder upload file name does not match its relative path.')
    return '/'.join([*(safe_filename(part) for part in parts[:-1]), safe_leaf])


def _add_evidence_files(db: Session, audit_session_id: int, user_id: int,
                        source_type: str, source_uri: str | None,
                        files: list[tuple[str, bytes]], mime_type: str | None = None,
                        mime_types: list[str | None] | None = None) -> EvidenceIngestionResult:
    """Persist new content once per audit session; never create an empty source."""
    if mime_types is not None and len(mime_types) != len(files):
        raise ValueError('Evidence upload metadata does not match the submitted files.')
    resolved_mime_types = mime_types or [mime_type] * len(files)
    settings = get_settings()
    # Serialize uploads for one session. The hash lookup alone is not enough
    # when two browser requests submit the same archive concurrently.
    if not db.scalar(select(AuditSession).where(AuditSession.id == audit_session_id).with_for_update()):
        raise ValueError('Selected audit session no longer exists.')
    running_job = db.scalar(select(ScanJob.id).where(
        ScanJob.audit_session_id == audit_session_id,
        ScanJob.status == 'running',
    ).limit(1))
    if running_job:
        raise ValueError('Evidence cannot be changed while an audit scan is running. Wait for the scan to finish, then try again.')
    digests = [hashlib.sha256(data).hexdigest() for _, data in files]
    existing_files = db.execute(select(EvidenceFile.relative_path, EvidenceFile.sha256, EvidenceSource.source_uri).join(EvidenceSource).where(
        EvidenceSource.audit_session_id == audit_session_id,
        EvidenceFile.sha256.in_(digests),
    )).all()
    existing_identities = {
        evidence_content_identity(relative_path, digest, source_uri)
        for relative_path, digest, source_uri in existing_files
    }
    prepared: list[tuple[str, bytes, str, str | None]] = []
    seen_identities: set[tuple[str, str]] = set()
    for (relative_path, data), digest, file_mime_type in zip(files, digests, resolved_mime_types):
        identity = evidence_content_identity(relative_path, digest, source_uri)
        if identity in existing_identities or identity in seen_identities:
            continue
        seen_identities.add(identity)
        prepared.append((relative_path, data, digest, file_mime_type))
    duplicates_skipped = len(files) - len(prepared)
    if not prepared:
        return EvidenceIngestionResult(0, duplicates_skipped)
    target = settings.upload_dir / str(audit_session_id)
    target.mkdir(parents=True, exist_ok=True)
    source = EvidenceSource(audit_session_id=audit_session_id, source_type=source_type,
                            source_uri=source_uri, created_by_id=user_id)
    db.add(source)
    db.flush()
    evidence_file_ids: list[int] = []
    written_paths: list[Path] = []
    try:
        for relative_path, data, digest, file_mime_type in prepared:
            safe_name = safe_filename(PurePosixPath(relative_path).name)
            stored = target / f'{uuid.uuid4().hex}_{safe_name}'
            stored.write_bytes(data)
            written_paths.append(stored)
            evidence = EvidenceFile(
                source_id=source.id, relative_path=relative_path,
                storage_path=str(stored.relative_to(settings.upload_dir.parent)),
                sha256=digest, mime_type=file_mime_type,
                size_bytes=len(data),
            )
            db.add(evidence)
            db.flush()
            evidence_file_ids.append(evidence.id)
    except Exception:
        for stored in written_paths:
            stored.unlink(missing_ok=True)
        raise
    return EvidenceIngestionResult(len(prepared), duplicates_skipped, tuple(evidence_file_ids))


def mark_session_duplicate_evidence(db: Session, audit_session_id: int) -> int:
    """Retire pre-existing duplicate rows so an old repeat upload is not rescanned."""
    files = db.execute(select(EvidenceFile, EvidenceSource.source_uri).join(EvidenceSource).where(
        EvidenceSource.audit_session_id == audit_session_id,
        EvidenceFile.processing_status.notin_(INACTIVE_EVIDENCE_STATUSES),
    ).order_by(EvidenceFile.id)).all()
    canonical_identities: set[tuple[str, str]] = set()
    duplicate_ids: list[int] = []
    for evidence, source_uri in files:
        identity = evidence_content_identity(evidence.relative_path, evidence.sha256, source_uri)
        if identity in canonical_identities:
            duplicate_ids.append(evidence.id)
        else:
            canonical_identities.add(identity)
    if duplicate_ids:
        db.execute(update(EvidenceFile).where(EvidenceFile.id.in_(duplicate_ids)).values(
            processing_status='duplicate',
        ))
    return len(duplicate_ids)


def persist_uploaded_evidence(db: Session, audit_session_id: int, user_id: int,
                              filename: str, content: bytes, mime_type: str | None,
                              source_type: str = 'upload') -> EvidenceIngestionResult:
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


def persist_uploaded_folder_evidence(
    db: Session,
    audit_session_id: int,
    user_id: int,
    files: list[tuple[str, str, bytes, str | None]],
    source_type: str = 'evidence_scan_folder',
) -> EvidenceIngestionResult:
    """Persist a browser-selected folder using the same evidence records as ZIPs.

    Every file is subject to the regular content/type limits.  Folder-relative
    paths are retained for evidence provenance and duplicate detection, while
    stored files remain UUID-named under the configured upload directory.
    ZIPs found inside a selected folder are expanded through the existing safe
    archive path, so scanning always receives the same individual documents.
    """
    if not files:
        raise ValueError('Select a folder containing at least one evidence file.')
    if len(files) > MAX_FOLDER_UPLOAD_FILES:
        raise ValueError(f'Folder upload exceeds the {MAX_FOLDER_UPLOAD_FILES:,}-file limit.')

    settings = get_settings()
    max_file_bytes = settings.max_upload_mb * 1024 * 1024
    total_received = sum(len(content) for _, _, content, _ in files)
    if total_received > MAX_FOLDER_UPLOAD_BYTES:
        raise ValueError('Folder upload exceeds the 500 MB total size limit.')

    prepared: list[tuple[str, bytes]] = []
    prepared_mime_types: list[str | None] = []
    root_names: set[str] = set()
    for relative_path, filename, content, mime_type in files:
        safe_path = _safe_folder_relative_path(relative_path, filename)
        name, body = validate_evidence_content(filename, content, max_file_bytes)
        # Preserve sanitized final filename in the recorded path. This matters
        # when a browser normalises a name before sending the multipart body.
        safe_path = '/'.join([*safe_path.split('/')[:-1], name])
        root_names.add(safe_path.split('/', maxsplit=1)[0])
        if Path(name).suffix.lower() == '.zip':
            members = _safe_archive_members(name, body)
            for member_path, member_body in members:
                prepared.append((f'{safe_path}/{member_path}', member_body))
                # Retain the prior archive-upload behaviour: members use the
                # archive MIME type because the browser has no member MIME map.
                prepared_mime_types.append(mime_type)
        else:
            prepared.append((safe_path, body))
            prepared_mime_types.append(mime_type)

    if not prepared:
        raise ValueError('Folder upload does not contain any supported evidence files.')
    if len(prepared) > MAX_FOLDER_UPLOAD_FILES:
        raise ValueError(f'Folder upload expands to more than {MAX_FOLDER_UPLOAD_FILES:,} evidence files.')
    if sum(len(content) for _, content in prepared) > MAX_FOLDER_UPLOAD_BYTES:
        raise ValueError('Folder upload expands beyond the 500 MB total size limit.')

    # A source URI activates path-aware duplicate handling: byte-identical
    # documents in different subfolders remain separate, scanable evidence.
    source_name = next(iter(root_names)) if len(root_names) == 1 else 'multiple-folders'
    return _add_evidence_files(
        db, audit_session_id, user_id, source_type, f'folder:{source_name}', prepared,
        mime_types=prepared_mime_types,
    )


def replace_unreadable_evidence(db: Session, evidence_file_id: int, user_id: int,
                                filename: str, content: bytes, mime_type: str | None) -> EvidenceIngestionResult:
    """Retain an unreadable original but exclude it after a corrected replacement is added."""
    original = db.scalar(select(EvidenceFile).join(EvidenceSource).where(
        EvidenceFile.id == evidence_file_id,
    ).with_for_update())
    if not original:
        raise ValueError('The selected unreadable evidence file no longer exists.')
    source = db.get(EvidenceSource, original.source_id)
    if not source or original.processing_status != 'error':
        raise ValueError('Only a currently unreadable evidence file can be replaced.')
    name, body = validate_evidence_content(filename, content, get_settings().max_upload_mb * 1024 * 1024)
    if Path(name).suffix.lower() == '.zip':
        raise ValueError('Upload one corrected evidence file, not a ZIP, when replacing an unreadable file.')
    # Historical repeated uploads may already exist. Preserve one original and
    # prevent a second copy from being promoted after this file is replaced.
    mark_session_duplicate_evidence(db, source.audit_session_id)
    if original.processing_status != 'error':
        raise ValueError('Select the first stored copy of this unreadable file for replacement.')
    result = _add_evidence_files(
        db, source.audit_session_id, user_id, 'evidence_replacement',
        f'replaces evidence file {original.id}', [(name, body)], mime_type,
    )
    if result.files_persisted != 1:
        raise ValueError('This corrected file is already stored in the audit session. Select it and rerun the scan instead.')
    original.processing_status = 'replaced'
    original.classification_json = {
        **(original.classification_json or {}),
        'replacement_evidence_file_id': result.evidence_file_ids[0],
        'replacement_file_name': name,
    }
    return result


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
        outcome = _add_evidence_files(db, audit.id, user_id, 'parent_folder_archive', name, project_files, mime_type)
        created.append({'project_id': project.id, 'project_name': project_name, 'audit_session_id': audit.id,
                        'files_imported': outcome.files_persisted, 'duplicates_skipped': outcome.duplicates_skipped})
    return created
