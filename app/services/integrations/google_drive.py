from pathlib import PurePosixPath
from urllib.parse import quote
import httpx
from app.core.config import get_settings
from app.core.validators import ALLOWED_EXTENSIONS
from app.services.integrations.github import RemoteEvidence
def google_configured() -> bool:
    s=get_settings(); return bool(s.google_client_id and s.google_client_secret)
def drive_disabled_message() -> str: return 'Google Drive is disabled until server-side OAuth configuration is complete.'


async def fetch_google_drive_folder(folder_id: str, access_token: str, max_files: int = 500) -> list[RemoteEvidence]:
    """Recursively fetch supported non-native Drive files using a request-only token."""
    if not folder_id or not access_token: raise ValueError('Provide a Google Drive folder ID and access token.')
    headers = {'Authorization': f'Bearer {access_token}'}; output: list[RemoteEvidence] = []
    async with httpx.AsyncClient(timeout=30) as client:
        async def walk(parent: str, path: str) -> None:
            params = {'q': f"'{parent}' in parents and trashed = false", 'fields': 'files(id,name,mimeType)', 'pageSize': '1000', 'supportsAllDrives': 'true', 'includeItemsFromAllDrives': 'true'}
            response = await client.get('https://www.googleapis.com/drive/v3/files', params=params, headers=headers)
            if not response.is_success: raise ValueError('Google Drive folder could not be read or access was denied.')
            for item in response.json().get('files', []):
                child = f'{path}/{item["name"]}' if path else item['name']
                if item.get('mimeType') == 'application/vnd.google-apps.folder': await walk(item['id'], child)
                elif not item.get('mimeType', '').startswith('application/vnd.google-apps.') and PurePosixPath(child).suffix.lower() in ALLOWED_EXTENSIONS:
                    if len(output) >= max_files: raise ValueError(f'Google Drive import is limited to {max_files} supported files.')
                    blob = await client.get(f"https://www.googleapis.com/drive/v3/files/{quote(item['id'], safe='')}?alt=media", headers=headers)
                    if not blob.is_success: raise ValueError(f'Google Drive file {item["name"]} could not be downloaded.')
                    output.append(RemoteEvidence(child, blob.content))
        await walk(folder_id, '')
    return output
