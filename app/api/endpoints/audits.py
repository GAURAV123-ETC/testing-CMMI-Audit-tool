from datetime import date, datetime
from pathlib import Path
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.api.deps import current_user, require_screen
from app.core.audit_log import log_action
from app.core.config import get_settings
from app.core.validators import validate_upload
from app.db.database import get_db
from app.db.models import (AuditProject, AuditSession, AuditSessionPracticeArea,
                           ChecklistVersion, Comment, Customer, Finding,
                           PracticeArea, RemediationAction)
from app.services.audit_engine.evidence_scan import scan_session

router = APIRouter(tags=['audits'])
class CustomerIn(BaseModel): name: str = Field(min_length=2, max_length=255); contact_email: str | None = None
class ProjectIn(BaseModel): customer_id: int; name: str = Field(min_length=2, max_length=255); repository_url: str | None = None
class SessionIn(BaseModel):
    project_id: int
    audit_name: str | None = Field(default=None, min_length=2, max_length=255)
    audit_date: date | None = None
    auditors: str | None = Field(default=None, max_length=4_000)
    auditees: str | None = Field(default=None, max_length=4_000)
class CommentIn(BaseModel): body: str = Field(min_length=1, max_length=10_000)
class RemediationIn(BaseModel): action: str = Field(min_length=1, max_length=10_000); due_at: datetime | None = None
class RemediationUpdateIn(BaseModel): action: str | None = Field(default=None, min_length=1, max_length=10_000); due_at: datetime | None = None; status: str | None = Field(default=None, pattern='^(open|in_progress|completed|cancelled)$')

@router.get('/customers')
def customers(db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('add_project'))): return db.scalars(select(Customer).order_by(Customer.name)).all()
@router.post('/customers')
def add_customer(payload: CustomerIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('add_project', 'write'))):
    customer = Customer(**payload.model_dump(), created_by_id=user.id); db.add(customer); db.commit(); db.refresh(customer); return customer
@router.get('/projects')
def projects(db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('add_project'))): return db.scalars(select(AuditProject).order_by(AuditProject.name)).all()
@router.post('/projects')
def add_project(payload: ProjectIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('add_project', 'write'))):
    if not db.get(Customer, payload.customer_id): raise HTTPException(404, 'Customer not found')
    project = AuditProject(**payload.model_dump(), owner_id=user.id); db.add(project); db.commit(); db.refresh(project); return project
@router.post('/audit-sessions')
def add_session(payload: SessionIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('add_project', 'write'))):
    if not db.get(AuditProject, payload.project_id):
        raise HTTPException(404, 'Project not found')
    version = db.scalar(select(ChecklistVersion).where(ChecklistVersion.is_active.is_(True)))
    if not version: raise HTTPException(503, 'Checklist seed data is unavailable')
    values = payload.model_dump()
    session = AuditSession(**values, checklist_version_id=version.id, created_by_id=user.id); db.add(session); db.flush()
    db.add_all([AuditSessionPracticeArea(audit_session_id=session.id, practice_area_id=pa.id) for pa in db.scalars(select(PracticeArea)).all()])
    db.commit(); db.refresh(session); return session
@router.get('/audit-sessions/{audit_session_id}/findings')
def findings(audit_session_id: int, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('findings'))): return db.scalars(select(Finding).where(Finding.audit_session_id == audit_session_id)).all()
@router.get('/findings/{finding_id}/comments')
def finding_comments(finding_id: int, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('findings'))):
    if not db.get(Finding, finding_id): raise HTTPException(404, 'Finding not found')
    return db.scalars(select(Comment).where(Comment.finding_id == finding_id).order_by(Comment.created_at)).all()
@router.post('/findings/{finding_id}/comments')
def add_finding_comment(finding_id: int, payload: CommentIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('findings', 'write'))):
    if not db.get(Finding, finding_id): raise HTTPException(404, 'Finding not found')
    item = Comment(finding_id=finding_id, author_id=user.id, body=payload.body.strip()); db.add(item); db.commit(); db.refresh(item); return item
@router.get('/findings/{finding_id}/remediation-actions')
def remediation_actions(finding_id: int, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('findings'))):
    if not db.get(Finding, finding_id): raise HTTPException(404, 'Finding not found')
    return db.scalars(select(RemediationAction).where(RemediationAction.finding_id == finding_id).order_by(RemediationAction.created_at)).all()
@router.post('/findings/{finding_id}/remediation-actions')
def add_remediation_action(finding_id: int, payload: RemediationIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('findings', 'write'))):
    if not db.get(Finding, finding_id): raise HTTPException(404, 'Finding not found')
    item = RemediationAction(finding_id=finding_id, action=payload.action.strip(), due_at=payload.due_at); db.add(item); db.commit(); db.refresh(item); return item
@router.patch('/remediation-actions/{action_id}')
def update_remediation_action(action_id: int, payload: RemediationUpdateIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('findings', 'write'))):
    item = db.get(RemediationAction, action_id)
    if not item: raise HTTPException(404, 'Remediation action not found')
    for field, value in payload.model_dump(exclude_unset=True).items(): setattr(item, field, value.strip() if field == 'action' else value)
    db.commit(); db.refresh(item); return item
@router.post('/audit-sessions/{audit_session_id}/evidence')
async def upload_evidence(audit_session_id: int, file: UploadFile, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('evidence_scan', 'write'))):
    if not db.get(AuditSession, audit_session_id): raise HTTPException(404, 'Audit session not found')
    name, content = await validate_upload(file, get_settings().max_upload_mb * 1024 * 1024)
    from app.services.evidence_ingestion import persist_uploaded_evidence
    count = persist_uploaded_evidence(db, audit_session_id, user.id, name, content, file.content_type)
    log_action(db, 'evidence_uploaded', user_id=user.id, entity_type='audit_session', entity_id=str(audit_session_id), detail=name)
    db.commit()
    return {'name': name, 'files_persisted': count}
@router.post('/audit-sessions/{audit_session_id}/scan')
def run_scan(audit_session_id: int, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('evidence_scan', 'write'))):
    if not db.get(AuditSession, audit_session_id):
        raise HTTPException(404, 'Audit session not found')
    return scan_session(db, audit_session_id, user.id)
