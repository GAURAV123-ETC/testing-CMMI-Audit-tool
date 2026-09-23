"""Database-backed NiceGUI audit workflow pages."""
from datetime import date, datetime, timedelta, timezone

from nicegui import app, ui
from app.core.screen_registry import (create_disabled_screen_mappings,
                                      has_screen_permission, screen_url,
                                      set_role_screen_permission)
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.audit_log import log_action
from app.db.database import SessionLocal
from app.db.models import (AuditProject, AuditSession, AuditSessionPracticeArea,
                           ChecklistVersion, Customer, GeneratedReport,
                           MapRoleScreen, MdScreen, PracticeArea, Role, User)
from app.gui.layout import layout
from app.services.audit_engine.evidence_scan import scan_session
from app.services.evidence_ingestion import persist_uploaded_evidence
from app.services.auth.service import get_session_user
from app.services.user_administration import (
    assignable_role_names, create_user as create_managed_user,
    delete_user as delete_managed_user,
    update_user as update_managed_user,
)

# India uses a fixed UTC+05:30 offset and has no daylight-saving time.  A
# fixed timezone keeps local Windows deployments working even when the Python
# IANA ``tzdata`` package is not installed.
INDIA_TIME_ZONE = timezone(timedelta(hours=5, minutes=30), name='IST')


