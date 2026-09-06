"""Persisted NiceGUI replacement for the legacy Audit Package Checker."""
from nicegui import app, ui
from app.core.screen_registry import screen_url
from sqlalchemy import select

from app.core.config import get_settings
from app.db.database import SessionLocal
from app.db.models import AuditSession, ScanJob
from app.gui.layout import layout
from app.gui.pages.audit_workspace import _allowed, _current_user_id
from app.services.audit_engine.package_validation import validate_package_archive
from app.services.evidence_ingestion import persist_uploaded_evidence


def register():
    @ui.page(screen_url('package_checker'))
    def package_checker_page():
        layout('Package Checker', 'Validate a ZIP audit package against the required CMMI practice-area folder structure.')
        if not (_allowed('evidence:read') or _allowed('evidence:write') or _allowed('audits:read') or _allowed('audits:write')):
            ui.label('You do not have permission to view Package Checker.').classes('text-negative')
            return
        with SessionLocal() as db:
            sessions = {item.id: f'Audit session #{item.id}' for item in db.scalars(
                select(AuditSession).order_by(AuditSession.created_at.desc())
            ).all()}
        selected = ui.select(sessions, value=app.storage.user.get('selected_audit_session_id') if app.storage.user.get('selected_audit_session_id') in sessions else next(iter(sessions), None), label='Audit session').classes('w-80')
        if not sessions:
            selected.disable()
            ui.label('Create an audit session before checking an audit package.').classes('text-slate-600')
            ui.button('Open Audit Workspace', on_click=lambda: ui.navigate.to('/audit-workspace')).props('flat color=primary')

        results = ui.column().classes('w-full mt-5')

        @ui.refreshable
        def show_last_result() -> None:
            if not selected.value:
                return
            with SessionLocal() as db:
                job = db.scalars(select(ScanJob).where(
                    ScanJob.audit_session_id == int(selected.value), ScanJob.job_type == 'package_check'
                ).order_by(ScanJob.created_at.desc())).first()
            if not job or not job.result_summary:
                ui.label('No package check has been run for this audit session.').classes('text-slate-600')
                return
            summary = job.result_summary
            ui.label(f"Last check: {summary.get('available', 0)} available, {summary.get('empty', 0)} empty, {summary.get('missing', 0)} missing").classes('font-bold')
            ui.table(columns=[
                {'name': 'code', 'label': 'Code', 'field': 'code', 'align': 'left'},
                {'name': 'name', 'label': 'Practice Area', 'field': 'name', 'align': 'left'},
                {'name': 'status', 'label': 'Package Status', 'field': 'status', 'align': 'left'},
                {'name': 'file_count', 'label': 'Files', 'field': 'file_count', 'align': 'right'},
                {'name': 'paths', 'label': 'Matched Folder(s)', 'field': 'paths', 'align': 'left'},
            ], rows=summary.get('results', []), row_key='code').classes('w-full')

        def check_package(event) -> None:
            if not (_allowed('evidence:write') and _allowed('audits:write')):
                ui.notify('Evidence and audit write permission is required to run Package Checker.', type='negative')
                return
            if not selected.value:
                ui.notify('Select an audit session first.', type='warning')
                return
            try:
                body = event.content.read()
                checked = validate_package_archive(event.name, body, get_settings().max_upload_mb * 1024 * 1024)
                with SessionLocal() as db:
                    files = persist_uploaded_evidence(db, int(selected.value), _current_user_id(), event.name, body,
                                                      event.type, source_type='package_checker_archive')
                    counts = {state: sum(item['status'] == state for item in checked) for state in ('AVAILABLE', 'EMPTY', 'MISSING')}
                    db.add(ScanJob(audit_session_id=int(selected.value), job_type='package_check', status='completed',
                                   result_summary={'results': checked, 'archive_name': event.name, 'files_imported': files,
                                                   'available': counts['AVAILABLE'], 'empty': counts['EMPTY'], 'missing': counts['MISSING']}))
                    db.commit()
                show_last_result.refresh()
                ui.notify(f'Package check complete. {files} evidence file(s) were retained for the selected audit session.', type='positive')
            except Exception as exc:
                ui.notify(f'Package check failed: {exc}', type='negative')

        uploader = ui.upload(on_upload=check_package, auto_upload=True, max_file_size=get_settings().max_upload_mb * 1024 * 1024,
                             label='Upload audit package ZIP').props('accept=.zip').classes('w-full max-w-2xl')
        ui.label('Expected structure: a folder named with each CMMI code (for example PLAN, IRP, RSK) containing its evidence files. The check result and uploaded evidence are stored against the selected audit session.').classes('text-sm text-slate-600 mt-2')
        if not sessions or not (_allowed('evidence:write') and _allowed('audits:write')):
            uploader.disable()

        def select_session() -> None:
            if selected.value:
                app.storage.user['selected_audit_session_id'] = selected.value
            show_last_result.refresh()
        selected.on('update:model-value', select_session)
        show_last_result()
