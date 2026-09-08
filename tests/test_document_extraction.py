from app.services.audit_engine.evidence_scan import _extraction_failed
from app.core.validators import validate_evidence_content
from app.services.document_processing import extractors
from io import BytesIO
import zipfile
import pytest


def test_image_evidence_uses_server_side_ocr(monkeypatch, tmp_path):
    evidence = tmp_path / 'audit-screenshot.png'
    evidence.write_bytes(b'not-a-real-image')
    monkeypatch.setattr(extractors, 'ocr_image', lambda path: 'approved risk mitigation evidence')

    assert extractors.extract_text(str(evidence)) == 'approved risk mitigation evidence'


def test_extraction_errors_are_not_marked_as_processed_evidence():
    assert _extraction_failed('[OCR unavailable: install the Tesseract system package]')
    assert _extraction_failed('[OCR error: TesseractNotFoundError]')
    assert _extraction_failed('[Extraction error: PdfReadError]')
    assert not _extraction_failed('approved risk mitigation evidence')


def test_legacy_plain_text_and_doc_evidence_are_retained_for_traceability(tmp_path):
    assert validate_evidence_content('audit-notes.md', b'approved mitigation', 1024)[0] == 'audit-notes.md'
    assert validate_evidence_content('legacy-plan.doc', b'legacy binary placeholder', 1024)[0] == 'legacy-plan.doc'
    note = tmp_path / 'audit-notes.md'
    note.write_text('approved mitigation', encoding='utf-8')
    legacy = tmp_path / 'legacy-plan.doc'
    legacy.write_bytes(b'legacy binary placeholder')

    assert extractors.extract_text(str(note)) == 'approved mitigation'
    assert _extraction_failed(extractors.extract_text(str(legacy)))


def test_legacy_word_conversion_is_disabled_by_default(monkeypatch, tmp_path):
    legacy = tmp_path / 'legacy-plan.doc'
    legacy.write_bytes(extractors.LEGACY_WORD_SIGNATURE + b'word-binary')
    monkeypatch.setattr(extractors, 'get_settings', lambda: type('Settings', (), {
        'legacy_doc_conversion_enabled': False,
    })())
    monkeypatch.setattr(extractors.subprocess, 'run', lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError()))

    result = extractors.extract_text(str(legacy))

    assert result.startswith('[Unsupported legacy format: .doc conversion is disabled')


def test_zip_with_duplicate_paths_is_rejected():
    archive=BytesIO()
    with zipfile.ZipFile(archive,'w') as zipped:
        zipped.writestr('Project/risk.txt','one')
        zipped.writestr('Project/RISK.txt','two')
    with pytest.raises(Exception,match='duplicate member paths'):
        validate_evidence_content('evidence.zip',archive.getvalue(),1024*1024)
