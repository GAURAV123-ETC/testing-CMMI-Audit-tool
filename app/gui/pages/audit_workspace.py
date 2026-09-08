"""Database-backed NiceGUI audit workflow pages."""
from datetime import date
from pathlib import Path

from nicegui import app, ui
from app.core.screen_registry import has_screen_permission, screen_url
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.security import hash_password
from app.db.database import SessionLocal
from app.db.models import (AuditProject, AuditSession, AuditSessionPracticeArea,
                           ChecklistVersion, Customer, EvidenceFile, EvidenceSource,
                           Finding, FindingEvidence, GeneratedReport, PracticeArea, Role, User)
from app.gui.layout import layout
from app.services.audit_engine.evidence_scan import scan_session
from app.services.audit_engine.correlation_map import correlation_map
from app.services.evidence_ingestion import persist_uploaded_evidence
from app.services.auth.service import get_session_user
from app.services.reports.afr_report import create_afr


def _current_user_id() -> int:
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        if not user:
            raise RuntimeError('Your session has expired. Please sign in again.')
        return user.id


def _allowed(permission: str) -> bool:
    """Apply API-equivalent RBAC to server-side NiceGUI event handlers."""
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        if not user:
            return False
        codes = {item.code for role in user.roles for item in role.permissions}
        return '*' in codes or permission in codes


def _screen_allowed(screen_id: str, action: str = 'read') -> bool:
    """Screen-level UI guard matching the API and sidebar policy."""
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        return bool(user and has_screen_permission(db, user, screen_id, action))


def _require(permission: str) -> bool:
    if _allowed(permission):
        return True
    ui.notify('You do not have permission for this action.', type='negative')
    return False


def _require_any(*permissions: str) -> bool:
    if any(_allowed(permission) for permission in permissions):
        return True
    ui.label('You do not have permission to view this page.').classes('text-negative')
    return False


def _options(model, label: str) -> dict[int, str]:
    with SessionLocal() as db:
        return {row.id: str(getattr(row, label)) for row in db.scalars(select(model).order_by(getattr(model, label))).all()}


def _table(columns: list[tuple[str, str]], rows: list[dict], row_key: str | None = None) -> None:
    ui.table(
        columns=[{'name': key, 'label': label, 'field': key, 'align': 'left'} for key, label in columns],
        rows=rows,
        row_key=row_key or columns[0][0],
    ).props("pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}").classes('w-full')


