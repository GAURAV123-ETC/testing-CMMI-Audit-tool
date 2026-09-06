from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.api.deps import current_user, require_screen
from app.db.database import get_db
from app.db.models import AuditSession
from app.services.evidence_ingestion import persist_remote_evidence
from app.services.integrations.github import fetch_github_repository, parse_repository
from app.services.integrations.google_drive import drive_disabled_message, google_configured
from app.services.integrations.google_drive import fetch_google_drive_folder
from app.services.integrations.microsoft_graph import graph_disabled_message, microsoft_configured
from app.services.integrations.microsoft_graph import fetch_sharepoint_folder
router=APIRouter(prefix='/integrations',tags=['integrations'])


class GithubImportIn(BaseModel):
    audit_session_id: int
    repository: str = Field(min_length=3, max_length=512)
    branch: str = Field(default='main', min_length=1, max_length=255)
    folder_path: str = Field(default='', max_length=1024)
    token: str | None = Field(default=None, max_length=2048)

class SharePointImportIn(BaseModel):
    audit_session_id: int; site_url: str = Field(max_length=2048); drive_name: str = Field(default='Documents', max_length=255); folder_path: str = Field(default='', max_length=1024); access_token: str = Field(min_length=20, max_length=8192)
class GoogleDriveImportIn(BaseModel):
    audit_session_id: int; folder_id: str = Field(min_length=3, max_length=255); access_token: str = Field(min_length=20, max_length=8192)


@router.get('/status')
def status(user=Depends(current_user), screen_user=Depends(require_screen('integrations'))):
    return {'github':{'enabled':True,'message':'Public scan enabled; private tokens are request/session only.'},'microsoft_graph':{'enabled':microsoft_configured(),'message':None if microsoft_configured() else graph_disabled_message()},'google_drive':{'enabled':google_configured(),'message':None if google_configured() else drive_disabled_message()}}


@router.post('/github/import')
async def import_github(payload: GithubImportIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('integrations', 'write'))):
    """Import a repository's supported evidence files without storing its token."""
    if not db.get(AuditSession, payload.audit_session_id):
        raise HTTPException(404, 'Audit session not found')
    try:
        owner, repository = parse_repository(payload.repository)
        artifacts = await fetch_github_repository(owner, repository, payload.token, payload.branch, payload.folder_path)
        if not artifacts:
            raise ValueError('No supported evidence files were found at this GitHub location.')
        count = persist_remote_evidence(db, payload.audit_session_id, user.id, 'github',
                                        f'https://github.com/{owner}/{repository}/tree/{payload.branch}',
                                        [(artifact.path, artifact.content) for artifact in artifacts])
        db.commit()
        return {'imported_files': count, 'source': f'{owner}/{repository}', 'branch': payload.branch, 'folder_path': payload.folder_path or '/'}
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    except Exception:
        db.rollback()
        raise HTTPException(502, 'GitHub import failed. Check repository access, branch, and network availability.')

async def _persist_provider(db, user, audit_session_id, source_type, source_uri, artifacts):
    if not db.get(AuditSession, audit_session_id): raise HTTPException(404, 'Audit session not found')
    if not artifacts: raise HTTPException(422, 'No supported evidence files were found at this provider location.')
    count = persist_remote_evidence(db, audit_session_id, user.id, source_type, source_uri, [(item.path, item.content) for item in artifacts]); db.commit()
    return {'imported_files': count, 'source_type': source_type}

@router.post('/sharepoint/import')
async def import_sharepoint(payload: SharePointImportIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('integrations', 'write'))):
    try: return await _persist_provider(db, user, payload.audit_session_id, 'sharepoint', payload.site_url, await fetch_sharepoint_folder(payload.site_url, payload.drive_name, payload.folder_path, payload.access_token))
    except HTTPException: raise
    except ValueError as exc: db.rollback(); raise HTTPException(422, str(exc)) from exc
    except Exception: db.rollback(); raise HTTPException(502, 'SharePoint import failed. Check site, library, folder, token, and network.')

@router.post('/google-drive/import')
async def import_google_drive(payload: GoogleDriveImportIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('integrations', 'write'))):
    try: return await _persist_provider(db, user, payload.audit_session_id, 'google_drive', f'google-drive://{payload.folder_id}', await fetch_google_drive_folder(payload.folder_id, payload.access_token))
    except HTTPException: raise
    except ValueError as exc: db.rollback(); raise HTTPException(422, str(exc)) from exc
    except Exception: db.rollback(); raise HTTPException(502, 'Google Drive import failed. Check folder ID, token, and network.')
