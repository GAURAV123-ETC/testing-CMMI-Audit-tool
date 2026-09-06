from datetime import date

from app.api.endpoints.audits import SessionIn
from app.db.models import AuditSession


def test_audit_session_persists_legacy_audit_setup_metadata():
    assert {'audit_name', 'audit_date', 'auditors', 'auditees'} <= set(AuditSession.__table__.columns.keys())


def test_audit_session_api_accepts_optional_metadata():
    payload = SessionIn(
        project_id=4,
        audit_name='CMMI V3.0 Internal Audit',
        audit_date=date(2026, 9, 2),
        auditors='Asha, Ravi',
        auditees='Engineering Team',
    )
    assert payload.model_dump()['audit_name'] == 'CMMI V3.0 Internal Audit'
    assert payload.audit_date == date(2026, 9, 2)
