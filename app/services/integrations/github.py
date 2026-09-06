from dataclasses import dataclass
from pathlib import PurePosixPath
import re
from urllib.parse import quote
import httpx
from app.core.validators import ALLOWED_EXTENSIONS


@dataclass
class RemoteEvidence: path: str; content: bytes


def parse_repository(value: str) -> tuple[str, str]:
    """Accept ``owner/repository`` or a GitHub repository URL."""
    text = (value or '').strip().removesuffix('.git').rstrip('/')
    if text.startswith('https://github.com/'):
        text = text.removeprefix('https://github.com/')
    parts = text.split('/')
    if len(parts) != 2 or not all(parts) or not all(re.fullmatch(r'[A-Za-z0-9_.-]+', part) for part in parts):
        raise ValueError('Enter a GitHub repository as owner/repository or https://github.com/owner/repository.')
    return parts[0], parts[1]


async def fetch_github_repository(owner: str, repository: str, token: str | None = None,
                                  branch: str = 'main', path_prefix: str = '', max_files: int = 500) -> list[RemoteEvidence]:
    """Download supported evidence blobs only; credentials are never persisted."""
    if not owner or not repository:
        raise ValueError('Both GitHub owner and repository are required.')
    clean_branch = (branch or 'main').strip()
    clean_prefix = (path_prefix or '').strip().strip('/')
    if '..' in PurePosixPath(clean_prefix).parts:
        raise ValueError('GitHub folder path cannot contain parent-directory segments.')
    headers={'Accept':'application/vnd.github+json'}
    if token: headers['Authorization']=f'Bearer {token}'
    async with httpx.AsyncClient(timeout=30) as client:
        response=await client.get(f'https://api.github.com/repos/{owner}/{repository}/git/trees/{quote(clean_branch, safe="")}?recursive=1',headers=headers)
        if response.status_code == 404:
            raise ValueError('GitHub repository, branch, or folder was not found.')
        if response.status_code in {401, 403, 429}:
            raise ValueError('GitHub access was denied or rate-limited. Provide a valid token for a private repository or retry later.')
        response.raise_for_status()
        tree = response.json()
        if tree.get('truncated'):
            raise ValueError('GitHub returned a truncated repository tree. Import a smaller folder path for a complete audit.')
        items=tree.get('tree',[]); output=[]
        for item in items:
            item_path = item.get('path', '')
            if item.get('type') != 'blob' or (clean_prefix and not item_path.startswith(f'{clean_prefix}/')):
                continue
            if PurePosixPath(item_path).suffix.lower() not in ALLOWED_EXTENSIONS:
                continue
            if len(output) >= max_files:
                raise ValueError(f'GitHub import is limited to {max_files} supported evidence files. Narrow the folder path.')
            blob=await client.get(item['url'],headers=headers); blob.raise_for_status(); import base64
            output.append(RemoteEvidence(item_path,base64.b64decode(blob.json()['content'])))
        return output
