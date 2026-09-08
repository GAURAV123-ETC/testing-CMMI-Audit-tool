import os
from pathlib import Path
import subprocess
import tempfile
from docx import Document
from pypdf import PdfReader
from pptx import Presentation
from app.core.config import get_settings
from app.services.document_processing.tabular import read_tabular_sheets
from app.services.document_processing.ocr import ocr_image, ocr_image_bytes


SCANNED_PDF_AVG_CHARS_PER_PAGE = 40
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'}
LEGACY_WORD_SIGNATURE = bytes.fromhex('D0CF11E0A1B11AE1')


def _ocr_pdf(path: Path) -> str:
    """OCR every page of a scanned PDF, matching the legacy scanner behavior."""
    try:
        import pymupdf
    except ImportError:
        return '[OCR unavailable: install PyMuPDF and the Tesseract system package]'
    try:
        document = pymupdf.open(path)
        pages = []
        for page in document:
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
            text = ocr_image_bytes(pixmap.tobytes('png'))
            if text.startswith('[OCR '):
                return text
            pages.append(text)
        return '\n'.join(pages) or '[OCR error: no readable text found]'
    except Exception as exc:
        return f'[OCR error: {type(exc).__name__}]'


def _extract_legacy_doc(path: Path) -> str:
    """Convert an OLE Word document to text through locally installed Word.

    This is deliberately an opt-in Windows fallback.  Macros and link
    updates are disabled, the source opens read-only, and only a temporary
    text file is written.  Unsupported platforms retain an actionable parse
    finding rather than pretending that opaque binary data is evidence.
    """
    with path.open('rb') as stream:
        signature = stream.read(8)
    if signature != LEGACY_WORD_SIGNATURE:
        return '[Unsupported legacy format: invalid .doc file]'
    if os.name != 'nt':
        return '[Unsupported legacy format: convert .doc to DOCX or install a server-side converter]'
    if not get_settings().legacy_doc_conversion_enabled:
        return '[Unsupported legacy format: .doc conversion is disabled; upload DOCX or enable a hardened converter]'
    descriptor, temporary_name = tempfile.mkstemp(suffix='.txt')
    os.close(descriptor)
    output = Path(temporary_name)
    output.unlink(missing_ok=True)
    script = f"""
$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
try {{
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  try {{ $word.AutomationSecurity = 3 }} catch {{}}
  $document = $word.Documents.Open($env:CMMI_DOC_INPUT, $false, $true, $false)
  $document.SaveAs2($env:CMMI_DOC_OUTPUT, 2)
}} finally {{
  if ($document) {{ $document.Close($false) }}
  if ($word) {{ $word.Quit() }}
}}
"""
    try:
        completed = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
            capture_output=True, text=True, timeout=90, check=False,
            env={**os.environ, 'CMMI_DOC_INPUT': str(path), 'CMMI_DOC_OUTPUT': str(output)},
        )
        if completed.returncode != 0 or not output.exists():
            return '[Extraction error: legacy .doc conversion failed]'
        raw = output.read_bytes()
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('mbcs', errors='replace')
        text = text.strip()
        return text or '[Extraction error: legacy .doc contains no readable text]'
    except (OSError, subprocess.TimeoutExpired):
        return '[Extraction error: legacy .doc conversion unavailable]'
    finally:
        output.unlink(missing_ok=True)

def extract_text(path: str) -> str:
    file = Path(path); suffix = file.suffix.lower()
    try:
        if suffix in {'.xlsx', '.xls'}:
            return '\n'.join(
                f'[Sheet: {sheet_name}]\n' + '\n'.join(
                    ' '.join(str(value or '') for value in row) for row in rows
                )
                for sheet_name, rows in read_tabular_sheets(str(file), data_only=False)
            )
        if suffix == '.docx':
            document=Document(file)
            paragraphs=[p.text for p in document.paragraphs]
            table_rows=[' '.join(cell.text for cell in row.cells) for table in document.tables for row in table.rows]
            return '\n'.join(paragraphs+table_rows)
        if suffix == '.doc':
            return _extract_legacy_doc(file)
        if suffix == '.pdf':
            pages = PdfReader(str(file)).pages
            text = '\n'.join(page.extract_text() or '' for page in pages)
            # The legacy implementation OCRed PDFs whose text layer was too
            # sparse to be useful. Keep that behavior server-side.
            if len(text.replace(' ', '').replace('\n', '')) < SCANNED_PDF_AVG_CHARS_PER_PAGE * max(1, len(pages)):
                return _ocr_pdf(file)
            return text
        if suffix == '.pptx': return '\n'.join(shape.text for slide in Presentation(str(file)).slides for shape in slide.shapes if hasattr(shape,'text'))
        if suffix in {'.csv', '.txt', '.md', '.json', '.xml'}: return file.read_text(encoding='utf-8', errors='replace')
        if suffix in IMAGE_SUFFIXES: return ocr_image(str(file))
    except Exception as exc: return f'[Extraction error: {type(exc).__name__}]'
    return '[Unsupported legacy format: use DOCX/PPTX or enable LibreOffice conversion]'
