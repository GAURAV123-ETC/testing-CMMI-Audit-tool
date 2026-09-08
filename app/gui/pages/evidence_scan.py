"""Project-scoped Evidence Scan with an internal, version-pinned assessment run."""
from nicegui import app, run, ui
from pathlib import Path
from app.core.screen_registry import screen_url
from sqlalchemy import select

from app.core.config import get_settings
from app.db.database import SessionLocal
from app.db.models import (AuditProject, AuditSession, AuditSessionPracticeArea, ChecklistVersion,
                           Customer, EvidenceFile, EvidenceSource, Finding, PracticeArea, ScanJob)
from app.gui.layout import layout
from app.gui.pages.audit_workspace import _current_user_id, _screen_allowed
from app.services.audit_engine.evidence_scan import scan_session
from app.services.evidence_ingestion import persist_uploaded_evidence
from app.services.reports.finding_export import create_current_findings_export

EVIDENCE_SCAN_ACCEPT = '.doc,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.xml,.pptx,.pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff,.zip'
AUTO_SESSION_NAME = 'Evidence Scan (automatic)'

EVIDENCE_PAGE_CSS = '''
<style>
.evidence-panel {border:1px solid #dbe7f3!important; border-radius:16px!important; box-shadow:0 8px 24px rgba(15, 50, 90, .07)!important; overflow:hidden}
.evidence-context {background:linear-gradient(135deg,#eef6ff 0%,#f7f3ff 100%)}
.evidence-upload {background:linear-gradient(135deg,#f0fdf7 0%,#f4fbff 100%)}
.evidence-scan {background:linear-gradient(135deg,#fff7ed 0%,#fffdf6 100%)}
.evidence-results-title {color:#123a63!important; font-weight:800!important}
.evidence-section-label {color:#123a63!important; font-size:1.15rem!important; font-weight:800!important}
.evidence-context-summary {color:#163b60!important; font-size:1.02rem!important; font-weight:700!important}
.evidence-rule-summary {color:#4f6781!important}
.evidence-status-chip {background:#e5f1ff!important; color:#155fa8!important; border-radius:999px!important; padding:5px 10px!important; font-weight:700!important}
</style>
'''


def _active_version(db):
    return db.scalar(select(ChecklistVersion).where(ChecklistVersion.is_active.is_(True)).order_by(ChecklistVersion.id.desc()))


def _workspace_context(db, customer_id: int | None, project_id: int | None,
                       audit_session_id: int | None) -> tuple[Customer, AuditProject, AuditSession] | None:
    """Return a verified customer/project/session chain for the selected workspace.

    The browser stores the three selected IDs independently.  Always verify
    their foreign-key relationship before showing, uploading, or scanning
    evidence so a stale or manipulated selection cannot save data against a
    different audit session.
    """
    if not customer_id or not project_id or not audit_session_id:
        return None
    customer = db.get(Customer, int(customer_id))
    project = db.get(AuditProject, int(project_id))
    audit = db.get(AuditSession, int(audit_session_id))
    if not customer or not project or not audit:
        return None
    if project.customer_id != customer.id or audit.project_id != project.id:
        return None
    return customer, project, audit


def _ensure_scan_session(db, project_id: int, user_id: int) -> AuditSession:
    """Compatibility helper for ruleset reassessments; normal UI uses saved sessions."""
    if not db.get(AuditProject, project_id):
        raise ValueError('Selected project no longer exists.')
    version = _active_version(db)
    if not version:
        raise ValueError('No active ruleset is available. Import the master workbook first.')
    session = db.scalar(select(AuditSession).where(
        AuditSession.project_id == project_id,
        AuditSession.checklist_version_id == version.id,
        AuditSession.audit_name == AUTO_SESSION_NAME,
    ).order_by(AuditSession.id.desc()))
    if session:
        return session
    previous = db.scalar(select(AuditSession).where(
        AuditSession.project_id == project_id,
        AuditSession.audit_name == AUTO_SESSION_NAME,
    ).order_by(AuditSession.id.desc()))
    session = AuditSession(project_id=project_id, checklist_version_id=version.id,
                           audit_name=AUTO_SESSION_NAME, created_by_id=user_id)
    db.add(session); db.flush()
    db.add_all([AuditSessionPracticeArea(audit_session_id=session.id, practice_area_id=area.id)
                for area in db.scalars(select(PracticeArea)).all()])
    if previous:
        prior_files = db.scalars(select(EvidenceFile).join(EvidenceSource).where(
            EvidenceSource.audit_session_id == previous.id)).all()
        if prior_files:
            source = EvidenceSource(audit_session_id=session.id, source_type='ruleset_reassessment',
                                    source_uri=f'assessment:{previous.id}', created_by_id=user_id)
            db.add(source); db.flush()
            db.add_all([EvidenceFile(source_id=source.id, relative_path=item.relative_path,
                                     storage_path=item.storage_path, sha256=item.sha256,
                                     mime_type=item.mime_type, size_bytes=item.size_bytes,
                                     extracted_text=item.extracted_text, processing_status='pending')
                        for item in prior_files])
    return session


