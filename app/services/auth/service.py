from datetime import datetime, timezone, timedelta
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from app.core.config import get_settings
from app.core.security import expiry, hash_password, random_token, token_digest, verify_password
from app.db.models import PasswordReset, User, UserSession

_DUMMY_HASH = hash_password('not-a-real-password')


def _as_utc(value: datetime) -> datetime:
    """Normalize MySQL's timezone-naive DATETIME values before comparison."""
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

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
    if not record or _as_utc(record.expires_at) <= datetime.now(timezone.utc): return None
    return db.get(User, record.user_id)

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
