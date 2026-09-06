"""Persisted replacement for the legacy Repository Scan menu."""
import hashlib
import uuid
from pathlib import Path

from nicegui import ui
from app.core.screen_registry import screen_url
from sqlalchemy import select

from app.core.config import get_settings
from app.core.validators import validate_evidence_content
from app.db.database import SessionLocal
from app.db.models import (AuditSession, AuditSessionPracticeArea, EvidenceFile,
                           EvidenceSource, PracticeArea)
from app.gui.layout import layout
from app.gui.pages.audit_workspace import _allowed, _current_user_id
from app.services.audit_engine.evidence_scan import scan_session
from app.services.evidence_ingestion import persist_remote_evidence
from app.services.integrations.github import fetch_github_repository, parse_repository
from app.services.integrations.microsoft_graph import fetch_sharepoint_folder
from app.services.integrations.google_drive import fetch_google_drive_folder


def _session_options() -> dict[int, str]:
    with SessionLocal() as db:
        return {item.id: f'Audit session #{item.id}' for item in db.scalars(select(AuditSession).order_by(AuditSession.created_at.desc())).all()}


def _coverage(session_id: int) -> list[dict]:
    with SessionLocal() as db:
        rows = db.execute(select(AuditSessionPracticeArea, PracticeArea).join(
            PracticeArea, AuditSessionPracticeArea.practice_area_id == PracticeArea.id
        ).where(AuditSessionPracticeArea.audit_session_id == session_id)).all()
    return [{'code': pa.code, 'name': pa.name,
             'status': 'Available' if row.folder_status == 'available' and row.evidence_status == 'available'
             else 'Gap' if row.evidence_status == 'gap'
             else 'Missing' if row.folder_status == 'missing' else 'Not scanned'} for row, pa in rows]


