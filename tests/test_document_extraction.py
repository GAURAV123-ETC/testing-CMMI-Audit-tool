from app.services.audit_engine.evidence_scan import _extraction_failed
from app.core.validators import validate_evidence_content
from app.services.document_processing import extractors
from io import BytesIO
from types import SimpleNamespace
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


def test_mispackaged_docx_with_a_word_document_part_is_recovered(tmp_path):
    evidence = tmp_path / 'mispackaged.docx'
    with zipfile.ZipFile(evidence, 'w') as package:
        package.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        package.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
        package.writestr('word/document.xml', '''<?xml version="1.0"?>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body><w:p><w:r><w:t>Recovered audit evidence</w:t></w:r></w:p></w:body>
            </w:document>''')

    assert extractors.extract_text(str(evidence)) == 'Recovered audit evidence'


def test_docx_reads_paragraphs_tables_text_boxes_headers_footers_and_comments(tmp_path):
    evidence = tmp_path / 'structured-evidence.docx'
    word_ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    document_xml = f'''<?xml version="1.0"?>
      <w:document xmlns:w="{word_ns}" xmlns:v="urn:schemas-microsoft-com:vml">
        <w:body>
          <w:p><w:r><w:t>Main evidence paragraph</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Defect ID table header</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:r><w:t>Shape anchor</w:t></w:r><w:r><w:pict><v:shape><v:textbox>
            <w:txbxContent><w:p><w:r><w:t>Root Cause boxed evidence</w:t></w:r></w:p></w:txbxContent>
          </v:textbox></v:shape></w:pict></w:r></w:p>
        </w:body>
      </w:document>'''
    with zipfile.ZipFile(evidence, 'w') as package:
        package.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        package.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
        package.writestr('word/document.xml', document_xml)
        package.writestr('word/header1.xml', f'<w:hdr xmlns:w="{word_ns}"><w:p><w:r><w:t>Approved header</w:t></w:r></w:p></w:hdr>')
        package.writestr('word/footer1.xml', f'<w:ftr xmlns:w="{word_ns}"><w:p><w:r><w:t>Controlled footer</w:t></w:r></w:p></w:ftr>')
        package.writestr('word/comments.xml', f'<w:comments xmlns:w="{word_ns}"><w:comment><w:p><w:r><w:t>Reviewer comment</w:t></w:r></w:p></w:comment></w:comments>')

    text = extractors.extract_text(str(evidence))

    assert 'Main evidence paragraph' in text
    assert 'Defect ID table header' in text
    assert 'Root Cause boxed evidence' in text
    assert text.count('Root Cause boxed evidence') == 1
    assert 'Approved header' in text
    assert 'Controlled footer' in text
    assert 'Reviewer comment' in text


def test_legacy_word_reader_requests_all_story_ranges_and_shape_text(monkeypatch, tmp_path):
    evidence = tmp_path / 'legacy.doc'
    evidence.write_bytes(extractors.LEGACY_WORD_SIGNATURE + b'word-binary')
    monkeypatch.setattr(extractors.os, 'name', 'nt')
    monkeypatch.setattr(extractors, 'get_settings', lambda: SimpleNamespace(
        legacy_doc_conversion_enabled=True,
    ))

    def fake_run(command, **kwargs):
        script = command[-1]
        assert 'StoryRanges' in script
        assert 'TextFrame.HasText' in script
        assert 'section.Headers' in script
        output = kwargs['env']['CMMI_DOC_OUTPUT']
        with open(output, 'wb') as stream:
            stream.write('Paragraph\r\nTable Header\r\nBoxed Key'.encode('utf-8-sig'))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(extractors.subprocess, 'run', fake_run)

    assert extractors.extract_text(str(evidence)) == 'Paragraph\r\nTable Header\r\nBoxed Key'


def test_theme_only_docx_is_reported_as_missing_document_content(tmp_path):
    evidence = tmp_path / 'theme-only.docx'
    with zipfile.ZipFile(evidence, 'w') as package:
        package.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        package.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
        package.writestr('theme/theme/themeManager.xml', '<themeManager/>')
        package.writestr('theme/theme/theme1.xml', '<theme/>')

    result = extractors.extract_text(str(evidence))
    assert result == '[Unsupported Office package: DOCX extension contains only Office theme data, not a Word document]'
    assert _extraction_failed(result)


def test_zip_with_duplicate_paths_is_rejected():
    archive=BytesIO()
    with zipfile.ZipFile(archive,'w') as zipped:
        zipped.writestr('Project/risk.txt','one')
        zipped.writestr('Project/RISK.txt','two')
    with pytest.raises(Exception,match='duplicate member paths'):
        validate_evidence_content('evidence.zip',archive.getvalue(),1024*1024)
