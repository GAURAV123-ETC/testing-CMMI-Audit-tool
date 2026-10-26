from io import BytesIO
from pathlib import Path
import zipfile
from fastapi import HTTPException, UploadFile, status
from app.services.document_processing.file_security import validate_zip

ALLOWED_EXTENSIONS = {'.xlsx', '.xls', '.csv', '.txt', '.md', '.json', '.xml', '.doc', '.docx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.zip'}
BLOCKED_EXTENSIONS = {'.exe', '.bat', '.cmd', '.com', '.ps1', '.js', '.vbs', '.sh', '.msi'}


def _validate_content_signature(name: str, content: bytes) -> None:
    """Reject obvious extension spoofing before handing bytes to parsers/OCR."""
    suffix = Path(name).suffix.lower()
    signatures = {
        '.pdf': (b'%PDF-',), '.png': (b'\x89PNG\r\n\x1a\n',), '.jpg': (b'\xff\xd8\xff',),
        '.jpeg': (b'\xff\xd8\xff',), '.bmp': (b'BM',), '.tif': (b'II*\x00', b'MM\x00*'),
        '.tiff': (b'II*\x00', b'MM\x00*'),
    }
    if suffix in {'.zip', '.xlsx', '.docx', '.pptx'}:
        if not content.startswith(b'PK'):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, 'File content does not match its extension')
    elif suffix in signatures and not content.startswith(signatures[suffix]):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, 'File content does not match its extension')
    if suffix in {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'}:
        try:
            from PIL import Image
            from app.core.config import get_settings
            with Image.open(BytesIO(content)) as image:
                width, height = image.size
                if width * height > get_settings().max_image_pixels:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, 'Image exceeds configured pixel limit')
                image.verify()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, 'Invalid image content') from exc

def safe_filename(name: str) -> str:
    candidate = Path(name or '').name
    if not candidate or candidate in {'.', '..'} or '\x00' in candidate:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, 'Invalid file name')
    if Path(candidate).suffix.lower() in BLOCKED_EXTENSIONS:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, 'Executable files are not allowed')
    return candidate

async def validate_upload(upload: UploadFile, max_bytes: int) -> tuple[str, bytes]:
    content = await upload.read(max_bytes + 1)
    return validate_evidence_content(upload.filename or '', content, max_bytes)


def validate_evidence_content(filename: str, content: bytes, max_bytes: int) -> tuple[str, bytes]:
    """Validation shared by FastAPI and NiceGUI evidence uploads."""
    name = safe_filename(filename)
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, 'Unsupported evidence format')
    if len(content) > max_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, 'Upload exceeds configured size limit')
    if not content:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, 'Empty upload')
    _validate_content_signature(name, content)
    if Path(name).suffix.lower() in {'.zip', '.xlsx', '.docx', '.pptx'}:
        try:
            validate_zip(BytesIO(content), max_uncompressed=min(500 * 1024 * 1024, max_bytes * 10))
        except (ValueError, zipfile.BadZipFile) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f'Unsafe ZIP archive: {exc}') from exc
    return name, content
