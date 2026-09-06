from app.core.validators import safe_filename, validate_evidence_content
from app.core.config import Settings
from app.core.security import expiry
from app.services.auth.service import _as_utc
import pytest
from fastapi import HTTPException
from datetime import datetime, timezone
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
