from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.db.models import User
from app.core.authorization import authorize_workspace_access
from app.core.audit_log import log_action
from app.services.auth.service import get_session_user

def current_user(cmmi_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> User:
    user = get_session_user(db, cmmi_session)
    if not user: raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Authentication required')
    return user

def require(permission: str):
    def dependency(user: User = Depends(current_user)) -> User:
        codes = {p.code for role in user.roles for p in role.permissions}
        if '*' not in codes and permission not in codes: raise HTTPException(status.HTTP_403_FORBIDDEN, 'Permission denied')
        return user
    return dependency


def require_screen(screen_id: str, action: str = 'read'):
    """Authorize an API by the stable screen identifier, not menu text.

    Existing granular permission dependencies remain in place during the
    migration, so this adds screen protection without widening legacy access.
    """
    def dependency(db: Session = Depends(get_db), user: User = Depends(current_user)) -> User:
        if not authorize_workspace_access(db, user, screen_id, action):
            log_action(db, 'authorization_denied', user_id=user.id,
                       entity_type='screen', entity_id=screen_id,
                       detail=f'action={action}', outcome='denied')
            db.commit()
            raise HTTPException(status.HTTP_403_FORBIDDEN, 'Screen permission denied')
        return user
    return dependency
