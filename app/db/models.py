from datetime import date, datetime, timezone
from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, Index
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.database import Base

def utcnow(): return datetime.now(timezone.utc)

class Timestamped:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

class User(Timestamped, Base):
    __tablename__ = 'users'
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(512))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    roles: Mapped[list['Role']] = relationship(secondary='user_roles', back_populates='users')

class Role(Base):
    __tablename__ = 'roles'
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(String(255), default='')
    users: Mapped[list[User]] = relationship(secondary='user_roles', back_populates='roles')
    permissions: Mapped[list['Permission']] = relationship(secondary='role_permissions', back_populates='roles')

class Permission(Base):
    __tablename__ = 'permissions'
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(96), unique=True)
    description: Mapped[str] = mapped_column(String(255), default='')
    roles: Mapped[list[Role]] = relationship(secondary='role_permissions', back_populates='permissions')

class UserRole(Base):
    __tablename__ = 'user_roles'
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    role_id: Mapped[int] = mapped_column(ForeignKey('roles.id', ondelete='CASCADE'), primary_key=True)

class RolePermission(Base):
    __tablename__ = 'role_permissions'
    role_id: Mapped[int] = mapped_column(ForeignKey('roles.id', ondelete='CASCADE'), primary_key=True)
    permission_id: Mapped[int] = mapped_column(ForeignKey('permissions.id', ondelete='CASCADE'), primary_key=True)


class MdScreen(Timestamped, Base):
    """Database projection of the centrally registered application screens.

    ``screen_id`` is an immutable technical key.  Human-readable menu names
    are deliberately not used in either permissions or routing.
    """
    __tablename__ = 'md_screen'
    screen_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    menu_name: Mapped[str] = mapped_column(String(160), nullable=False)
    url: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    icon: Mapped[str] = mapped_column(String(64), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_default_landing: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class MapRoleScreen(Base):
    """Per-role screen access.  A write grant is valid only with read access."""
    __tablename__ = 'map_role_screen'
    role_id: Mapped[int] = mapped_column(ForeignKey('roles.id', ondelete='CASCADE'), primary_key=True)
    screen_id: Mapped[str] = mapped_column(ForeignKey('md_screen.screen_id', ondelete='CASCADE'), primary_key=True)
    can_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    can_write: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    __table_args__ = (
        CheckConstraint('can_write = 0 OR can_read = 1', name='ck_role_screen_write_requires_read'),
    )

class UserSession(Base):
    __tablename__ = 'user_sessions'
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

class PasswordReset(Base):
    __tablename__ = 'password_resets'
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

class Customer(Timestamped, Base):
    __tablename__ = 'customers'
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    contact_email: Mapped[str | None] = mapped_column(String(320))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey('users.id'))

class AuditProject(Timestamped, Base):
    __tablename__ = 'audit_projects'
    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey('customers.id'), index=True)
    name: Mapped[str] = mapped_column(String(255))
    repository_url: Mapped[str | None] = mapped_column(String(2048))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    __table_args__ = (UniqueConstraint('customer_id', 'name', name='uq_project_customer_name'),)

class ChecklistVersion(Timestamped, Base):
    __tablename__ = 'checklist_versions'
    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[str] = mapped_column(String(64), unique=True)
    source: Mapped[str] = mapped_column(String(255))
    checksum: Mapped[str] = mapped_column(String(64))
    framework: Mapped[str] = mapped_column(String(64), default='CMMI v3.0')
    status: Mapped[str] = mapped_column(String(32), default='ACTIVE')
    effective_from: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

class PracticeArea(Base):
    __tablename__ = 'practice_areas'
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    required_folder: Mapped[bool] = mapped_column(Boolean, default=True)

class CmmiRule(Base):
    __tablename__ = 'cmmi_rules'
    id: Mapped[int] = mapped_column(primary_key=True)
    checklist_version_id: Mapped[int] = mapped_column(ForeignKey('checklist_versions.id'), index=True)
    rule_id: Mapped[str] = mapped_column(String(64))
    practice_area_code: Mapped[str] = mapped_column(String(20), index=True)
    level: Mapped[str] = mapped_column(String(32))
    audit_check: Mapped[str] = mapped_column(Text)
    gap_text: Mapped[str] = mapped_column(Text)
    __table_args__ = (UniqueConstraint('checklist_version_id', 'rule_id', name='uq_rule_version_id'),)

