from pathlib import Path
from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader
from pptx import Presentation
from app.services.document_processing.tabular import read_tabular_rows
from app.services.document_processing.ocr import ocr_image, ocr_image_bytes


SCANNED_PDF_AVG_CHARS_PER_PAGE = 40
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'}


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

def extract_text(path: str) -> str:
    file = Path(path); suffix = file.suffix.lower()
    try:
        if suffix == '.xlsx':
            workbook = load_workbook(file, read_only=True, data_only=False)
            sections=[]
            for sheet in workbook.worksheets:
                sections.append(f'[Sheet: {sheet.title}]')
                sections.extend(' '.join(str(value or '') for value in row) for row in sheet.iter_rows(values_only=True))
            return '\n'.join(sections)
        if suffix == '.xls':
            return '\n'.join(' '.join(str(value or '') for value in row) for row in read_tabular_rows(str(file)))
        if suffix == '.docx':
            document=Document(file)
            paragraphs=[p.text for p in document.paragraphs]
            table_rows=[' '.join(cell.text for cell in row.cells) for table in document.tables for row in table.rows]
            return '\n'.join(paragraphs+table_rows)
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
