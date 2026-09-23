from datetime import datetime, timezone, timedelta
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from app.core.config import get_settings
from app.core.audit_log import log_action
from app.core.security import expiry, hash_password, random_token, token_digest, verify_password
from app.db.models import PasswordReset, Role, User, UserSession

_DUMMY_HASH = hash_password('not-a-real-password')


def _as_utc(value: datetime) -> datetime:
    """Normalize MySQL's timezone-naive DATETIME values before comparison."""
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def first_administrator_required(db: Session) -> bool:
    """Return whether the database has no accounts yet.

    This status is intentionally only used to choose the login-page form. The
    registration operation repeats the check under a database lock, so two
    simultaneous first-run requests cannot create two administrators.
    """
    return db.scalar(select(User.id).limit(1)) is None


def register_first_administrator(db: Session, email: str, display_name: str,
                                 password: str) -> User:
    """Create the one public first-run account, with the Administrator role.

    The seeded Admin role acts as a stable lock row even when ``users`` is
    empty. Once any account exists this function refuses registration; all
    subsequent accounts must be created by an authenticated administrator.
    """
    clean_name = display_name.strip()
    if len(clean_name) < 2:
        raise ValueError('Administrator display name must contain at least two characters.')
    admin_role = db.scalar(select(Role).where(Role.name == 'Admin').with_for_update())
    if not admin_role:
        raise ValueError('Administrator role is unavailable. Restart after database initialization completes.')
    if not first_administrator_required(db):
        raise ValueError('Initial administrator registration is already complete.')
    user = User(
        email=email.lower(),
        display_name=clean_name,
        password_hash=hash_password(password),
        roles=[admin_role],
    )
    db.add(user)
    db.flush()
    return user

def authenticate(db: Session, email: str, password: str) -> User | None:
    settings = get_settings(); user = db.scalar(select(User).where(User.email == email.lower()))
    now = datetime.now(timezone.utc)
    if not user:
        verify_password(password, _DUMMY_HASH)  # reduce account-enumeration timing signal
        return None
    if not user.is_active or (user.locked_until and _as_utc(user.locked_until) > now): return None
    if not verify_password(password, user.password_hash):
        user.failed_login_count += 1
        if user.failed_login_count >= settings.lockout_attempts: user.locked_until = now + timedelta(minutes=settings.lockout_minutes)
        db.commit(); return None
    user.failed_login_count = 0; user.locked_until = None; db.commit(); return user

def create_session(db: Session, user: User) -> str:
    token = random_token()
    db.add(UserSession(token_hash=token_digest(token), user_id=user.id,
                       expires_at=expiry(minutes=get_settings().session_timeout_minutes)))
    db.commit()
    return token

def get_session_user(db: Session, token: str | None) -> User | None:
    if not token: return None
    record = db.scalar(select(UserSession).where(UserSession.token_hash == token_digest(token), UserSession.revoked_at.is_(None)))
    now = datetime.now(timezone.utc)
    if not record or _as_utc(record.expires_at) <= now: return None
    user = db.get(User, record.user_id)
    # Account changes must take effect for already-issued browser sessions.
    # Otherwise a deactivated or newly locked administrator could continue to
    # invoke server-side UI handlers until the old session naturally expired.
    if not user or not user.is_active or (user.locked_until and _as_utc(user.locked_until) > now):
        return None
    return user

def revoke_session(db: Session, token: str | None) -> None:
    if token:
        record = db.scalar(select(UserSession).where(UserSession.token_hash == token_digest(token)))
        if record: record.revoked_at = datetime.now(timezone.utc); db.commit()

def request_reset(db: Session, email: str) -> str | None:
    user = db.scalar(select(User).where(User.email == email.lower()))
    if not user: return None
    token = random_token()
    db.add(PasswordReset(token_hash=token_digest(token), user_id=user.id, expires_at=expiry(minutes=60)))
    db.commit()
    return token

def reset_password(db: Session, token: str, password: str) -> bool:
    reset = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == token_digest(token), PasswordReset.consumed_at.is_(None)))
    if not reset or _as_utc(reset.expires_at) <= datetime.now(timezone.utc): return False
    user = db.get(User, reset.user_id); user.password_hash = hash_password(password); reset.consumed_at = datetime.now(timezone.utc)
    db.execute(update(UserSession).where(UserSession.user_id == user.id).values(revoked_at=datetime.now(timezone.utc))); db.commit(); return True


def change_password(db: Session, user: User, current_password: str, new_password: str) -> None:
    """Change an authenticated user's password and invalidate all sessions."""
    if len(new_password or '') < 12:
        raise ValueError('New password must contain at least 12 characters.')
    if not verify_password(current_password or '', user.password_hash):
        raise ValueError('Your current password is incorrect.')
    if verify_password(new_password, user.password_hash):
        raise ValueError('Choose a password different from your current password.')
    user.password_hash = hash_password(new_password)
    db.execute(update(UserSession).where(UserSession.user_id == user.id).values(revoked_at=datetime.now(timezone.utc)))
    log_action(db, 'password_changed', user_id=user.id, entity_type='user', entity_id=str(user.id))
    db.flush()
