"""Governed user-administration operations shared by the UI and API."""
from email_validator import EmailNotValidError, validate_email
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit_log import log_action
from app.core.security import hash_password
from app.core.screen_registry import ADMINISTRATION_SCREEN_IDS, has_screen_permission
from app.db.models import MapRoleScreen, Role, User, UserSession, utcnow


def assignable_role_names(db: Session) -> list[str]:
    """Return database-backed roles in NiceGUI's supported select format."""
    return list(db.scalars(select(Role.name).where(Role.is_active.is_(True)).order_by(Role.name)).all())


def _email(value: str) -> str:
    try:
        result = validate_email((value or '').strip(), check_deliverability=False).normalized.lower()
    except EmailNotValidError as exc:
        raise ValueError('Enter a valid email address.') from exc
    if len(result) > 320:
        raise ValueError('Email address must not exceed 320 characters.')
    return result


def _name(value: str) -> str:
    result = (value or '').strip()
    if len(result) < 2:
        raise ValueError('Display name must contain at least two characters.')
    if len(result) > 160:
        raise ValueError('Display name must not exceed 160 characters.')
    return result


def _role(db: Session, role_name: str) -> Role:
    name = (role_name or '').strip()
    role = db.scalar(select(Role).where(func.lower(Role.name) == name.casefold(), Role.is_active.is_(True)))
    if not role:
        raise ValueError('Select a valid role.')
    return role


def _has_other_active_manager(db: Session, user_id: int, screen_id: str) -> bool:
    """Return whether another active account can still administer ``screen_id``."""
    candidates = db.scalars(select(User).where(User.is_active.is_(True), User.id != user_id)).all()
    return any(has_screen_permission(db, candidate, screen_id, 'write') for candidate in candidates)


def _ensure_administration_remains(db: Session, user: User, next_role: Role | None = None) -> None:
    """Protect the final active administrator for either management screen.

    ``next_role`` is supplied for a role reassignment before the relationship
    is changed. A newly assigned role that retains write access is safe.
    """
    for screen_id in ADMINISTRATION_SCREEN_IDS:
        currently_manager = has_screen_permission(db, user, screen_id, 'write')
        next_mapping = db.get(MapRoleScreen, (next_role.id, screen_id)) if next_role else None
        next_manager = bool(next_mapping and next_mapping.can_write)
        if currently_manager and not next_manager and not _has_other_active_manager(db, user.id, screen_id):
            label = 'Manage Users' if screen_id == 'user_administration' else 'Manage Roles'
            raise ValueError(f'Assign another active user with {label} access before removing the final administrator.')


def create_user(db: Session, *, actor_id: int, email: str, display_name: str,
                password: str, role_name: str) -> User:
    if len(password or '') < 12:
        raise ValueError('Temporary password must contain at least 12 characters.')
    clean_email, clean_name = _email(email), _name(display_name)
    if db.scalar(select(User.id).where(User.email == clean_email)):
        raise ValueError('This email is already registered.')
    user = User(email=clean_email, display_name=clean_name,
                password_hash=hash_password(password), roles=[_role(db, role_name)])
    db.add(user)
    db.flush()
    log_action(db, 'user_created', user_id=actor_id, entity_type='user', entity_id=str(user.id))
    return user


def update_user(db: Session, *, actor_id: int, user_id: int, email: str,
                display_name: str, role_name: str, password: str | None = None) -> User:
    user = db.get(User, user_id)
    if not user:
        raise ValueError('User not found.')
    clean_email, clean_name = _email(email), _name(display_name)
    duplicate = db.scalar(select(User.id).where(User.email == clean_email, User.id != user.id))
    if duplicate:
        raise ValueError('This email is already registered.')
    next_role = _role(db, role_name)
    if user.is_active:
        _ensure_administration_remains(db, user, next_role)
    if password and len(password) < 12:
        raise ValueError('New password must contain at least 12 characters.')
    user.email = clean_email
    user.display_name = clean_name
    user.roles = [next_role]
    if password:
        user.password_hash = hash_password(password)
    db.flush()
    log_action(db, 'user_updated', user_id=actor_id, entity_type='user', entity_id=str(user.id))
    return user


def delete_user(db: Session, *, actor_id: int, user_id: int) -> None:
    user = db.get(User, user_id)
    if not user:
        raise ValueError('User not found.')
    if user.id == actor_id:
        raise ValueError('You cannot delete your own account.')
    if user.is_active:
        _ensure_administration_remains(db, user)
    db.delete(user)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise ValueError('This user has audit-history records and cannot be deleted.') from exc
    log_action(db, 'user_deleted', user_id=actor_id, entity_type='user', entity_id=str(user_id))


def set_user_active(db: Session, *, actor_id: int, user_id: int, is_active: bool) -> User:
    user = db.get(User, user_id)
    if not user:
        raise ValueError('User not found.')
    if user.id == actor_id and not is_active:
        raise ValueError('You cannot deactivate your own account.')
    if user.is_active and not is_active:
        _ensure_administration_remains(db, user)
        for session in db.scalars(select(UserSession).where(
            UserSession.user_id == user.id, UserSession.revoked_at.is_(None)
        )).all():
            session.revoked_at = utcnow()
    user.is_active = is_active
    db.flush()
    log_action(
        db, 'user_activated' if is_active else 'user_deactivated', user_id=actor_id,
        entity_type='user', entity_id=str(user.id),
    )
    return user
