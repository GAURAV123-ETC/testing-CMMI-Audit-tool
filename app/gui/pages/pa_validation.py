"""Dedicated, persisted Practice Area Validation workflow."""
import hashlib
import uuid

from nicegui import ui
from app.core.screen_registry import screen_url
from sqlalchemy import select

from app.core.config import get_settings
from app.core.validators import validate_evidence_content
from app.db.database import SessionLocal
from app.db.models import (AuditSession, AuditSessionPracticeArea, EvidenceFile,
                           EvidenceSource, Finding, PracticeArea)
from app.gui.layout import layout
from app.gui.pages.audit_workspace import _allowed, _current_user_id
from app.services.audit_engine.domain_data import DOMAINS, practice_area_codes_for_selection
from app.services.audit_engine.evidence_scan import scan_session


def register():
    @ui.page(screen_url('pa_validation'))
    def pa_validation_page():
        layout('Practice Area Validation', 'Upload audit folders, validate evidence, and review persisted practice-area results.')
        if not (_allowed('evidence:read') or _allowed('evidence:write') or _allowed('audits:read') or _allowed('audits:write')):
            ui.label('You do not have permission to view practice-area validation.').classes('text-negative'); return
        with SessionLocal() as db:
            sessions = {item.id: f'Audit session #{item.id}' for item in db.scalars(select(AuditSession).order_by(AuditSession.created_at.desc())).all()}
        if not sessions:
            ui.label('Create an audit session before validating practice-area evidence.').classes('text-slate-600'); return
        selected_session = ui.select(sessions, value=next(iter(sessions)), label='Audit session').classes('w-80')
        selected_domains = ui.select({domain.id: f'{domain.code} — {domain.label}' for domain in DOMAINS}, multiple=True,
                                     label='Domains (all when empty)').classes('w-72')
        content = ui.column().classes('w-full')

        @ui.refreshable
        def results() -> None:
            session_id = int(selected_session.value)
            codes = practice_area_codes_for_selection(selected_domains.value or [])
            with SessionLocal() as db:
                pa_rows = db.execute(select(AuditSessionPracticeArea, PracticeArea).join(
                    PracticeArea, AuditSessionPracticeArea.practice_area_id == PracticeArea.id
                ).where(AuditSessionPracticeArea.audit_session_id == session_id)).all()
                findings = db.scalars(select(Finding).where(Finding.audit_session_id == session_id).order_by(Finding.practice_area_code, Finding.id)).all()
            visible = [(row, pa) for row, pa in pa_rows if pa.code in codes]
            def state(row):
                if row.folder_status == 'not_scanned': return 'Not scanned'
                if row.folder_status != 'available' or row.evidence_status == 'missing': return 'Missing'
                return 'Gap' if row.evidence_status == 'gap' else 'Available'
            summary = {name: sum(state(row) == name for row, _ in visible) for name in ('Available', 'Gap', 'Missing', 'Not scanned')}
            with ui.row().classes('gap-3 flex-wrap mt-5'):
                for label, value in [('Total PA', len(visible)), *summary.items()]:
                    with ui.card().classes('w-36'): ui.label(label).classes('text-sm text-slate-600'); ui.label(str(value)).classes('text-2xl font-bold')
            ui.label('Practice-area results').classes('text-xl font-bold mt-4')
            rows = [{'code': pa.code, 'name': pa.name, 'folder': row.folder_status, 'evidence': row.evidence_status, 'result': state(row)} for row, pa in visible]
            ui.table(columns=[{'name': key, 'label': label, 'field': key, 'align': 'left'} for key, label in (
                ('code','Code'),('name','Practice Area'),('folder','Folder'),('evidence','Evidence'),('result','Combined result'))], rows=rows, row_key='code').classes('w-full')
            ui.label('Per-practice-area gap drill-down').classes('text-xl font-bold mt-5')
            for row, pa in visible:
                items = [finding for finding in findings if finding.practice_area_code == pa.code]
                with ui.expansion(f'{pa.code} — {pa.name} · {state(row)}').classes('w-full border border-slate-200 rounded'):
                    if items:
                        for finding in items:
                            ui.label(f'[{finding.severity.upper()}] {finding.rule_id or "No rule"}: {finding.title}').classes('block p-2 text-sm')
                    else:
                        ui.label('No persisted findings for this practice area.').classes('p-2 text-sm text-slate-600')

        def upload(event) -> None:
            if not _allowed('evidence:write'):
                ui.notify('You do not have permission to upload evidence.', type='negative'); return
            try:
                name, data = validate_evidence_content(event.name, event.content.read(), get_settings().max_upload_mb * 1024 * 1024)
                directory = get_settings().upload_dir / str(selected_session.value); directory.mkdir(parents=True, exist_ok=True)
                stored = directory / f'{uuid.uuid4().hex}_{name}'; stored.write_bytes(data)
                with SessionLocal() as db:
                    source = EvidenceSource(audit_session_id=int(selected_session.value), source_type='pa_validation_upload', created_by_id=_current_user_id()); db.add(source); db.flush()
                    db.add(EvidenceFile(source_id=source.id, relative_path=name, storage_path=str(stored.relative_to(get_settings().upload_dir.parent)), sha256=hashlib.sha256(data).hexdigest(), mime_type=event.type or None, size_bytes=len(data))); db.commit()
                ui.notify(f'Uploaded {name}; run validation to refresh results.', type='positive')
            except Exception as exc: ui.notify(str(exc), type='negative')

        def validate() -> None:
            if not _allowed('audits:write'):
                ui.notify('You do not have permission to validate evidence.', type='negative'); return
            try:
                with SessionLocal() as db: outcome = scan_session(db, int(selected_session.value), _current_user_id())
                results.refresh(); ui.notify(f"Validation complete: {outcome['findings_created']} finding(s).", type='positive')
            except Exception as exc: ui.notify(f'Validation failed: {exc}', type='negative')

        ui.upload(on_upload=upload, multiple=True, auto_upload=True, max_file_size=get_settings().max_upload_mb * 1024 * 1024,
                  label='Upload Practice Area folder files').classes('w-full max-w-2xl mt-4 pa-folder-uploader')
        ui.timer(0.1, lambda: ui.run_javascript('''
            const input = document.querySelector('.pa-folder-uploader input[type="file"]');
            if (input) { input.setAttribute('webkitdirectory', ''); input.setAttribute('directory', ''); }
        '''), once=True)
        ui.label('Select a folder in a browser that supports folder uploads; nested files are uploaded and retained as audit evidence.').classes('text-sm text-slate-600')
        ui.button('Run Practice Area Validation', icon='fact_check', on_click=validate).props('color=primary').classes('mt-3')
        selected_session.on('update:model-value', results.refresh); selected_domains.on('update:model-value', results.refresh)
        results()
