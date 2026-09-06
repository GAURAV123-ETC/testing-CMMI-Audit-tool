from sqlalchemy.orm import Session
from app.db.models import AuditLog

def log_action(db: Session, action: str, *, user_id: int | None = None, entity_type: str | None = None, entity_id: str | None = None, detail: str | None = None) -> None:
    db.add(AuditLog(user_id=user_id, action=action, entity_type=entity_type, entity_id=entity_id, detail=detail))
