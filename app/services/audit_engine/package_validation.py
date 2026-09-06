from pathlib import Path
from io import BytesIO
from pathlib import PurePosixPath
import zipfile

from app.core.validators import validate_evidence_content
from app.db.init_db import PRACTICE_AREAS

def validate_package(root: Path) -> list[dict]:
    directories = [p for p in root.rglob('*') if p.is_dir()]
    result = []
    for code, name in PRACTICE_AREAS:
        matches = [d for d in directories if d.name.upper() == code or d.name.upper().startswith(f'{code} ')]
        if not matches: result.append({'code':code,'name':name,'status':'MISSING','file_count':0,'paths':[]}); continue
        files = [f for d in matches for f in d.rglob('*') if f.is_file()]
        result.append({'code':code,'name':name,'status':'AVAILABLE' if files else 'EMPTY','file_count':len(files),'paths':[str(d) for d in matches]})
    return result


def validate_package_archive(filename: str, content: bytes, max_bytes: int) -> list[dict]:
    """Validate the legacy audit-package folder convention from a safe ZIP.

    This is intentionally archive-based rather than browser-directory based so
    the relative directory names that define practice-area coverage are never
    lost during upload.
    """
    name, body = validate_evidence_content(filename, content, max_bytes)
    if Path(name).suffix.lower() != '.zip':
        raise ValueError('Package Checker accepts a ZIP audit package.')
    with zipfile.ZipFile(BytesIO(body)) as archive:
        entries = [PurePosixPath(info.filename).parts for info in archive.infolist() if not info.is_dir()]
        directories = [PurePosixPath(info.filename).parts for info in archive.infolist() if info.is_dir()]
    if not entries:
        raise ValueError('Package ZIP does not contain any files.')
    if any(not parts or '..' in parts for parts in entries):
        raise ValueError('Package ZIP contains an unsafe path.')
    # A ZIP program may add one wrapper directory around the actual package.
    roots = {parts[0] for parts in entries if len(parts) >= 2}
    known_codes = {code for code, _ in PRACTICE_AREAS}
    second_level = {parts[1].upper() for parts in entries if len(parts) >= 3}
    # Strip a conventional package wrapper ("Audit Package/PLAN/...") but
    # never strip a genuine PA root ("PLAN/subfolder/...").
    if (len(roots) == 1 and next(iter(roots)).upper() not in known_codes
            and second_level.intersection(known_codes) and all(len(parts) >= 3 for parts in entries)):
        entries = [parts[1:] for parts in entries]
        directories = [parts[1:] for parts in directories if len(parts) >= 2]
    folders: dict[str, set[str]] = {}
    for parts in entries:
        for depth in range(1, len(parts)):
            folder = '/'.join(parts[:depth])
            folders.setdefault(parts[depth - 1].upper(), set()).add(folder)
    for parts in directories:
        for depth in range(1, len(parts) + 1):
            folder = '/'.join(parts[:depth])
            folders.setdefault(parts[depth - 1].upper(), set()).add(folder)
    result = []
    for code, name in PRACTICE_AREAS:
        matches = sorted(path for folder_name, paths in folders.items()
                         if folder_name == code or folder_name.startswith(f'{code} ') for path in paths)
        file_count = sum(1 for parts in entries if any(parts[index].upper() == code or parts[index].upper().startswith(f'{code} ')
                                                  for index in range(len(parts) - 1)))
        result.append({'code': code, 'name': name,
                       'status': 'AVAILABLE' if file_count else 'EMPTY' if matches else 'MISSING',
                       'file_count': file_count, 'paths': matches})
    return result
