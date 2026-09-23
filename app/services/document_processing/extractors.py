import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ElementTree
import zipfile
from pypdf import PdfReader
from pptx import Presentation
from app.core.config import get_settings
from app.services.document_processing.tabular import cell_text, read_tabular_sheets
from app.services.document_processing.ocr import ocr_image, ocr_image_bytes
from app.services.document_processing.file_security import validate_zip


SCANNED_PDF_AVG_CHARS_PER_PAGE = 40
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'}
LEGACY_WORD_SIGNATURE = bytes.fromhex('D0CF11E0A1B11AE1')
WORD_DOCUMENT_XML = 'word/document.xml'
MAX_RECOVERY_DOCUMENT_XML_BYTES = 20 * 1024 * 1024
MAX_OFFICE_TEXT_XML_BYTES = 50 * 1024 * 1024
WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
DRAWING_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main'
SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
WORD_TEXT_PART = re.compile(
    r'^word/(?:document|header\d+|footer\d+|footnotes|endnotes|comments|charts/[^/]+|diagrams/[^/]+)\.xml$',
    re.I,
)
EXCEL_AUXILIARY_TEXT_PART = re.compile(
    r'^xl/(?:drawings/[^/]+|charts/[^/]+|diagrams/[^/]+|comments(?:/[^/]+|\d+)|threadedComments/[^/]+)\.xml$',
    re.I,
)


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
    script = r"""
$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  try { $word.AutomationSecurity = 3 } catch {}
  $document = $word.Documents.Open($env:CMMI_DOC_INPUT, $false, $true, $false)
  $parts = New-Object 'System.Collections.Generic.List[string]'
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  function Add-TextPart {
    param([object]$Value)
    if ($null -eq $Value) { return }
    $text = [string]$Value
    if (-not [string]::IsNullOrWhiteSpace($text) -and $seen.Add($text)) {
      $parts.Add($text)
    }
  }
  # StoryRanges covers main paragraphs/tables plus headers, footers,
  # footnotes, endnotes, comments, and text-frame stories.
  foreach ($story in $document.StoryRanges) {
    $range = $story
    while ($null -ne $range) {
      Add-TextPart $range.Text
      $range = $range.NextStoryRange
    }
  }
  function Add-ShapeText {
    param([object]$Shapes)
    foreach ($shape in $Shapes) {
      try {
        if ($shape.TextFrame.HasText -ne 0) {
          Add-TextPart $shape.TextFrame.TextRange.Text
        }
      } catch {}
      try {
        if ($shape.GroupItems.Count -gt 0) { Add-ShapeText $shape.GroupItems }
      } catch {}
    }
  }
  Add-ShapeText $document.Shapes
  foreach ($section in $document.Sections) {
    foreach ($header in $section.Headers) { Add-ShapeText $header.Shapes }
    foreach ($footer in $section.Footers) { Add-ShapeText $footer.Shapes }
  }
  if ($parts.Count -eq 0) { Add-TextPart $document.Content.Text }
  [System.IO.File]::WriteAllText(
    $env:CMMI_DOC_OUTPUT,
    [string]::Join("`r`n", $parts),
    [System.Text.UTF8Encoding]::new($true)
  )
} finally {
  if ($document) { $document.Close($false) }
  if ($word) { $word.Quit() }
}
"""
    try:
        completed = None
        # Word COM startup can transiently fail while the previous isolated
        # automation process releases its profile. Retry a small bounded
        # number of times; every attempt has its own hard timeout and finally
        # block, so no orphaned Word process is intentionally retained.
        for attempt in range(3):
            completed = subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                capture_output=True, text=True, timeout=30, check=False,
                env={**os.environ, 'CMMI_DOC_INPUT': str(path), 'CMMI_DOC_OUTPUT': str(output)},
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0,
            )
            if completed.returncode == 0 and output.exists():
                break
            if attempt < 2:
                time.sleep(1)
        if completed is None or completed.returncode != 0 or not output.exists():
            return '[Extraction error: legacy .doc conversion failed]'
        raw = output.read_bytes()
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('mbcs', errors='replace')
        # Word table separators and page breaks are control characters. They
        # carry layout, not evidence meaning; convert them to readable lines.
        text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]+', '\n', text).strip()
        return text or '[Extraction error: legacy .doc contains no readable text]'
    except (OSError, subprocess.TimeoutExpired):
        return '[Extraction error: legacy .doc conversion unavailable]'
    finally:
        output.unlink(missing_ok=True)


def _safe_xml_root(content: bytes, label: str):
    markup = content.upper()
    if b'<!DOCTYPE' in markup or b'<!ENTITY' in markup:
        raise ValueError(f'{label} contains unsupported declarations')
    return ElementTree.fromstring(content)


def _nearest_ancestor_with_tag(node, parent_by_node: dict, tag: str):
    current = parent_by_node.get(node)
    while current is not None:
        if current.tag == tag:
            return current
        current = parent_by_node.get(current)
    return None