class DocumentTypeRule(Base):
    __tablename__ = 'document_type_rules'
    id: Mapped[int] = mapped_column(primary_key=True)
    checklist_version_id: Mapped[int] = mapped_column(ForeignKey('checklist_versions.id'), index=True)
    document_type: Mapped[str] = mapped_column(String(500))
    practice_areas: Mapped[list] = mapped_column(JSON)
    keywords: Mapped[list] = mapped_column(JSON)
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    expected_evidence: Mapped[str | None] = mapped_column(Text)
    primary_purpose: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (UniqueConstraint('checklist_version_id', 'document_type', name='uq_document_type_version'),)

class AuditSession(Timestamped, Base):
    __tablename__ = 'audit_sessions'
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('audit_projects.id'), index=True)
    checklist_version_id: Mapped[int] = mapped_column(ForeignKey('checklist_versions.id'))
    audit_name: Mapped[str | None] = mapped_column(String(255))
    audit_date: Mapped[date | None] = mapped_column(Date)
    auditors: Mapped[str | None] = mapped_column(Text)
    auditees: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default='draft')
    created_by_id: Mapped[int] = mapped_column(ForeignKey('users.id'))

class AuditSessionPracticeArea(Timestamped, Base):
    __tablename__ = 'audit_session_practice_areas'
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id', ondelete='CASCADE'), index=True)
    practice_area_id: Mapped[int] = mapped_column(ForeignKey('practice_areas.id'))
    folder_status: Mapped[str] = mapped_column(String(32), default='not_scanned')
    evidence_status: Mapped[str] = mapped_column(String(32), default='not_scanned')
    __table_args__ = (UniqueConstraint('audit_session_id', 'practice_area_id', name='uq_session_practice_area'),)

class EvidenceSource(Timestamped, Base):
    __tablename__ = 'evidence_sources'
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id'), index=True)
    source_type: Mapped[str] = mapped_column(String(32))
    source_uri: Mapped[str | None] = mapped_column(String(2048))
    created_by_id: Mapped[int] = mapped_column(ForeignKey('users.id'))

class EvidenceFolder(Timestamped, Base):
    __tablename__ = 'evidence_folders'
    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey('evidence_sources.id', ondelete='CASCADE'), index=True)
    # Indexed with source_id; keep below MySQL utf8mb4's 3072-byte index limit.
    relative_path: Mapped[str] = mapped_column(String(700))
    __table_args__ = (UniqueConstraint('source_id', 'relative_path', name='uq_source_folder_path'),)

class EvidenceFile(Timestamped, Base):
    __tablename__ = 'evidence_files'
    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey('evidence_sources.id'), index=True)
    relative_path: Mapped[str] = mapped_column(String(2048))
    storage_path: Mapped[str] = mapped_column(String(2048))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    mime_type: Mapped[str | None] = mapped_column(String(128))
    size_bytes: Mapped[int] = mapped_column(Integer)
    # Spreadsheet extraction can exceed MySQL TEXT's 64 KiB limit.
    extracted_text: Mapped[str | None] = mapped_column(Text().with_variant(LONGTEXT, 'mysql'))
    processing_status: Mapped[str] = mapped_column(String(32), default='pending')
    # Classification is an immutable result of the most recent completed scan
    # for this evidence record.  Keeping the compact JSON payload beside the
    # file avoids reclassifying stale/empty text in the UI and leaves the
    # detailed explanation available for later reporting and review.
    classification_json: Mapped[dict | None] = mapped_column(JSON)
    classified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

class ScanJob(Timestamped, Base):
    __tablename__ = 'scan_jobs'
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id'), index=True)
    job_type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default='queued')
    result_summary: Mapped[dict | None] = mapped_column(JSON)

class Finding(Timestamped, Base):
    __tablename__ = 'findings'
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id'), index=True)
    rule_id: Mapped[str | None] = mapped_column(String(64), index=True)
    practice_area_code: Mapped[str] = mapped_column(String(20), index=True)
    severity: Mapped[str] = mapped_column(String(16), default='major')
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text)
    recommendation: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default='open')
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey('users.id'))

