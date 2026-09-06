import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerifyMismatchError

password_hasher = PasswordHasher()

def hash_password(password: str) -> str:
    return password_hasher.hash(password)

def verify_password(password: str, encoded: str) -> bool:
    try:
        return password_hasher.verify(encoded, password)
    except (VerifyMismatchError, InvalidHash):
        return False

def random_token() -> str:
    return secrets.token_urlsafe(48)

def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

def expiry(*, minutes: int) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=max(1, minutes))
