from io import BytesIO
from pathlib import Path
import zipfile
from fastapi import HTTPException, UploadFile, status
from app.services.document_processing.file_security import validate_zip

ALLOWED_EXTENSIONS = {'.xlsx', '.xls', '.csv', '.txt', '.md', '.json', '.xml', '.doc', '.docx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.zip'}
BLOCKED_EXTENSIONS = {'.exe', '.bat', '.cmd', '.com', '.ps1', '.js', '.vbs', '.sh', '.msi'}

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
    if Path(name).suffix.lower() == '.zip':
        try:
            validate_zip(BytesIO(content), max_uncompressed=min(500 * 1024 * 1024, max_bytes * 10))
        except (ValueError, zipfile.BadZipFile) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f'Unsafe ZIP archive: {exc}') from exc
    return name, content