class FindingEvidence(Base):
    __tablename__ = 'finding_evidence'
    finding_id: Mapped[int] = mapped_column(ForeignKey('findings.id', ondelete='CASCADE'), primary_key=True)
    evidence_file_id: Mapped[int] = mapped_column(ForeignKey('evidence_files.id', ondelete='CASCADE'), primary_key=True)
    note: Mapped[str | None] = mapped_column(String(500))

class Comment(Timestamped, Base):
    __tablename__ = 'comments'
    id: Mapped[int] = mapped_column(primary_key=True)
    finding_id: Mapped[int] = mapped_column(ForeignKey('findings.id', ondelete='CASCADE'), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    body: Mapped[str] = mapped_column(Text)

class RemediationAction(Timestamped, Base):
    __tablename__ = 'remediation_actions'
    id: Mapped[int] = mapped_column(primary_key=True)
    finding_id: Mapped[int] = mapped_column(ForeignKey('findings.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey('users.id'))
    action: Mapped[str] = mapped_column(Text)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(32), default='open')

class Approval(Timestamped, Base):
    __tablename__ = 'approvals'
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id'), index=True)
    reviewer_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    decision: Mapped[str] = mapped_column(String(32))
    note: Mapped[str | None] = mapped_column(Text)

class GeneratedReport(Timestamped, Base):
    __tablename__ = 'generated_reports'
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id'), index=True)
    report_type: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(2048))
    created_by_id: Mapped[int] = mapped_column(ForeignKey('users.id'))

class ReportDefinition(Timestamped, Base):
    __tablename__ = 'report_definitions'
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    report_type: Mapped[str] = mapped_column(String(64))
    configuration: Mapped[dict | None] = mapped_column(JSON)

class SystemConfiguration(Timestamped, Base):
    __tablename__ = 'system_configuration'
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(128), unique=True)
    value: Mapped[str] = mapped_column(Text)
    is_secret: Mapped[bool] = mapped_column(Boolean, default=False)

class IntegrationConnection(Timestamped, Base):
    __tablename__ = 'integration_connections'
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    metadata_: Mapped[dict | None] = mapped_column('metadata', JSON)

class AuditLog(Base):
    __tablename__ = 'audit_logs'
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey('users.id'), index=True)
    action: Mapped[str] = mapped_column(String(128), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

class IncidentLog(Timestamped, Base):
    __tablename__ = 'incident_logs'
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id', ondelete='CASCADE'), index=True)
    evidence_file_id: Mapped[int | None] = mapped_column(ForeignKey('evidence_files.id'))
    source_name: Mapped[str] = mapped_column(String(512))

class Incident(Timestamped, Base):
    __tablename__ = 'incidents'
    id: Mapped[int] = mapped_column(primary_key=True)
    incident_log_id: Mapped[int] = mapped_column(ForeignKey('incident_logs.id', ondelete='CASCADE'), index=True)
    external_id: Mapped[str] = mapped_column(String(128))
    category: Mapped[str | None] = mapped_column(String(128))
    priority: Mapped[str | None] = mapped_column(String(64))
    reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint('incident_log_id', 'external_id', name='uq_log_incident_id'),)

class IrpValidationFinding(Timestamped, Base):
    __tablename__ = 'irp_validation_findings'
    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int | None] = mapped_column(ForeignKey('incidents.id', ondelete='SET NULL'), index=True)
    audit_session_id: Mapped[int] = mapped_column(ForeignKey('audit_sessions.id', ondelete='CASCADE'), index=True)
    rule_code: Mapped[str] = mapped_column(String(64))
    detail: Mapped[str] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(String(16), default='major')

class RootCauseRecord(Timestamped, Base):
    __tablename__ = 'root_cause_records'
    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey('incidents.id', ondelete='CASCADE'), index=True)
    five_whys: Mapped[dict | None] = mapped_column(JSON)
    root_cause: Mapped[str | None] = mapped_column(Text)

class LessonLearned(Timestamped, Base):
    __tablename__ = 'lesson_learned_records'
    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey('incidents.id', ondelete='CASCADE'), index=True)
    lesson: Mapped[str] = mapped_column(Text)
    action: Mapped[str | None] = mapped_column(Text)

class SlaValidationResult(Timestamped, Base):
    __tablename__ = 'sla_validation_results'
    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey('incidents.id', ondelete='CASCADE'), index=True)
    metric: Mapped[str] = mapped_column(String(128))
    expected_minutes: Mapped[int | None] = mapped_column(Integer)
    actual_minutes: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32))
