from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.authorization import WORKSPACE_ACCESS_POLICY
from app.core.validators import validate_evidence_content
from app.db.database import Base
from app.db.models import AuditLog, PasswordReset, User
from app.core.audit_log import log_action
from app.services.auth.service import request_reset, reset_password
from app.services.auth.mailer import send_reset_email
from app.core.security import hash_password


def test_production_configuration_rejects_defaults_and_accepts_safe_values():
    with pytest.raises(RuntimeError, match='SECRET_KEY'):
        Settings(environment='production', auto_migrate_on_startup=False).validate_security_configuration()
    settings = Settings(
        environment='production', auto_migrate_on_startup=False,
        secret_key='s' * 48, db_user='cmmi_runtime', db_password='p' * 24,
        public_base_url='https://audit.example.test',
    )
    settings.validate_security_configuration()


def test_shared_workspace_policy_is_explicit_and_versioned():
    assert WORKSPACE_ACCESS_POLICY == 'shared_internal_workspace_v1'


def test_reset_request_supersedes_prior_token_and_token_is_single_use():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        user = User(email='reset@example.com', display_name='Reset User', password_hash=hash_password('current-password'))
        db.add(user); db.commit()
        first = request_reset(db, user.email)
        second = request_reset(db, user.email)
        assert first != second
        assert not reset_password(db, first, 'new-secure-password')
        assert reset_password(db, second, 'new-secure-password')
        assert not reset_password(db, second, 'another-secure-password')
        assert db.query(PasswordReset).filter(PasswordReset.consumed_at.is_(None)).count() == 0


def test_mailer_uses_verified_tls_context(monkeypatch):
    import app.services.auth.mailer as mailer
    observed = {}

    class FakeClient:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def starttls(self, *, context): observed['context'] = context
        def login(self, username, password): observed['login'] = (username, password)
        def send_message(self, message): observed['message'] = message

    monkeypatch.setattr(mailer, 'get_settings', lambda: SimpleNamespace(
        smtp_from_email='sender@example.test', sender_email='', smtp_host='smtp.example.test',
        smtp_port=587, smtp_username='user', smtp_password='password', smtp_tls_mode='starttls',
        public_base_url='https://audit.example.test',
    ))
    monkeypatch.setattr(mailer.smtplib, 'SMTP', lambda *args, **kwargs: FakeClient())
    assert send_reset_email('recipient@example.test', 'token')
    assert observed['context'].check_hostname is True
    assert observed['context'].verify_mode != 0


def test_upload_rejects_extension_spoofing_before_parser_execution():
    with pytest.raises(Exception, match='does not match'):
        validate_evidence_content('evidence.pdf', b'not a PDF', 1024)


def test_audit_events_are_structured_without_sensitive_change_values():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        log_action(db, 'remediation_updated', entity_type='remediation_action', entity_id='7',
                   changes={'action': '[changed]'}, outcome='success')
        db.commit()
        row = db.query(AuditLog).one()
        assert '"outcome":"success"' in row.detail
        assert '"action":"[changed]"' in row.detail
