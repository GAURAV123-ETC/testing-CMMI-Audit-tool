from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.db.models import User
from app.core.screen_registry import has_screen_permission
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
        if not has_screen_permission(db, user, screen_id, action):
            raise HTTPException(status.HTTP_403_FORBIDDEN, 'Screen permission denied')
        return user
    return dependency