def register():
    @ui.page(screen_url('audit_workspace'))
    def workspace():
        # The unified Add Project page supersedes this legacy three-form setup.
        # Keep the route as a safe redirect for bookmarked links.
        ui.navigate.to('/add-project')
        return
        layout('Audit Workspace', 'Create the customer, project, and audit session. Continue in Evidence Scan to upload and scan project documents.')
        if not _require_any('customers:read', 'customers:write', 'projects:read', 'projects:write', 'audits:read', 'audits:write'):
            return
        user_id = _current_user_id()
        customer_options, project_options, session_options = _options(Customer, 'name'), _options(AuditProject, 'name'), _options(AuditSession, 'id')
        # Evidence Scan is the single evidence workflow in the left navigation.
        # Keep Workspace focused on setup rather than presenting duplicates.
        with ui.tabs().classes('hidden') as tabs:
            setup_tab = ui.tab('1. Audit setup')
            evidence_tab = ui.tab('2. Evidence & scan')
        with ui.tab_panels(tabs, value=setup_tab).classes('w-full'):
            with ui.tab_panel(setup_tab):
                ui.label('Create a customer, project, and audit session in this order. Then continue in Evidence Scan to upload the project documents folder.').classes('text-slate-600')
                with ui.row().classes('gap-6 items-start flex-wrap'):
                    with ui.card().classes('w-80'):
                        ui.label('New customer').classes('text-lg font-bold')
                        customer_name = ui.input('Customer name').classes('w-full')
                        customer_email = ui.input('Contact email (optional)').classes('w-full')
                        def create_customer():
                            if not _require('customers:write'): return
                            if not customer_name.value or len(customer_name.value.strip()) < 2:
                                ui.notify('Enter a customer name.', type='negative'); return
                            with SessionLocal() as db:
                                if db.scalar(select(Customer).where(Customer.name == customer_name.value.strip())):
                                    ui.notify('This customer already exists.', type='warning'); return
                                customer = Customer(name=customer_name.value.strip(), contact_email=customer_email.value or None, created_by_id=user_id)
                                db.add(customer); db.commit()
                            customer_options[customer.id] = customer.name
                            project_customer.set_options(customer_options); project_customer.value = customer.id
                            ui.notify('Customer created. Continue with the project.', type='positive')
                        ui.button('Create customer', on_click=create_customer).props('color=primary')
                    with ui.card().classes('w-80'):
                        ui.label('New project').classes('text-lg font-bold')
                        project_customer = ui.select(customer_options, label='Customer').classes('w-full')
                        project_name = ui.input('Project name').classes('w-full')
                        project_url = ui.input('Repository URL (optional)').classes('w-full')
                        def create_project():
                            if not _require('projects:write'): return
                            if not project_customer.value or not project_name.value:
                                ui.notify('Select a customer and enter a project name.', type='negative'); return
                            with SessionLocal() as db:
                                duplicate = db.scalar(select(AuditProject).where(AuditProject.customer_id == int(project_customer.value), AuditProject.name == project_name.value.strip()))
                                if duplicate: ui.notify('This project already exists for the customer.', type='warning'); return
                                project = AuditProject(customer_id=int(project_customer.value), name=project_name.value.strip(), repository_url=project_url.value or None, owner_id=user_id)
                                db.add(project); db.commit()
                            project_options[project.id] = project.name
                            session_project.set_options(project_options); session_project.value = project.id
                            ui.notify('Project created. Continue with the audit session.', type='positive')
                        ui.button('Create project', on_click=create_project).props('color=primary')
                    with ui.card().classes('w-80'):
                        ui.label('New audit session').classes('text-lg font-bold')
                        session_project = ui.select(project_options, label='Project').classes('w-full')
                        session_name = ui.input('Audit name (optional)', placeholder='CMMI V3.0 Internal Audit').classes('w-full')
                        session_date = ui.input('Audit date (optional)').props('type=date').classes('w-full')
                        session_auditors = ui.input('Auditors (optional)', placeholder='Comma-separated names').classes('w-full')
                        session_auditees = ui.input('Auditees (optional)', placeholder='Comma-separated names').classes('w-full')
                        def create_session():
                            if not _require('audits:write'): return
                            if not session_project.value:
                                ui.notify('Select a project.', type='negative'); return
                            try:
                                audit_date = date.fromisoformat(session_date.value) if session_date.value else None
                            except ValueError:
                                ui.notify('Choose a valid audit date from the calendar.', type='negative'); return
                            with SessionLocal() as db:
                                version = db.scalar(select(ChecklistVersion).where(ChecklistVersion.is_active.is_(True)))
                                if not version: ui.notify('Checklist seed is missing.', type='negative'); return
                                audit = AuditSession(
                                    project_id=int(session_project.value), checklist_version_id=version.id, created_by_id=user_id,
                                    audit_name=session_name.value.strip() or None, audit_date=audit_date,
                                    auditors=session_auditors.value.strip() or None, auditees=session_auditees.value.strip() or None,
                                )
                                db.add(audit); db.flush()
                                db.add_all([AuditSessionPracticeArea(audit_session_id=audit.id, practice_area_id=pa.id) for pa in db.scalars(select(PracticeArea)).all()])
                                db.commit()
                            app.storage.user['selected_audit_session_id'] = audit.id
                            ui.notify(f'Audit session #{audit.id} created. Opening Evidence Scan.', type='positive')
                            ui.navigate.to('/evidence-scan')
                        ui.button('Create audit session and continue', on_click=create_session).props('color=primary')
            # The remaining tab implementations are retained temporarily for
            # route-level compatibility, but must not render: the dedicated
            # left-menu modules own evidence scanning and package validation.
            return
            with ui.tab_panel(evidence_tab):
                remembered_session = app.storage.user.get('selected_audit_session_id')
                selected_session = remembered_session if remembered_session in session_options else None
                session_select = ui.select(
                    session_options, value=selected_session, label='Audit session',
                ).classes('w-80')
                if not session_options:
                    ui.label('Create an audit session in Audit setup before uploading or scanning evidence.').classes('text-slate-600')
                    ui.button('Open audit setup', on_click=lambda: tabs.set_value(setup_tab)).props('flat color=primary')
                    return
                ui.label('Accepted formats: XLSX, XLS, CSV, TXT, MD, DOC, DOCX, PPTX, PDF, PNG, JPG, and ZIP.').classes('text-slate-600')
                ui.label('Select an audit session first. Files are only stored after they are attached to that session.').classes('text-sm text-slate-500')
                def upload_file(event):
                    if not _require('evidence:write'): return
                    if not session_select.value:
                        ui.notify('Select an audit session before uploading.', type='negative'); return
                    try:
                        with SessionLocal() as db:
                            count = persist_uploaded_evidence(db, int(session_select.value), user_id, event.name, event.content.read(), event.type or None)
                            db.commit()
                        ui.notify(f'Uploaded {count} evidence file(s).', type='positive')
                    except Exception as exc: ui.notify(str(exc), type='negative')
                uploader = ui.upload(on_upload=upload_file, multiple=True, auto_upload=True, max_file_size=get_settings().max_upload_mb * 1024 * 1024, label='Select evidence files').classes('w-full max-w-xl')
                def run_scan():
                    if not _require('audits:write'): return
                    if not session_select.value: ui.notify('Select an audit session first.', type='negative'); return
                    try:
                        with SessionLocal() as db: result = scan_session(db, int(session_select.value), user_id)
                        ui.notify(f"Scan complete: {result['findings_created']} findings from {result['files_processed']} files.", type='positive')
                    except Exception as exc: ui.notify(f'Scan failed: {exc}', type='negative')
                scan_button = ui.button('Run 302-rule evidence scan', on_click=run_scan).props('color=primary').classes('mt-4')
                def update_evidence_controls(event=None):
                    if session_select.value:
                        app.storage.user['selected_audit_session_id'] = session_select.value
                        uploader.enable(); scan_button.enable()
                    else:
                        app.storage.user.pop('selected_audit_session_id', None)
                        uploader.disable(); scan_button.disable()
                session_select.on('update:model-value', update_evidence_controls)
                update_evidence_controls()
    @ui.page(screen_url('findings'))
    def findings_page():
        layout('Findings', 'Generated findings are retained; a rerun supersedes earlier open findings.')
        if not _require_any('findings:read', 'findings:write'):
            return
        with SessionLocal() as db: rows = db.scalars(select(Finding).order_by(Finding.created_at.desc())).all()
        if not rows: ui.label('No findings yet. Create an audit session, upload evidence, then run a scan.').classes('text-slate-600'); return
        _table([('id','ID'),('session','Session'),('practice_area','PA'),('severity','Severity'),('status','Status'),('title','Finding')], [{'id':f.id, 'session':f.audit_session_id, 'practice_area':f.practice_area_code, 'severity':f.severity, 'status':f.status, 'title':f.title} for f in rows])

    @ui.page(screen_url('correlation_map'))
    def correlation_page():
        layout('Artifact Correlation Map', 'Trace persisted audit findings to their linked evidence artifacts. No sample traceability rows are shown.')
        if not _require_any('findings:read', 'findings:write'):
            return
        search = ui.input('Search rule ID, practice area, finding, or artifact').classes('w-full max-w-xl')
        session_id = ui.select(_options(AuditSession, 'id'), label='Audit session (all)').classes('w-64')

        @ui.refreshable
        def render_traceability():
            with SessionLocal() as db:
                query = (
                    select(Finding, EvidenceFile)
                    .outerjoin(FindingEvidence, FindingEvidence.finding_id == Finding.id)
                    .outerjoin(EvidenceFile, EvidenceFile.id == FindingEvidence.evidence_file_id)
                    .order_by(Finding.audit_session_id, Finding.practice_area_code, Finding.id, EvidenceFile.relative_path)
                )
                if session_id.value:
                    query = query.where(Finding.audit_session_id == int(session_id.value))
                pairs = db.execute(query).all()
            traces: dict[int, dict] = {}
            for finding, evidence_file in pairs:
                row = traces.setdefault(finding.id, {
                    'id': finding.id, 'session': finding.audit_session_id, 'rule_id': finding.rule_id or 'Unmapped',
                    'practice_area': finding.practice_area_code, 'finding': finding.title, 'severity': finding.severity,
                    'status': finding.status, 'artifacts': [],
                })
                if evidence_file:
                    row['artifacts'].append(evidence_file.relative_path)
            term = (search.value or '').strip().lower()
            rows = []
            for trace in traces.values():
                artifacts = ', '.join(trace['artifacts']) or 'No linked evidence artifact'
                if term and term not in f"{trace['rule_id']} {trace['practice_area']} {trace['finding']} {artifacts}".lower():
                    continue
                rows.append({**trace, 'artifact_paths': list(trace['artifacts']), 'artifacts': artifacts,
                             'trace_status': 'Evidence linked' if trace['artifacts'] else 'Evidence link missing'})
            linked = sum(1 for row in rows if row['trace_status'] == 'Evidence linked')
            with ui.row().classes('gap-4 flex-wrap'):
                for label, value in [('Requirements/findings', len(rows)), ('Evidence-linked', linked), ('Links missing', len(rows) - linked)]:
                    with ui.card().classes('w-48'):
                        ui.label(label).classes('text-slate-600')
                        ui.label(str(value)).classes('text-3xl font-bold')
            if not rows:
                ui.label('No persisted finding-to-evidence links match these filters. Run a scan that produces findings and linked evidence first.').classes('text-slate-600 mt-4')
                return
            ui.separator().classes('my-4')
            _table(
                [('id', 'Finding ID'), ('session', 'Session'), ('rule_id', 'Requirement/rule'), ('practice_area', 'Practice area'),
                 ('finding', 'Finding'), ('artifacts', 'Linked evidence artifacts'), ('trace_status', 'Trace status')],
                rows,
            )
            ui.label('Traceability detail').classes('text-lg font-bold mt-4')
            for row in rows:
                with ui.expansion(f"#{row['id']} — {row['rule_id']} — {row['trace_status']}").classes('w-full'):
                    ui.label(f"Practice area: {row['practice_area']} | Severity: {row['severity']} | Finding status: {row['status']}")
                    ui.label(row['finding']).classes('font-medium')
                    if row['artifact_paths']:
                        ui.label('Linked artifacts').classes('font-bold mt-2')
                        for artifact in row['artifact_paths']:
                            ui.label(artifact).classes('text-slate-600')
                    else:
                        ui.label('No artifact is linked to this finding; evidence traceability is incomplete.').classes('text-negative')

        ui.button('Apply filters', on_click=render_traceability.refresh).props('color=primary').classes('my-4')
        render_traceability()

    @ui.page(screen_url('reports'))
    def reports_page():
        layout('Reports', 'Generate persisted Audit Findings Reports (AFR) from an audit session.')
        if not _require_any('reports:read', 'reports:write'):
            return
        selected = ui.select(_options(AuditSession, 'id'), label='Audit session').classes('w-80')
        fmt = ui.select(['xlsx', 'docx', 'pdf'], value='xlsx', label='Format').classes('w-48')
        def generate():
            if not _require('reports:write'): return
            if not selected.value: ui.notify('Select an audit session.', type='negative'); return
            try:
                with SessionLocal() as db: report = create_afr(db, int(selected.value), _current_user_id(), fmt.value)
                ui.notify(f'Report #{report.id} generated: {Path(report.storage_path).name}', type='positive')
            except Exception as exc: ui.notify(str(exc), type='negative')
        ui.button('Generate AFR', on_click=generate).props('color=primary')
        with SessionLocal() as db: reports = db.scalars(select(GeneratedReport).order_by(GeneratedReport.created_at.desc())).all()
        if reports:
            ui.separator().classes('my-4'); ui.label('Generated reports').classes('text-lg font-bold')
            report_rows = [{
                'id': report.id,
                'session': report.audit_session_id,
                'type': report.report_type,
                'file': Path(report.storage_path).name,
                'created': report.created_at.strftime('%Y-%m-%d %H:%M UTC'),
                'download_url': f'/api/v1/reports/{report.id}/download',
            } for report in reports]
            table = ui.table(columns=[
                {'name': 'id', 'label': 'Report ID', 'field': 'id', 'align': 'right'},
                {'name': 'session', 'label': 'Audit session', 'field': 'session', 'align': 'right'},
                {'name': 'type', 'label': 'Type', 'field': 'type', 'align': 'left'},
                {'name': 'file', 'label': 'File', 'field': 'file', 'align': 'left'},
                {'name': 'created', 'label': 'Generated', 'field': 'created', 'align': 'left'},
                {'name': 'download', 'label': 'Download', 'field': 'download', 'align': 'right'},
            ], rows=report_rows, row_key='id').props("pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}").classes('w-full')
            table.add_slot('body-cell-download', '''
                <q-td :props="props">
                    <a :href="props.row.download_url" class="text-primary">Download</a>
                </q-td>
            ''')

    @ui.page(screen_url('user_administration'))
    def users_page():
        layout('User administration', 'Only an administrator should create users. There is no public registration page.')
        if not _allowed('*'):
            ui.label('You do not have permission to administer users.').classes('text-negative')
            return
        with SessionLocal() as db:
            users = db.scalars(select(User).options(selectinload(User.roles)).order_by(User.email)).all()
            roles = db.scalars(select(Role).order_by(Role.name)).all()
            user_rows = [{'id': u.id, 'email': u.email, 'name': u.display_name, 'roles': ', '.join(r.name for r in u.roles), 'active': 'Yes' if u.is_active else 'No'} for u in users]
        _table([('email','Email'),('name','Display name'),('roles','Roles'),('active','Active')], user_rows, row_key='id')
        ui.separator().classes('my-4'); ui.label('Create user').classes('text-lg font-bold')
        email = ui.input('Email').classes('w-80'); name = ui.input('Display name').classes('w-80'); password = ui.input('Temporary password', password=True).classes('w-80'); role_options = {role.id: role.name for role in roles}; role_select = ui.select(role_options, value=next((role.id for role in roles if role.name == 'Viewer'), next(iter(role_options), None)), label='Role').classes('w-80')
        def create_user():
            try:
                if not _require('*'): return
                if not email.value or not name.value or not password.value or len(password.value) < 12: raise ValueError('Email, name, and a password of at least 12 characters are required.')
                with SessionLocal() as db:
                    if db.scalar(select(User).where(User.email == email.value.lower())): raise ValueError('This email is already registered.')
                    role = db.get(Role, int(role_select.value)) if role_select.value else None
                    if not role: raise ValueError('Select a valid role.')
                    db.add(User(email=email.value.lower(), display_name=name.value.strip(), password_hash=hash_password(password.value), roles=[role])); db.commit()
                ui.notify('User created. Refresh this page to view the new account.', type='positive')
            except Exception as exc: ui.notify(str(exc), type='negative')
        ui.button('Create user', on_click=create_user).props('color=primary')