def register():
    @ui.page(screen_url('repository_scan'))
    def repository_scan_page():
        layout('Repository Scan', 'Upload project artifacts and calculate persisted CMMI practice-area coverage.')
        if not (_allowed('evidence:write') or _allowed('audits:write')):
            ui.label('You do not have permission to scan repository evidence.').classes('text-negative')
            return
        sessions = _session_options()
        if not sessions:
            ui.label('Create an audit session in Audit Workspace before scanning repository artifacts.').classes('text-slate-600')
            ui.button('Open Audit Workspace', on_click=lambda: ui.navigate.to('/audit-workspace')).props('color=primary')
            return
        selected = ui.select(sessions, value=next(iter(sessions)), label='Audit session').classes('w-80')
        files = ui.column().classes('w-full')
        results = ui.column().classes('w-full')

        def show_files() -> None:
            files.clear()
            if not selected.value:
                return
            with SessionLocal() as db:
                rows = db.scalars(select(EvidenceFile).join(EvidenceSource).where(
                    EvidenceSource.audit_session_id == int(selected.value)
                ).order_by(EvidenceFile.created_at.desc())).all()
            with files:
                ui.label(f'{len(rows)} indexed artifact(s)').classes('font-bold mt-4')
                for item in rows[:100]:
                    with ui.row().classes('w-full justify-between border-b border-slate-100 py-1'):
                        ui.label(item.relative_path).classes('text-sm')
                        ui.label(f'{item.size_bytes:,} bytes').classes('text-xs text-slate-600')

        def show_coverage() -> None:
            results.clear()
            if not selected.value:
                return
            rows = _coverage(int(selected.value))
            with results:
                ui.label('Practice-area validation').classes('text-xl font-bold mt-5')
                ui.table(columns=[{'name': key, 'label': label, 'field': key, 'align': 'left'} for key, label in (
                    ('code', 'Code'), ('name', 'Practice Area'), ('status', 'Status'))], rows=rows, row_key='code').classes('w-full')

        def upload_artifact(event) -> None:
            if not _allowed('evidence:write'):
                ui.notify('You do not have permission to upload evidence.', type='negative'); return
            if not selected.value:
                ui.notify('Select an audit session first.', type='warning'); return
            try:
                name, content = validate_evidence_content(event.name, event.content.read(), get_settings().max_upload_mb * 1024 * 1024)
                directory = get_settings().upload_dir / str(selected.value); directory.mkdir(parents=True, exist_ok=True)
                stored = directory / f'{uuid.uuid4().hex}_{name}'; stored.write_bytes(content)
                with SessionLocal() as db:
                    source = EvidenceSource(audit_session_id=int(selected.value), source_type='repository_upload', created_by_id=_current_user_id())
                    db.add(source); db.flush()
                    db.add(EvidenceFile(source_id=source.id, relative_path=name,
                                        storage_path=str(stored.relative_to(get_settings().upload_dir.parent)),
                                        sha256=hashlib.sha256(content).hexdigest(), mime_type=event.type or None, size_bytes=len(content)))
                    db.commit()
                show_files(); ui.notify(f'Indexed {name}.', type='positive')
            except Exception as exc:
                ui.notify(str(exc), type='negative')

        def run_repository_scan() -> None:
            if not _allowed('audits:write'):
                ui.notify('You do not have permission to run a scan.', type='negative'); return
            try:
                with SessionLocal() as db:
                    outcome = scan_session(db, int(selected.value), _current_user_id())
                show_coverage(); ui.notify(f"Scan complete: {outcome['findings_created']} finding(s).", type='positive')
            except Exception as exc:
                ui.notify(f'Scan failed: {exc}', type='negative')

        with ui.expansion('Import supported evidence from GitHub').classes('w-full max-w-2xl mt-4'):
            ui.label('A GitHub token is optional for public repositories and is used only for this import; it is never stored.').classes('text-sm text-slate-600')
            repository = ui.input('Repository', placeholder='owner/repository or https://github.com/owner/repository').classes('w-full')
            with ui.row().classes('gap-3 flex-wrap'):
                branch = ui.input('Branch', value='main').classes('w-48')
                folder = ui.input('Folder path (optional)', placeholder='evidence/2026').classes('w-64')
                token = ui.input('Personal access token (optional)', password=True, password_toggle_button=True).classes('w-72')

            async def import_github() -> None:
                if not _allowed('evidence:write'):
                    ui.notify('You do not have permission to import evidence.', type='negative')
                    return
                if not selected.value:
                    ui.notify('Select an audit session first.', type='warning')
                    return
                try:
                    owner, repo = parse_repository(repository.value or '')
                    artifacts = await fetch_github_repository(owner, repo, token.value or None, branch.value or 'main', folder.value or '')
                    if not artifacts:
                        raise ValueError('No supported evidence files were found at this GitHub location.')
                    with SessionLocal() as db:
                        count = persist_remote_evidence(db, int(selected.value), _current_user_id(), 'github',
                                                        f'https://github.com/{owner}/{repo}/tree/{branch.value or "main"}',
                                                        [(artifact.path, artifact.content) for artifact in artifacts])
                        db.commit()
                    token.value = ''
                    show_files()
                    ui.notify(f'Imported {count} GitHub evidence file(s).', type='positive')
                except ValueError as exc:
                    ui.notify(str(exc), type='negative')
                except Exception:
                    ui.notify('GitHub import failed. Check repository access, branch, folder, and network availability.', type='negative')

            ui.button('Import GitHub evidence', icon='download', on_click=import_github).props('outline')

        with ui.expansion('Import supported evidence from SharePoint').classes('w-full max-w-2xl mt-3'):
            sharepoint_site = ui.input('SharePoint site URL', placeholder='https://tenant.sharepoint.com/sites/Audit').classes('w-full')
            with ui.row().classes('gap-3 flex-wrap'):
                sharepoint_library = ui.input('Document library', value='Documents').classes('w-48')
                sharepoint_folder = ui.input('Folder path (optional)').classes('w-64')
                sharepoint_token = ui.input('Microsoft Graph access token', password=True, password_toggle_button=True).classes('w-80')
            async def import_sharepoint():
                try:
                    if not _allowed('evidence:write') or not selected.value: raise ValueError('Select an audit session and ensure evidence-import permission.')
                    artifacts = await fetch_sharepoint_folder(sharepoint_site.value or '', sharepoint_library.value or 'Documents', sharepoint_folder.value or '', sharepoint_token.value or '')
                    if not artifacts: raise ValueError('No supported evidence files were found in this SharePoint folder.')
                    with SessionLocal() as db:
                        count = persist_remote_evidence(db, int(selected.value), _current_user_id(), 'sharepoint', sharepoint_site.value or '', [(item.path, item.content) for item in artifacts]); db.commit()
                    sharepoint_token.value = ''; show_files(); ui.notify(f'Imported {count} SharePoint evidence file(s).', type='positive')
                except ValueError as exc: ui.notify(str(exc), type='negative')
                except Exception: ui.notify('SharePoint import failed. Check site, library, folder, token, and network.', type='negative')
            ui.button('Import SharePoint evidence', icon='download', on_click=import_sharepoint).props('outline')

        with ui.expansion('Import supported evidence from Google Drive').classes('w-full max-w-2xl mt-3'):
            google_folder = ui.input('Google Drive folder ID').classes('w-80')
            google_token = ui.input('Google Drive access token', password=True, password_toggle_button=True).classes('w-full')
            async def import_google_drive():
                try:
                    if not _allowed('evidence:write') or not selected.value: raise ValueError('Select an audit session and ensure evidence-import permission.')
                    artifacts = await fetch_google_drive_folder(google_folder.value or '', google_token.value or '')
                    if not artifacts: raise ValueError('No supported evidence files were found in this Google Drive folder.')
                    with SessionLocal() as db:
                        count = persist_remote_evidence(db, int(selected.value), _current_user_id(), 'google_drive', f'google-drive://{google_folder.value}', [(item.path, item.content) for item in artifacts]); db.commit()
                    google_token.value = ''; show_files(); ui.notify(f'Imported {count} Google Drive evidence file(s).', type='positive')
                except ValueError as exc: ui.notify(str(exc), type='negative')
                except Exception: ui.notify('Google Drive import failed. Check folder ID, token, and network.', type='negative')
            ui.button('Import Google Drive evidence', icon='download', on_click=import_google_drive).props('outline')

        ui.upload(on_upload=upload_artifact, multiple=True, auto_upload=True,
                  max_file_size=get_settings().max_upload_mb * 1024 * 1024,
                  label='Drop repository artifacts or click to browse').classes('w-full max-w-2xl mt-4 repository-folder-uploader')
        ui.timer(0.1, lambda: ui.run_javascript('''
            const input = document.querySelector('.repository-folder-uploader input[type="file"]');
            if (input) { input.setAttribute('webkitdirectory', ''); input.setAttribute('directory', ''); }
        '''), once=True)
        ui.label('Choose individual files or a local folder in browsers that support folder upload. All provider imports validate and persist supported evidence; provider tokens are used only for the active import and are cleared after success.').classes('text-sm text-slate-600 mt-2')
        ui.button('Run repository evidence scan', icon='play_circle', on_click=run_repository_scan).props('color=primary').classes('mt-3')
        selected.on('update:model-value', lambda: (show_files(), show_coverage()))
        show_files(); show_coverage()
