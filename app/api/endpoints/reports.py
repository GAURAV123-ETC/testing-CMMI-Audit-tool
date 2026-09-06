from datetime import date
from pathlib import Path
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from app.api.deps import current_user, require_screen
from app.db.database import get_db
from app.db.models import AuditSession, GeneratedReport
from app.services.reports.afr_report import create_afr, create_gap_report

router = APIRouter(prefix='/reports', tags=['reports'])
class AfrFilterIn(BaseModel):
    practice_area_codes: list[str] = []
    severities: list[str] = []
    statuses: list[str] = []
    from_date: date | None = None
    to_date: date | None = None

@router.post('/audit-sessions/{audit_session_id}/afr/{format}')
def generate_afr(audit_session_id: int, format: str, filters: AfrFilterIn | None = None,
                 db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('reports', 'write'))):
    if format not in {'xlsx','docx','pdf'}: raise HTTPException(422, 'Supported formats: xlsx, docx, pdf')
    if not db.get(AuditSession, audit_session_id): raise HTTPException(404, 'Audit session not found')
    if filters and filters.from_date and filters.to_date and filters.from_date > filters.to_date:
        raise HTTPException(422, 'from_date must not be after to_date')
    report = create_afr(db, audit_session_id, user.id, format, **(filters.model_dump() if filters else {}))
    return {'id': report.id, 'format': format}

@router.post('/audit-sessions/{audit_session_id}/gap/{format}')
def generate_gap_report(audit_session_id: int, format: str, filters: AfrFilterIn | None = None,
                        db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('reports', 'write'))):
    if format not in {'xlsx', 'pdf'}: raise HTTPException(422, 'Supported formats: xlsx, pdf')
    if not db.get(AuditSession, audit_session_id): raise HTTPException(404, 'Audit session not found')
    if filters and filters.from_date and filters.to_date and filters.from_date > filters.to_date:
        raise HTTPException(422, 'from_date must not be after to_date')
    report = create_gap_report(db, audit_session_id, user.id, format, **(filters.model_dump() if filters else {}))
    return {'id': report.id, 'format': format}
@router.get('/{report_id}/download')
def download(report_id: int, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('reports'))):
    report = db.get(GeneratedReport, report_id)
    if not report or not Path(report.storage_path).is_file(): raise HTTPException(404, 'Report not found')
    return FileResponse(report.storage_path, filename=Path(report.storage_path).name)
