import json
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from app.db.models import AuditLog

def log_action(db: Session, action: str, *, user_id: int | None = None,
               entity_type: str | None = None, entity_id: str | None = None,
               detail: str | None = None, outcome: str = 'success',
               changes: dict | None = None) -> None:
    """Record a compact, structured event without persisting secrets or tokens.

    AuditLog is application-write-only: no API or GUI operation exposes a
    mutation/deletion path.  JSON is stored in the existing detail field to
    preserve compatibility with deployed schemas while making new events
    machine-readable.
    """
    payload = {'outcome': outcome, 'at': datetime.now(timezone.utc).isoformat()}
    if detail:
        payload['detail'] = detail[:2_000]
    if changes:
        payload['changes'] = changes
    db.add(AuditLog(user_id=user_id, action=action, entity_type=entity_type,
                    entity_id=entity_id, detail=json.dumps(payload, separators=(',', ':'))))
