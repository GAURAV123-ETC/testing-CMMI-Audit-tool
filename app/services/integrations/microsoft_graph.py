from pathlib import PurePosixPath
from urllib.parse import quote, urlparse
import httpx
from app.core.config import get_settings
from app.core.validators import ALLOWED_EXTENSIONS
from app.services.integrations.github import RemoteEvidence
def microsoft_configured() -> bool:
    s=get_settings(); return bool(s.microsoft_oauth_enabled and s.azure_tenant_id and s.azure_client_id and s.azure_client_secret and s.microsoft_redirect_uri)
def graph_disabled_message() -> str: return 'Microsoft Graph is disabled until server-side Azure OAuth configuration is complete.'


async def fetch_sharepoint_folder(site_url: str, drive_name: str, folder_path: str, access_token: str, max_files: int = 500) -> list[RemoteEvidence]:
    """Recursively fetch supported SharePoint artifacts using a request-only Graph token."""
    parsed = urlparse((site_url or '').strip())
    if parsed.scheme != 'https' or not parsed.netloc or not access_token:
        raise ValueError('Provide an HTTPS SharePoint site URL and a Microsoft Graph access token.')
    clean_path = (folder_path or '').strip().strip('/')
    if '..' in PurePosixPath(clean_path).parts:
        raise ValueError('SharePoint folder path cannot contain parent-directory segments.')
    headers = {'Authorization': f'Bearer {access_token}'}
    async with httpx.AsyncClient(timeout=30) as client:
        site = await client.get(f'https://graph.microsoft.com/v1.0/sites/{parsed.netloc}:{parsed.path}', headers=headers)
        if not site.is_success: raise ValueError('SharePoint site could not be resolved or access was denied.')
        drives = await client.get(f"https://graph.microsoft.com/v1.0/sites/{site.json()['id']}/drives", headers=headers)
        if not drives.is_success: raise ValueError('SharePoint document libraries could not be read.')
        choices = drives.json().get('value', [])
        drive = next((item for item in choices if item.get('name', '').lower() == (drive_name or 'Documents').lower()), choices[0] if choices else None)
        if not drive: raise ValueError('No SharePoint document library was found.')
        output: list[RemoteEvidence] = []
        async def walk(path: str) -> None:
            encoded = f':/{"/".join(quote(part, safe="") for part in path.split("/"))}:' if path else ''
            response = await client.get(f"https://graph.microsoft.com/v1.0/drives/{drive['id']}/root{encoded}/children", headers=headers)
            if not response.is_success: raise ValueError('SharePoint folder could not be read.')
            for item in response.json().get('value', []):
                child = f'{path}/{item["name"]}' if path else item['name']
                if item.get('folder'):
                    await walk(child)
                elif item.get('file') and PurePosixPath(child).suffix.lower() in ALLOWED_EXTENSIONS:
                    if len(output) >= max_files: raise ValueError(f'SharePoint import is limited to {max_files} supported files. Narrow the folder path.')
                    blob = await client.get(f"https://graph.microsoft.com/v1.0/drives/{drive['id']}/items/{item['id']}/content", headers=headers)
                    if not blob.is_success: raise ValueError(f'SharePoint file {item["name"]} could not be downloaded.')
                    output.append(RemoteEvidence(child, blob.content))
        await walk(clean_path)
        return output