def _format_ist(timestamp: datetime | None) -> str:
    """Render persisted UTC timestamps in Indian Standard Time for the UI."""
    if timestamp is None:
        return ''
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(INDIA_TIME_ZONE).strftime('%Y-%m-%d %H:%M')


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
                            outcome = persist_uploaded_evidence(db, int(session_select.value), user_id, event.name, event.content.read(), event.type or None)
                            db.commit()
                        ui.notify(f'Uploaded {outcome.files_persisted} evidence file(s)' + (f'; skipped {outcome.duplicates_skipped} duplicate(s).' if outcome.duplicates_skipped else '.'), type='positive')
                    except Exception as exc: ui.notify(str(exc), type='negative')
                uploader = ui.upload(on_upload=upload_file, multiple=True, auto_upload=True, max_file_size=get_settings().max_upload_mb * 1024 * 1024, label='Select evidence files').classes('w-full max-w-xl')
                def run_scan():
                    if not _require('audits:write'): return
                    if not session_select.value: ui.notify('Select an audit session first.', type='negative'); return
                    try:
                        with SessionLocal() as db: result = scan_session(db, int(session_select.value), user_id)
                        ui.notify(f"Scoped scan complete: {result.get('evidence_findings_created', result['findings_created'])} file-backed finding(s) across mapped practice areas.", type='positive')
                    except Exception as exc: ui.notify(f'Scan failed: {exc}', type='negative')
                scan_button = ui.button('Run scoped CMMI evidence scan', on_click=run_scan).props('color=primary').classes('mt-4')
                def update_evidence_controls(event=None):
                    if session_select.value:
                        app.storage.user['selected_audit_session_id'] = session_select.value
                        uploader.enable(); scan_button.enable()
                    else:
                        app.storage.user.pop('selected_audit_session_id', None)
                        uploader.disable(); scan_button.disable()
                session_select.on('update:model-value', update_evidence_controls)
                update_evidence_controls()
    @ui.page(screen_url('reports'))
    def reports_page():
        layout('Reports', 'Search, review, and download generated Audit Findings Reports (AFR).')
        if not _screen_allowed('reports'):
            ui.label('You do not have permission to view AFR Reports.').classes('text-negative')
            return
        ui.label('Generated reports').classes('text-lg font-bold mt-4')
        report_search = ui.input(
            'Search reports',
            placeholder='Report ID, project name, audit session, or generated date/time',
        ).props('outlined dense clearable').classes('w-full max-w-xl mt-2')
        report_search.add_slot('prepend', '<q-icon name="search" />')

        @ui.refreshable
        def generated_reports_table() -> None:
            with SessionLocal() as db:
                report_records = db.execute(
                    select(GeneratedReport, AuditSession, AuditProject)
                    .join(AuditSession, AuditSession.id == GeneratedReport.audit_session_id)
                    .join(AuditProject, AuditProject.id == AuditSession.project_id)
                    .order_by(GeneratedReport.created_at.desc(), GeneratedReport.id.desc())
                ).all()
            report_rows = [{
                'id': report.id,
                'project': project.name,
                'session': audit.audit_name or f'Audit session #{audit.id}',
                'created': _format_ist(report.created_at),
                'download_url': f'/api/v1/reports/{report.id}/download',
            } for report, audit, project in report_records]
            search_text = str(report_search.value or '').strip().casefold()
            if search_text:
                report_rows = [row for row in report_rows if search_text in ' '.join(
                    str(row[column]).casefold() for column in ('id', 'project', 'session', 'created')
                )]
            if not report_rows:
                ui.label('No generated reports match the current search.').classes('text-slate-600 mt-2')
                return
            table = ui.table(columns=[
                {'name': 'id', 'label': 'Report ID', 'field': 'id', 'align': 'right',
                 'headerStyle': 'width: 110px', 'style': 'width: 110px'},
                {'name': 'project', 'label': 'Project Name', 'field': 'project', 'align': 'left',
                 'headerStyle': 'min-width: 180px'},
                {'name': 'session', 'label': 'Audit Session', 'field': 'session', 'align': 'left',
                 'headerStyle': 'min-width: 220px'},
                {'name': 'created', 'label': 'Generated', 'field': 'created', 'align': 'left',
                 'headerStyle': 'width: 190px', 'style': 'width: 190px'},
                {'name': 'download', 'label': 'Download', 'field': 'download', 'align': 'right',
                 'headerStyle': 'width: 120px', 'style': 'width: 120px'},
            ], rows=report_rows, row_key='id').props(
                "flat bordered hide-selection pagination={'rowsPerPage': 10, 'rowsPerPageOptions': [10, 25, 50, 100]}"
            ).classes('w-full mt-2')
            table.add_slot('body-cell-download', '''
                <q-td :props="props">
                    <a :href="props.row.download_url" class="text-primary">Download</a>
                </q-td>
            ''')

        report_search.on('update:model-value', lambda: generated_reports_table.refresh())
        generated_reports_table()

    # User and role administration moved to dedicated, independently
    # permissioned pages. This legacy nested helper is intentionally not
    # registered as a route while existing audit workflow code is retained.
    def users_page():
        layout('User administration', 'Manage users, database-backed roles, and page-level access. Public registration is disabled after initial setup.')
        if not _screen_allowed('user_administration'):
            ui.label('You do not have permission to administer users.').classes('text-negative')
            return

        def open_user_dialog(user_id: int | None = None) -> None:
            existing = None
            if user_id is not None:
                with SessionLocal() as db:
                    existing = db.scalar(select(User).options(selectinload(User.roles)).where(User.id == user_id))
                if not existing:
                    ui.notify('This user no longer exists.', type='warning')
                    user_table.refresh()
                    return
            editing = existing is not None
            with SessionLocal() as db:
                role_names = assignable_role_names(db)
            if not role_names:
                ui.notify('Create a role before adding a user.', type='negative')
                return
            with ui.dialog() as dialog, ui.card().classes('w-full max-w-lg p-6'):
                ui.label('Edit user' if editing else 'Add user').classes('text-xl font-bold')
                ui.label('Choose one database-backed role. Its page access is managed below.').classes('text-sm text-slate-600')
                email = ui.input('Email', value=existing.email if existing else '').props('type=email').classes('w-full')
                name = ui.input('Display name', value=existing.display_name if existing else '').classes('w-full')
                selected_role = existing.roles[0].name if editing and existing.roles else ('Viewer' if 'Viewer' in role_names else role_names[0])
                role = ui.select(role_names, value=selected_role, label='Role').classes('w-full')
                password = ui.input(
                    'New password (leave blank to keep current password)' if editing else 'Temporary password',
                    password=True, password_toggle_button=True,
                ).classes('w-full')

                def save() -> None:
                    try:
                        if not _screen_allowed('user_administration', 'write'):
                            ui.notify('You do not have permission to change users.', type='negative')
                            return
                        with SessionLocal() as db:
                            actor_id = _current_user_id()
                            if editing:
                                update_managed_user(
                                    db, actor_id=actor_id, user_id=existing.id, email=email.value,
                                    display_name=name.value, role_name=role.value, password=password.value or None,
                                )
                            else:
                                create_managed_user(
                                    db, actor_id=actor_id, email=email.value, display_name=name.value,
                                    password=password.value, role_name=role.value,
                                )
                            db.commit()
                        dialog.close()
                        user_table.refresh()
                        ui.notify('User updated.' if editing else 'User created.', type='positive')
                    except Exception as exc:
                        ui.notify(str(exc), type='negative')

                with ui.row().classes('w-full justify-end gap-2 mt-4'):
                    ui.button('Cancel', on_click=dialog.close).props('flat')
                    ui.button('Save changes' if editing else 'Add user', on_click=save).props('color=primary')
            dialog.open()

        def confirm_delete(user_id: int) -> None:
            with SessionLocal() as db:
                account = db.scalar(select(User).where(User.id == user_id))
            if not account:
                ui.notify('This user no longer exists.', type='warning')
                user_table.refresh()
                return
            with ui.dialog() as dialog, ui.card().classes('w-full max-w-md p-6'):
                ui.label('Delete user?').classes('text-xl font-bold')
                ui.label(f'Delete {account.display_name} ({account.email})? This cannot be undone.').classes('text-slate-600')

                def remove() -> None:
                    try:
                        if not _screen_allowed('user_administration', 'write'):
                            ui.notify('You do not have permission to delete users.', type='negative')
                            return
                        with SessionLocal() as db:
                            delete_managed_user(db, actor_id=_current_user_id(), user_id=user_id)
                            db.commit()
                        dialog.close()
                        user_table.refresh()
                        ui.notify('User deleted.', type='positive')
                    except Exception as exc:
                        ui.notify(str(exc), type='negative')

                with ui.row().classes('w-full justify-end gap-2 mt-4'):
                    ui.button('Cancel', on_click=dialog.close).props('flat')
                    ui.button('Delete user', on_click=remove).props('color=negative')
            dialog.open()

        with ui.row().classes('w-full justify-between items-center mb-4'):
            ui.label('Users').classes('text-xl font-bold')
            ui.button('Add user', icon='person_add', on_click=lambda: open_user_dialog()).props('color=primary')

        @ui.refreshable
        def user_table() -> None:
            with SessionLocal() as db:
                users = db.scalars(select(User).options(selectinload(User.roles)).order_by(User.email)).all()
            rows = [
                {'id': account.id, 'email': account.email, 'name': account.display_name,
                 'role': ', '.join(sorted(role.name for role in account.roles)) or 'No role',
                 'status': 'Active' if account.is_active else 'Inactive'}
                for account in users
            ]
            table = ui.table(columns=[
                {'name': 'email', 'label': 'Email', 'field': 'email', 'align': 'left'},
                {'name': 'name', 'label': 'Display name', 'field': 'name', 'align': 'left'},
                {'name': 'role', 'label': 'Role', 'field': 'role', 'align': 'left'},
                {'name': 'status', 'label': 'Status', 'field': 'status', 'align': 'left'},
                {'name': 'actions', 'label': 'Actions', 'field': 'actions', 'align': 'right'},
            ], rows=rows, row_key='id').props(
                "pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}"
            ).classes('w-full')
            table.add_slot('body-cell-actions', '''
                <q-td :props="props">
                    <q-btn flat dense round icon="edit" color="primary" aria-label="Edit user"
                        @click="$parent.$emit('edit_user', props.row.id)" />
                    <q-btn flat dense round icon="delete" color="negative" aria-label="Delete user"
                        @click="$parent.$emit('delete_user', props.row.id)" />
                </q-td>
            ''')
            table.on('edit_user', lambda event: open_user_dialog(int(event.args)))
            table.on('delete_user', lambda event: confirm_delete(int(event.args)))

        user_table()

        with ui.card().classes('w-full mt-6'):
            with ui.row().classes('w-full items-center justify-between'):
                with ui.column().classes('gap-0'):
                    ui.label('Roles and page access').classes('text-xl font-bold')
                    ui.label('Roles and their screen permissions are stored in the database. New roles start with no page access.').classes('text-sm text-slate-600')

                def open_role_dialog() -> None:
                    with ui.dialog() as dialog, ui.card().classes('w-full max-w-lg p-6'):
                        ui.label('Add role').classes('text-xl font-bold')
                        name = ui.input('Role name').classes('w-full')
                        description = ui.input('Description').classes('w-full')

                        def save_role() -> None:
                            try:
                                if not _screen_allowed('user_administration', 'write'):
                                    ui.notify('You do not have permission to create roles.', type='negative')
                                    return
                                role_name = (name.value or '').strip()
                                if not 2 <= len(role_name) <= 64:
                                    raise ValueError('Role name must contain 2 to 64 characters.')
                                if len((description.value or '').strip()) > 255:
                                    raise ValueError('Role description must not exceed 255 characters.')
                                with SessionLocal() as db:
                                    if db.scalar(select(Role).where(func.lower(Role.name) == role_name.casefold())):
                                        raise ValueError('A role with this name already exists.')
                                    new_role = Role(name=role_name, description=(description.value or '').strip())
                                    db.add(new_role)
                                    db.flush()
                                    create_disabled_screen_mappings(db, new_role)
                                    log_action(db, 'role_created', user_id=_current_user_id(),
                                               entity_type='role', entity_id=str(new_role.id), detail=new_role.name)
                                    db.commit()
                                    new_role_id = new_role.id
                                dialog.close()
                                refresh_role_options(new_role_id)
                                ui.notify(f'{role_name} role created with no page access.', type='positive')
                            except Exception as exc:
                                ui.notify(str(exc), type='negative')

                        with ui.row().classes('w-full justify-end gap-2 mt-4'):
                            ui.button('Cancel', on_click=dialog.close).props('flat')
                            ui.button('Add role', on_click=save_role).props('color=primary')
                    dialog.open()

                ui.button('Add role', icon='add', on_click=open_role_dialog).props('outline color=primary')

            def role_options() -> dict[int, str]:
                with SessionLocal() as db:
                    return {
                        item.id: item.name + (f' — {item.description}' if item.description else '')
                        for item in db.scalars(select(Role).order_by(Role.name)).all()
                    }

            role_select = ui.select(role_options(), label='Role').classes('w-full max-w-2xl mt-4')

            @ui.refreshable
            def page_access() -> None:
                selected_role_id = int(role_select.value) if role_select.value else None
                if selected_role_id is None:
                    ui.label('Select a role to configure its page access.').classes('text-sm text-slate-600 mt-3')
                    return
                with SessionLocal() as db:
                    screens = db.scalars(select(MdScreen).where(MdScreen.is_active.is_(True)).order_by(MdScreen.display_order)).all()
                    mappings = {
                        mapping.screen_id: mapping
                        for mapping in db.scalars(select(MapRoleScreen).where(MapRoleScreen.role_id == selected_role_id)).all()
                    }
                ui.label('Page access').classes('text-lg font-bold mt-4')
                access_controls = {}
                for screen in screens:
                    mapping = mappings.get(screen.screen_id)
                    value = 'write' if mapping and mapping.can_write else ('read' if mapping and mapping.can_read else 'none')
                    with ui.row().classes('w-full max-w-2xl items-center justify-between py-1'):
                        ui.label(screen.menu_name).classes('font-medium')
                        access_controls[screen.screen_id] = ui.select(
                            {'none': 'No access', 'read': 'View only', 'write': 'View and manage'},
                            value=value,
                        ).classes('w-52')

                def save_page_access() -> None:
                    try:
                        if not _screen_allowed('user_administration', 'write'):
                            ui.notify('You do not have permission to change page access.', type='negative')
                            return
                        with SessionLocal() as db:
                            for screen_id, control in access_controls.items():
                                set_role_screen_permission(
                                    db, selected_role_id, screen_id,
                                    can_read=control.value in {'read', 'write'},
                                    can_write=control.value == 'write',
                                )
                            log_action(
                                db, 'role_screen_permissions_updated', user_id=_current_user_id(),
                                entity_type='role', entity_id=str(selected_role_id),
                                detail=f'screens={len(access_controls)}',
                            )
                            db.commit()
                        page_access.refresh()
                        ui.notify('Page access saved.', type='positive')
                    except Exception as exc:
                        ui.notify(str(exc), type='negative')

                ui.button('Save page access', icon='save', on_click=save_page_access).props('color=primary').classes('mt-3')

            def refresh_role_options(preferred_role_id: int | None = None) -> None:
                options = role_options()
                role_select.set_options(options)
                if preferred_role_id in options:
                    role_select.value = preferred_role_id
                elif role_select.value not in options:
                    role_select.value = next(iter(options), None)
                role_select.update()
                page_access.refresh()

            role_select.on_value_change(lambda _: page_access.refresh())
            refresh_role_options()