def _word_xml_text(content: bytes) -> list[str]:
    """Read paragraphs, tables and nested text boxes once in XML order."""
    root = _safe_xml_root(content, 'Office XML')
    word_paragraph = f'{{{WORD_NAMESPACE}}}p'
    word_text = f'{{{WORD_NAMESPACE}}}t'
    drawing_text = f'{{{DRAWING_NAMESPACE}}}t'
    word_tab = f'{{{WORD_NAMESPACE}}}tab'
    word_breaks = {f'{{{WORD_NAMESPACE}}}br', f'{{{WORD_NAMESPACE}}}cr'}
    parent_by_node = {child: parent for parent in root.iter() for child in parent}
    lines = []
    for paragraph in root.iter(word_paragraph):
        parts = []
        for node in paragraph.iter():
            # A VML/DrawingML text box can contain its own w:p inside an
            # enclosing paragraph. Attribute its text only to the inner p.
            if node is not paragraph and _nearest_ancestor_with_tag(
                    node, parent_by_node, word_paragraph) is not paragraph:
                continue
            if node.tag in {word_text, drawing_text} and node.text:
                parts.append(node.text)
            elif node.tag == word_tab:
                parts.append('\t')
            elif node.tag in word_breaks:
                parts.append('\n')
        text = ''.join(parts).strip()
        if text:
            lines.append(text)
    # Drawing text not hosted by a Word paragraph (for example, some chart
    # titles) must still be searchable.
    for node in root.iter(drawing_text):
        if node.text and _nearest_ancestor_with_tag(node, parent_by_node, word_paragraph) is None:
            text = node.text.strip()
            if text:
                lines.append(text)
    return lines


def _extract_docx_ooxml(path: Path) -> str:
    """Safely read all searchable Word OOXML stories, including text boxes."""
    try:
        validate_zip(path, max_uncompressed=100 * 1024 * 1024)
        with zipfile.ZipFile(path) as archive:
            names = {member.filename.replace('\\', '/') for member in archive.infolist()}
            if WORD_DOCUMENT_XML not in names:
                if any(name.startswith('theme/') for name in names) and not any(name.startswith('word/') for name in names):
                    return '[Unsupported Office package: DOCX extension contains only Office theme data, not a Word document]'
                if any(name.startswith('xl/') for name in names):
                    return '[Unsupported Office package: DOCX extension contains an Excel workbook, not a Word document]'
                return '[Unsupported Office package: DOCX has no word/document.xml content]'
            members = sorted(
                (member for member in archive.infolist()
                 if WORD_TEXT_PART.fullmatch(member.filename.replace('\\', '/'))),
                key=lambda member: (member.filename.replace('\\', '/') != WORD_DOCUMENT_XML,
                                    member.filename.casefold()),
            )
            if any(member.file_size > MAX_RECOVERY_DOCUMENT_XML_BYTES for member in members):
                return '[Extraction error: DOCX text XML exceeds the safe per-part limit]'
            if sum(member.file_size for member in members) > MAX_OFFICE_TEXT_XML_BYTES:
                return '[Extraction error: DOCX text XML exceeds the safe total limit]'
            lines = [line for member in members for line in _word_xml_text(archive.read(member))]
        return '\n'.join(lines) or '[Extraction error: DOCX contains no readable document text]'
    except (ElementTree.ParseError, OSError, ValueError, zipfile.BadZipFile):
        return '[Extraction error: invalid DOCX package]'


# Backwards-compatible name retained for callers/tests written for the
# original main-document recovery path.
_recover_mispackaged_docx = _extract_docx_ooxml


def _extract_xlsx_auxiliary_text(path: Path) -> str:
    """Read text outside the Excel cell grid (boxes, charts and comments)."""
    try:
        validate_zip(path, max_uncompressed=100 * 1024 * 1024)
        with zipfile.ZipFile(path) as archive:
            members = [
                member for member in archive.infolist()
                if EXCEL_AUXILIARY_TEXT_PART.fullmatch(member.filename.replace('\\', '/'))
            ]
            if sum(member.file_size for member in members) > MAX_OFFICE_TEXT_XML_BYTES:
                return '[Extraction warning: Excel auxiliary text exceeds the safe limit]'
            lines = []
            for member in sorted(members, key=lambda item: item.filename.casefold()):
                root = _safe_xml_root(archive.read(member), 'Excel XML')
                is_comment = '/comments' in member.filename.replace('\\', '/').lower()
                wanted_tag = (f'{{{SPREADSHEET_NAMESPACE}}}t' if is_comment
                              else f'{{{DRAWING_NAMESPACE}}}t')
                lines.extend(node.text.strip() for node in root.iter(wanted_tag)
                             if node.text and node.text.strip())
            return '\n'.join(dict.fromkeys(lines))
    except (ElementTree.ParseError, OSError, ValueError, zipfile.BadZipFile):
        return '[Extraction warning: Excel auxiliary text could not be read]'

def extract_text(path: str) -> str:
    file = Path(path); suffix = file.suffix.lower()
    try:
        if suffix in {'.xlsx', '.xls'}:
            extracted_cell_text = '\n'.join(
                f'[Sheet: {sheet_name}]\n' + '\n'.join(
                    ' '.join(cell_text(value) for value in row) for row in rows
                )
                for sheet_name, rows in read_tabular_sheets(str(file), data_only=False)
            )
            auxiliary_text = _extract_xlsx_auxiliary_text(file) if suffix == '.xlsx' else ''
            return '\n'.join(part for part in (
                extracted_cell_text,
                f'[Excel text boxes, charts and comments]\n{auxiliary_text}' if auxiliary_text else '',
            ) if part)
        if suffix == '.docx':
            return _extract_docx_ooxml(file)
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
