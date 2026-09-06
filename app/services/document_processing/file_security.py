from pathlib import Path
from typing import BinaryIO
import zipfile


def validate_zip(path: str | Path | BinaryIO, max_members: int = 500, max_uncompressed: int = 500 * 1024 * 1024,
                 max_depth: int = 20, max_ratio: int = 200) -> None:
    """Reject unsafe ZIPs before their bytes are persisted or extracted."""
    with zipfile.ZipFile(path) as archive:
        members=archive.infolist()
        if len(members) > max_members or sum(m.file_size for m in members) > max_uncompressed: raise ValueError('Unsafe ZIP archive size or file count')
        names=set()
        for member in members:
            normalized=member.filename.replace('\\','/')
            parts=Path(normalized).parts
            if not normalized or normalized.startswith(('/', '\\')) or '..' in parts or '\x00' in normalized:
                raise ValueError('ZIP path traversal blocked')
            if len(parts) > max_depth: raise ValueError('ZIP nesting depth exceeds the configured limit')
            folded=normalized.casefold()
            if folded in names: raise ValueError('ZIP contains duplicate member paths')
            names.add(folded)
            if member.flag_bits & 0x1: raise ValueError('Encrypted ZIP members are not supported')
            unix_mode=(member.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000: raise ValueError('ZIP symbolic links are not allowed')
            compressed=max(1,member.compress_size)
            if member.file_size > 1024*1024 and member.file_size/compressed > max_ratio:
                raise ValueError('Suspicious ZIP compression ratio')