def register():
    @ui.page(screen_url('evidence_scan'))
    def evidence_scan_page():
        ui.add_head_html(EVIDENCE_PAGE_CSS)
        layout('Evidence Scan', 'Choose an audit workspace, upload evidence, run the CMMI assessment, and review its saved results.')
        if not _screen_allowed('evidence_scan'):
            ui.label('You do not have permission to view evidence scans.').classes('text-negative'); return

        def load_options():
            with SessionLocal() as db:
                projects = {item.id: item.name for item in db.scalars(select(AuditProject).order_by(AuditProject.name)).all()}
                customers = {item.id: item.name for item in db.scalars(select(Customer).order_by(Customer.name)).all()}
                version = _active_version(db)
            return projects, customers, version

        _, customers, active_version = load_options()
        remembered_project = app.storage.user.get('selected_evidence_project_id')
        remembered_session = app.storage.user.get('selected_audit_session_id')
        remembered_customer = app.storage.user.get('selected_evidence_customer_id')
        with SessionLocal() as db:
            remembered_session_record = db.get(AuditSession, remembered_session) if remembered_session else None
            remembered_project_record = db.get(
                AuditProject, remembered_session_record.project_id if remembered_session_record else remembered_project
            )
        initial_customer = (
            remembered_project_record.customer_id if remembered_project_record else
            remembered_customer if remembered_customer in customers else next(iter(customers), None)
        )

        with ui.card().classes('evidence-panel evidence-context w-full max-w-6xl mt-4'):
            ui.label('Audit workspace').classes('evidence-section-label')
            context_summary = ui.label('No audit workspace selected.').classes('evidence-context-summary')
            rules_summary = ui.label(
                f'Rules applied: active ruleset {active_version.version}'
                if active_version else 'No active ruleset is available. Ask an administrator to import the master workbook.'
            ).classes('evidence-rule-summary text-sm')
            with ui.row().classes('w-full gap-3 flex-wrap mt-2'):
                ui.button('Select audit workspace', icon='tune', on_click=lambda: workspace_dialog.open()).props('color=primary')
                ui.button('Refresh', icon='refresh', on_click=lambda: refresh_workspace()).props('outline')
                details_button = ui.button('View saved scan details', icon='visibility', on_click=lambda: show_details()).props('outline')

        with ui.dialog() as workspace_dialog:
            with ui.card().classes('evidence-panel w-[900px] max-w-full'):
                ui.label('Select audit workspace').classes('text-xl font-bold')
                ui.label('Choose the saved customer, project, and audit session. This selection controls where evidence and scan results are stored.').classes('text-sm text-slate-600')
                with ui.row().classes('w-full gap-4 flex-wrap mt-2'):
                    customer_select = ui.select(customers, value=initial_customer, label='Customer').classes('w-60')
                    project_select = ui.select({}, label='Project').classes('w-60')
                    audit_select = ui.select({}, label='Audit session').classes('w-80')
                if not customers:
                    customer_select.disable(); project_select.disable(); audit_select.disable()
                    ui.label('No saved details are available yet. Create an audit workspace from the Add Project menu, then return here.').classes('text-slate-600')
                ui.separator().classes('my-3')
                ui.label('Rules applied automatically').classes('font-medium')
                rule_status = ui.label(
                    f'Active ruleset: {active_version.version} ({active_version.source})'
                    if active_version else 'No active ruleset is available. Ask an administrator to import the master workbook.'
                ).classes('text-sm text-slate-600')
                ui.label('You do not upload this rulebook for each project or each scan.').classes('text-xs text-slate-500')
                with ui.row().classes('w-full justify-end gap-2 mt-3'):
                    ui.button('Cancel', on_click=workspace_dialog.close).props('flat')
                    ui.button('Use selected workspace', icon='check', on_click=lambda: apply_workspace_selection()).props('color=primary')

        def refresh_audit_options(preferred_session: int | None = None) -> None:
            with SessionLocal() as db:
                sessions = db.scalars(select(AuditSession).where(
                    AuditSession.project_id == int(project_select.value)
                ).order_by(AuditSession.created_at.desc())).all() if project_select.value else []
                options = {
                    item.id: f"{item.audit_name or f'Audit session #{item.id}'}"
                    + (f" — {item.audit_date}" if item.audit_date else '')
                    for item in sessions
                }
                saved_session = app.storage.user.get('selected_audit_session_id')
                selected = preferred_session if preferred_session in options else (
                    saved_session if saved_session in options else next(iter(options), None)
                )
                selected_session = db.get(AuditSession, selected) if selected else None
            audit_select.set_options(options)
            audit_select.value = selected; audit_select.update()
            if selected_session:
                with SessionLocal() as db:
                    version = db.get(ChecklistVersion, selected_session.checklist_version_id)
                rule_status.text = (
                    f'Ruleset pinned to selected audit session: {version.version}'
                    if version else f'Ruleset pinned to selected audit session: ID {selected_session.checklist_version_id}'
                )
                rule_status.update()
            else:
                rule_status.text = (
                    f'Active ruleset: {active_version.version} ({active_version.source})'
                    if active_version else 'No active ruleset is available. Ask an administrator to import the master workbook.'
                )
                rule_status.update()

        def refresh_project_options(preferred_project: int | None = None, preferred_session: int | None = None) -> None:
            with SessionLocal() as db:
                projects = db.scalars(select(AuditProject).where(
                    AuditProject.customer_id == int(customer_select.value)
                ).order_by(AuditProject.name)).all() if customer_select.value else []
                options = {item.id: item.name for item in projects}
                saved_project = app.storage.user.get('selected_evidence_project_id')
                selected = preferred_project if preferred_project in options else (
                    saved_project if saved_project in options else next(iter(options), None)
                )
            project_select.set_options(options)
            project_select.value = selected; project_select.update()
            refresh_audit_options(preferred_session)

        def update_workspace_summary() -> None:
            with SessionLocal() as db:
                context = _workspace_context(db, customer_select.value, project_select.value, audit_select.value)
                version = db.get(ChecklistVersion, context[2].checklist_version_id) if context else None
            if context:
                customer, project, audit = context
                context_summary.text = f'Selected: {customer.name} / {project.name} / {audit.audit_name or f"Audit session #{audit.id}"}'
                rules_summary.text = f'Rules applied: {version.version if version else f"ruleset ID {audit.checklist_version_id}"} (pinned to this audit session)'
                scan_context.text = f'Scan target: Customer {customer.name} | Project {project.name} | Audit session {audit.audit_name or f"#{audit.id}"}'
                details_button.enable()
                if app.storage.user.get('evidence_details_session_id') == audit.id:
                    details_button.text = 'Hide saved scan details'
                    details_button.props('icon=visibility_off')
                else:
                    details_button.text = 'View saved scan details'
                    details_button.props('icon=visibility')
            else:
                context_summary.text = 'No complete audit workspace selected. Select saved details before uploading or scanning.'
                rules_summary.text = 'Rules are applied automatically after an audit session is selected.'
                scan_context.text = 'Scan target: select a complete audit workspace first.'
                details_button.disable()
                details_button.text = 'View saved scan details'
                details_button.props('icon=visibility')
            context_summary.update(); rules_summary.update(); scan_context.update()

        def refresh_workspace() -> None:
            """Reload saved audit workspaces after a user or administrator change."""
            with SessionLocal() as db:
                refreshed_customers = {item.id: item.name for item in db.scalars(select(Customer).order_by(Customer.name)).all()}
            customer_select.set_options(refreshed_customers)
            if customer_select.value not in refreshed_customers:
                customer_select.value = next(iter(refreshed_customers), None)
            customer_select.update()
            refresh_project_options()
            update_workspace_summary()
            sync_action_controls()
            results.refresh()

        def apply_workspace_selection() -> None:
            with SessionLocal() as db:
                context = _workspace_context(db, customer_select.value, project_select.value, audit_select.value)
            if not context:
                ui.notify('Choose a valid customer, project, and audit session combination.', type='warning')
                refresh_workspace()
                return
            customer, project, audit = context
            app.storage.user['selected_evidence_customer_id'] = customer.id
            app.storage.user['selected_evidence_project_id'] = project.id
            app.storage.user['selected_audit_session_id'] = audit.id
            app.storage.user.pop('evidence_details_session_id', None)
            update_workspace_summary()
            sync_action_controls()
            results.refresh()
            workspace_dialog.close()

        def download_current_findings(fmt: str) -> None:
            if not audit_select.value:
                ui.notify('Select an audit workspace first.', type='warning')
                return
            try:
                with SessionLocal() as db:
                    context = _workspace_context(db, customer_select.value, project_select.value, audit_select.value)
                    if not context:
                        raise ValueError('The selected customer, project, and audit session no longer form a valid workspace.')
                    report = create_current_findings_export(db, context[2].id, _current_user_id(), fmt)
                media_type = 'text/csv' if fmt == 'csv' else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                ui.download(report.storage_path, filename=Path(report.storage_path).name, media_type=media_type)
                ui.notify(f'{fmt.upper()} download is ready.', type='positive')
            except Exception as exc:
                ui.notify(f'Could not create findings download: {exc}', type='negative')

        @ui.refreshable
        def results() -> None:
            if not audit_select.value:
                ui.label('Select a saved customer, project, and audit session before uploading or reviewing stored evidence.').classes('text-slate-600 mt-5'); return
            if app.storage.user.get('evidence_details_session_id') != int(audit_select.value):
                ui.label('Saved inventory, findings, and prior scan results are hidden for this audit workspace. Click “View saved scan details” above when you are ready to review this selected session.').classes('text-slate-600 mt-5')
                return
            with SessionLocal() as db:
                context = _workspace_context(db, customer_select.value, project_select.value, audit_select.value)
                if not context:
                    ui.label('The selected workspace is no longer valid. Refresh the saved details and choose it again.').classes('text-negative mt-5'); return
                _, _, session = context
                files = db.scalars(select(EvidenceFile).join(EvidenceSource).where(EvidenceSource.audit_session_id == session.id).order_by(EvidenceFile.relative_path)).all()
                findings = db.scalars(select(Finding).where(Finding.audit_session_id == session.id, Finding.status == 'open')).all()
                scan_jobs = db.scalars(select(ScanJob).where(
                    ScanJob.audit_session_id == session.id,
                    ScanJob.job_type == 'master_rule_and_irp_scan',
                ).order_by(ScanJob.created_at.desc())).all()
                latest_job = scan_jobs[0] if scan_jobs else None
            ui.label('Saved evidence, findings, and scan result').classes('evidence-results-title text-xl mt-5')
            ui.label('Uploaded files are stored permanently for this audit session. They remain here after refresh or sign-in; upload again only when evidence changes.').classes('text-sm text-slate-600')
            with ui.row().classes('w-full gap-4 flex-wrap mt-2'):
                ui.label(f'{len(files)} stored document(s)').classes('text-lg font-bold')
                ui.label(f"{sum(item.processing_status == 'processed' for item in files)} assessed").classes('text-slate-700')
                ui.label(f"{sum(item.processing_status == 'pending' for item in files)} waiting for scan").classes('text-slate-700')
                if any(item.processing_status == 'error' for item in files):
                    ui.label(f"{sum(item.processing_status == 'error' for item in files)} needs attention").classes('text-negative')
            if not files:
                ui.label('No evidence has been stored for this audit session yet. Use one of the upload choices above.').classes('text-slate-600 mt-2')
                return
            role_names = {
                'PROJECT_IMPLEMENTATION_EVIDENCE': 'Project evidence',
                'PROCESS_REFERENCE': 'Process reference',
                'TEMPLATE': 'Template',
                'BLANK_TEMPLATE': 'Blank template',
                'DUPLICATE': 'Duplicate',
            }
            status_names = {
                'pending': 'Stored — waiting for scan',
                'processed': 'Assessed',
                'error': 'Could not assess',
            }
            rows=[]
            for file in files:
                classification = file.classification_json or {}
                assessed = file.processing_status == 'processed' and bool(classification)
                rows.append({
                    'id': file.id,
                    'file': file.relative_path,
                    'type': classification.get('detected_type', 'Not assessed — run scan') if assessed else 'Not assessed — run scan',
                    'role': role_names.get(classification.get('document_role'), 'Not assessed') if assessed else 'Not assessed',
                    'practice_areas': ', '.join(classification.get('practice_areas', [])) or ('Unclassified' if assessed else 'Not assessed'),
                    'confidence': f"{classification.get('confidence')} ({classification.get('confidence_score')}%)" if assessed else 'Not assessed',
                    'status': status_names.get(file.processing_status, file.processing_status.title()),
                })
            ui.table(columns=[{'name':key,'label':label,'field':key,'align':'left'} for key,label in (
                ('file','Document'),('type','Document Type'),('role','Document Role'),('practice_areas','Practice Areas'),
                ('confidence','Confidence'),('status','Processing Status'))],rows=rows,row_key='id').props("pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}").classes('w-full')
            with ui.expansion('What do these labels mean?', icon='help_outline').classes('w-full mt-2'):
                ui.label('Document type is the best match against the document-type catalogue stored with this audit session’s pinned CMMI ruleset. Confidence measures that match only; it is not an audit score or compliance result.').classes('text-sm text-slate-600')
                ui.label('Document role tells the scanner whether a file is usable project evidence, a process reference, a template, blank, or a duplicate. Templates and references are retained but do not satisfy implementation evidence requirements.').classes('text-sm text-slate-600')
                ui.label('Practice areas are CMMI areas suggested by the stored document-type rule. “Unclassified” means the scanner could not make a reliable mapping and needs a reviewer. Processing status shows whether the stored file has been assessed successfully.').classes('text-sm text-slate-600')
            if not latest_job:
                ui.label('No scan result yet. The stored files have not been compared with CMMI rules.').classes('text-slate-600 mt-3')
            elif latest_job.status == 'completed':
                summary = latest_job.result_summary or {}
                ui.label(f"Latest scan completed: {summary.get('files_processed', 0)} file(s) assessed and {summary.get('findings_created', 0)} finding(s) created.").classes('font-medium text-positive mt-3')
                ui.separator().classes('my-4')
                ui.label('Findings from this scan').classes('text-lg font-bold')
                ui.label('Findings are the actionable CMMI evidence gaps found for this selected audit session. They identify the rule, affected practice area, severity, and recommended next action.').classes('text-sm text-slate-600')
                if not findings:
                    ui.label('No open findings were created by the latest scan.').classes('text-positive mt-2')
                else:
                    with ui.row().classes('w-full items-center gap-3 mt-2'):
                        ui.label(f'{len(findings)} open finding(s)').classes('font-medium')
                        ui.button('Download CSV', icon='download', on_click=lambda: download_current_findings('csv')).props('outline')
                        ui.button('Download Excel', icon='download', on_click=lambda: download_current_findings('xlsx')).props('outline color=primary')
                    finding_rows = [{
                        'id': finding.id,
                        'rule': finding.rule_id or 'Specialized validation',
                        'practice_area': finding.practice_area_code,
                        'severity': finding.severity.title(),
                        'finding': finding.title,
                        'recommendation': finding.recommendation,
                        'status': finding.status.title(),
                    } for finding in findings]
                    ui.table(columns=[{'name': key, 'label': label, 'field': key, 'align': 'left'} for key, label in (
                        ('rule', 'Rule'), ('practice_area', 'Practice Area'), ('severity', 'Severity'),
                        ('finding', 'Finding'), ('recommendation', 'Recommended action'), ('status', 'Status'),
                    )], rows=finding_rows, row_key='id').props("pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}").classes('w-full')
            elif latest_job.status == 'running':
                ui.label('A scan is currently running. This view refreshes when it completes.').classes('text-primary mt-3')
            else:
                ui.label(f"The latest scan did not complete: {(latest_job.result_summary or {}).get('error', 'unknown error')}").classes('text-negative mt-3')
            if scan_jobs:
                with ui.expansion('Scan history', icon='history').classes('w-full mt-4'):
                    ui.label('Each run remains recorded against this audit session. New scans supersede prior open findings but do not delete the earlier scan job history.').classes('text-sm text-slate-600')
                    history_rows = []
                    for job in scan_jobs:
                        summary = job.result_summary or {}
                        history_rows.append({
                            'id': job.id,
                            'started': job.created_at.strftime('%Y-%m-%d %H:%M UTC'),
                            'status': job.status.title(),
                            'files': summary.get('files_processed', summary.get('files_total', '—')),
                            'findings': summary.get('findings_created', '—'),
                            'detail': summary.get('error') or summary.get('phase') or 'Completed assessment',
                        })
                    ui.table(columns=[{'name': key, 'label': label, 'field': key, 'align': 'left'} for key, label in (
                        ('started', 'Started'), ('status', 'Status'), ('files', 'Files'), ('findings', 'Findings'), ('detail', 'Detail'),
                    )], rows=history_rows, row_key='id').props("pagination={'rowsPerPage': 10, 'rowsPerPageOptions': [10, 25, 50, 100]}").classes('w-full mt-2')

        def show_details() -> None:
            if not audit_select.value:
                ui.notify('Select an audit workspace first.', type='warning')
                return
            session_id = int(audit_select.value)
            if app.storage.user.get('evidence_details_session_id') == session_id:
                app.storage.user.pop('evidence_details_session_id', None)
                details_button.text = 'View saved scan details'
                details_button.props('icon=visibility')
            else:
                app.storage.user['evidence_details_session_id'] = session_id
                details_button.text = 'Hide saved scan details'
                details_button.props('icon=visibility_off')
            details_button.update()
            results.refresh()

        with ui.card().classes('evidence-panel evidence-upload w-full max-w-6xl mt-4'):
            ui.label('Upload evidence').classes('evidence-section-label')
            ui.label('Files are stored only in the selected audit workspace shown above.').classes('text-sm text-slate-600')
            ui.label('Selected audit workspace').classes('evidence-status-chip inline-block mt-2')
            ui.label('Upload one individual evidence file, or one ZIP belonging to the selected project. A project ZIP is unpacked and stored as individual evidence files. Repeat this upload when adding more individual files.').classes('text-sm text-slate-600')
            def upload_project_document(event) -> None:
                if not _screen_allowed('evidence_scan', 'write'):
                    ui.notify('You do not have permission to upload evidence.', type='negative'); return
                if not audit_select.value:
                    ui.notify('Select a customer, project, and audit session first.', type='warning'); return
                try:
                    with SessionLocal() as db:
                        context = _workspace_context(db, customer_select.value, project_select.value, audit_select.value)
                        if not context:
                            raise ValueError('The selected customer, project, and audit session no longer form a valid workspace.')
                        _, _, session = context
                        count=persist_uploaded_evidence(db,session.id,_current_user_id(),event.name,event.content.read(),event.type,source_type='evidence_scan_folder')
                        db.commit()
                    uploader.reset()
                    results.refresh(); ui.notify(f'Added {count} evidence file(s) to the selected audit session. They are stored and waiting for scan.',type='positive')
                except Exception as exc:
                    ui.notify(f'Evidence upload failed: {exc}',type='negative')
            uploader=ui.upload(on_upload=upload_project_document,auto_upload=True,
                               max_file_size=get_settings().max_upload_mb*1024*1024,
                               label='Upload one evidence file or one project ZIP').props(f'accept={EVIDENCE_SCAN_ACCEPT}').classes('w-full')
            if not audit_select.value or not _screen_allowed('evidence_scan', 'write'):
                uploader.disable()

        @ui.refreshable
        def scan_progress() -> None:
            if not audit_select.value:
                return
            with SessionLocal() as db:
                job = db.scalars(select(ScanJob).where(
                    ScanJob.audit_session_id == int(audit_select.value),
                    ScanJob.job_type == 'master_rule_and_irp_scan',
                ).order_by(ScanJob.created_at.desc())).first()
            if not job or job.status != 'running':
                return
            progress = job.result_summary or {}
            completed = int(progress.get('files_processed') or 0)
            total = int(progress.get('files_total') or 0)
            ui.label(f"Processing document {completed} of {total}: {progress.get('current_file') or 'preparing scan'}").classes('text-primary text-sm mt-2')
            if total:
                ui.linear_progress(value=completed / total).classes('w-full')

        async def run_scan() -> None:
            if not _screen_allowed('evidence_scan', 'write'):
                ui.notify('You do not have permission to run an evidence scan.',type='negative'); return
            if not audit_select.value:
                ui.notify('Select a customer, project, and audit session first.',type='warning'); return
            audit_session_id = int(audit_select.value)
            scan_button.disable()
            scan_spinner.set_visibility(True)
            scan_state.text = 'Scan is running. The page stays responsive while each stored file is read and checked against the audit session\'s pinned CMMI ruleset.'
            scan_state.classes(remove='text-negative', add='text-primary')
            scan_state.update()
            scan_progress.refresh()
            try:
                user_id = _current_user_id()
                def execute_scan() -> dict:
                    with SessionLocal() as db:
                        if not _workspace_context(db, customer_select.value, project_select.value, audit_session_id):
                            raise ValueError('The selected customer, project, and audit session no longer form a valid workspace.')
                        return scan_session(db, audit_session_id, user_id)
                outcome = await run.io_bound(execute_scan)
                scan_state.text = f"Scan completed: {outcome['files_processed']} file(s) assessed and {outcome['findings_created']} finding(s) created. Review the persisted result below."
                scan_state.classes(remove='text-primary text-negative', add='text-positive')
                scan_state.update()
                scan_progress.refresh()
                results.refresh()
                ui.notify(f"Evidence scan completed: {outcome['files_processed']} file(s), {outcome['findings_created']} finding(s).",type='positive')
            except Exception as exc:
                scan_state.text = f'Evidence scan did not complete: {exc}'
                scan_state.classes(remove='text-primary text-positive', add='text-negative')
                scan_state.update()
                scan_progress.refresh()
                ui.notify(f'Evidence scan failed: {exc}',type='negative')
            finally:
                scan_spinner.set_visibility(False)
                sync_action_controls()
        with ui.card().classes('evidence-panel evidence-scan w-full max-w-6xl mt-4'):
            ui.label('Run CMMI evidence scan').classes('evidence-section-label')
            ui.label('The scan reads the stored files, uses the CMMI ruleset pinned to this audit session, stores document classifications, and creates linked findings for missing, partial, blocked, or unreadable evidence.').classes('text-sm text-slate-600')
            scan_context = ui.label('Scan target: select a complete audit workspace first.').classes('text-sm font-medium text-slate-700 mt-2')
            with ui.row().classes('items-center gap-3 mt-2'):
                scan_button=ui.button('Run CMMI Evidence Scan',icon='manage_search',on_click=run_scan).props('color=primary')
                scan_spinner = ui.spinner('dots', size='lg')
                scan_spinner.set_visibility(False)
                scan_state = ui.label('Ready to scan stored evidence.').classes('text-sm text-slate-600')
            scan_progress()
            if not audit_select.value or not _screen_allowed('evidence_scan', 'write'): scan_button.disable()

        def sync_action_controls() -> None:
            if audit_select.value and _screen_allowed('evidence_scan', 'write'):
                uploader.enable()
            else:
                uploader.disable()
            if audit_select.value and _screen_allowed('evidence_scan', 'write'):
                scan_button.enable()
            else:
                scan_button.disable()

        def select_customer() -> None:
            app.storage.user.pop('evidence_details_session_id', None)
            if customer_select.value:
                app.storage.user['selected_evidence_customer_id'] = customer_select.value
            refresh_project_options()
            update_workspace_summary()
            sync_action_controls()
            results.refresh()

        def select_project() -> None:
            app.storage.user.pop('evidence_details_session_id', None)
            if project_select.value:
                app.storage.user['selected_evidence_project_id'] = project_select.value
            else:
                app.storage.user.pop('selected_evidence_project_id', None)
            refresh_audit_options()
            update_workspace_summary()
            sync_action_controls()
            results.refresh()

        def select_audit() -> None:
            app.storage.user.pop('evidence_details_session_id', None)
            if audit_select.value:
                app.storage.user['selected_audit_session_id'] = audit_select.value
            else:
                app.storage.user.pop('selected_audit_session_id', None)
            update_workspace_summary()
            sync_action_controls()
            results.refresh()

        customer_select.on('update:model-value', select_customer)
        project_select.on('update:model-value', select_project)
        audit_select.on('update:model-value', select_audit)
        refresh_project_options()
        sync_action_controls()
        update_workspace_summary()
        results()
        ui.timer(1.0, scan_progress.refresh)
