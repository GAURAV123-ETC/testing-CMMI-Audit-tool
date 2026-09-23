from app.core.validators import safe_filename, validate_evidence_content
from app.core.config import Settings
from app.core.security import expiry, hash_password, verify_password
from app.db.database import Base
from app.db.models import User
from app.services.auth.service import _as_utc, authenticate, change_password, create_session, get_session_user
from app.api.endpoints.auth import FirstAdministratorIn, LoginIn
from app.gui.pages.login import _request_error_message
import pytest
from fastapi import HTTPException
from datetime import datetime, timezone
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
def test_upload_blocks_executable():
    with pytest.raises(HTTPException): safe_filename('../../evil.exe')
def test_upload_removes_path(): assert safe_filename('../../evidence.pdf') == 'evidence.pdf'


def test_evidence_upload_rejects_unapproved_and_malformed_zip_content():
    with pytest.raises(HTTPException):
        validate_evidence_content('evidence.html', b'<html></html>', 1024)
    with pytest.raises(HTTPException):
        validate_evidence_content('evidence.zip', b'not a zip', 1024)

def test_session_timeout_preserves_minutes():
    assert Settings(session_timeout_minutes=90).session_seconds == 90 * 60

def test_expiry_uses_minutes():
    remaining = (expiry(minutes=90) - datetime.now(timezone.utc)).total_seconds()
    assert 89 * 60 < remaining <= 90 * 60

def test_mysql_naive_datetime_is_normalized_to_utc():
    value = _as_utc(datetime(2026, 1, 1, 12, 0, 0))
    assert value.tzinfo == timezone.utc


def test_deactivated_user_cannot_reuse_an_existing_session():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        user = User(email='disabled@example.com', display_name='Disabled', password_hash='unused')
        db.add(user)
        db.commit()
        token = create_session(db, user)
        assert get_session_user(db, token).id == user.id

        user.is_active = False
        db.commit()

        assert get_session_user(db, token) is None


def test_authenticated_password_change_requires_current_password_and_revokes_every_session():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        user = User(email='password@example.com', display_name='Password User', password_hash=hash_password('current-password'))
        db.add(user)
        db.commit()
        first_token = create_session(db, user)
        second_token = create_session(db, user)

        with pytest.raises(ValueError, match='current password'):
            change_password(db, user, 'incorrect-password', 'new-secure-password')

        change_password(db, user, 'current-password', 'new-secure-password')
        db.commit()
        assert verify_password('new-secure-password', user.password_hash)
        assert not verify_password('current-password', user.password_hash)
        assert get_session_user(db, first_token) is None
        assert get_session_user(db, second_token) is None


def test_login_accepts_an_existing_short_password_while_new_accounts_require_twelve_characters():
    assert LoginIn(email='legacy@example.com', password='Sing@1234').password == 'Sing@1234'
    with pytest.raises(ValueError):
        FirstAdministratorIn(email='new@example.com', display_name='New Admin', password='Sing@1234')


def test_existing_short_password_can_be_verified_without_weakening_password_change_policy():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        user = User(email='legacy@example.com', display_name='Legacy', password_hash=hash_password('Sing@1234'))
        db.add(user); db.commit()
        assert authenticate(db, 'legacy@example.com', 'Sing@1234').id == user.id
        with pytest.raises(ValueError, match='at least 12'):
            change_password(db, user, 'Sing@1234', 'Sing@1234')


def test_login_ui_hides_raw_validation_payloads():
    assert _request_error_message({
        'data': {'detail': [{'loc': ['body', 'password'], 'msg': 'String too short',
                             'ctx': {'min_length': 12}}]},
    }, 'Sign in failed.') == 'Password must contain at least 12 characters.'
