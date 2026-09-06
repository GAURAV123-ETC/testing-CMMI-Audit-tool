"""Single-form customer, project, and audit-session setup."""
from datetime import date

from nicegui import app, ui
from app.core.screen_registry import screen_url
from sqlalchemy import func, select

from app.db.database import SessionLocal
from app.db.models import AuditProject, AuditSession, AuditSessionPracticeArea, ChecklistVersion, Customer, PracticeArea
from app.gui.layout import layout
from app.gui.pages.audit_workspace import _current_user_id, _screen_allowed


def register():
    @ui.page(screen_url('add_project'))
    def add_project_page():
        layout('Add Project', 'Add customer, project, and audit-session details in one form. The saved details become available in Evidence Scan immediately.')
        if not _screen_allowed('add_project'):
            ui.label('You do not have permission to add project details.').classes('text-negative')
            return

        @ui.refreshable
        def saved_details() -> None:
            with SessionLocal() as db:
                sessions = db.scalars(select(AuditSession).order_by(AuditSession.created_at.desc())).all()
                rows = []
                for session in sessions:
                    project = db.get(AuditProject, session.project_id)
                    customer = db.get(Customer, project.customer_id) if project else None
                    rows.append({
                        'id': session.id,
                        'customer': customer.name if customer else 'Unknown customer',
                        'project': project.name if project else 'Unknown project',
                        'repository': (project.repository_url or '—') if project else '—',
                        'audit_session': session.audit_name or f'Audit session #{session.id}',
                        'audit_date': session.audit_date.isoformat() if session.audit_date else '—',
                        'auditors': session.auditors or '—',
                        'auditees': session.auditees or '—',
                        'ruleset': session.checklist_version_id,
                        'created': session.created_at.strftime('%Y-%m-%d %H:%M UTC'),
                    })
            ui.label('Saved details').classes('text-lg font-bold mt-5')
            ui.table(columns=[
                {'name': 'customer', 'label': 'Customer', 'field': 'customer', 'align': 'left'},
                {'name': 'project', 'label': 'Project', 'field': 'project', 'align': 'left'},
                {'name': 'repository', 'label': 'Repository', 'field': 'repository', 'align': 'left'},
                {'name': 'audit_session', 'label': 'Audit session', 'field': 'audit_session', 'align': 'left'},
                {'name': 'audit_date', 'label': 'Audit date', 'field': 'audit_date', 'align': 'left'},
                {'name': 'auditors', 'label': 'Auditors', 'field': 'auditors', 'align': 'left'},
                {'name': 'auditees', 'label': 'Auditees', 'field': 'auditees', 'align': 'left'},
                {'name': 'ruleset', 'label': 'Ruleset ID', 'field': 'ruleset', 'align': 'right'},
                {'name': 'created', 'label': 'Added', 'field': 'created', 'align': 'left'},
            ], rows=rows, row_key='id').props("pagination={'rowsPerPage': 10}").classes('w-full max-w-7xl')

        with ui.row().classes('w-full max-w-7xl items-center justify-between mt-4'):
            ui.label('Saved customers, projects, and audit sessions').classes('text-lg font-bold')
            ui.button('Add Project', icon='add_business', on_click=lambda: add_project_dialog.open()).props('color=primary')

        with ui.dialog() as add_project_dialog, ui.card().classes('w-[1000px] max-w-full'):
            ui.label('Add customer, project, and audit session').classes('text-xl font-bold')
            ui.label('Customer name, project name, and audit-session name are required. The same customer + project + audit-session name and date are reused, preventing duplicate records.').classes('text-sm text-slate-600')
            with ui.row().classes('w-full gap-4 flex-wrap mt-2'):
                customer_name = ui.input('Customer name').classes('w-80')
                customer_email = ui.input('Customer contact email (optional)').classes('w-80')
                project_name = ui.input('Project name').classes('w-80')
                repository_url = ui.input('Repository URL (optional)').classes('w-80')
                audit_name = ui.input('Audit session name').classes('w-80')
                audit_date = ui.input('Audit date (optional, YYYY-MM-DD)').classes('w-80')
                auditors = ui.input('Auditors (optional, comma-separated)').classes('w-80')
                auditees = ui.input('Auditees (optional, comma-separated)').classes('w-80')

            def save_details() -> None:
                if not _screen_allowed('add_project', 'write'):
                    ui.notify('Add Project write permission is required.', type='negative')
                    return
                customer_value = (customer_name.value or '').strip()
                project_value = (project_name.value or '').strip()
                audit_value = (audit_name.value or '').strip()
                if not customer_value or not project_value or not audit_value:
                    ui.notify('Customer name, project name, and audit-session name are required.', type='warning')
                    return
                try:
                    parsed_date = date.fromisoformat(audit_date.value) if audit_date.value else None
                except ValueError:
                    ui.notify('Use YYYY-MM-DD for the audit date.', type='warning')
                    return
                try:
                    with SessionLocal() as db:
                        user_id = _current_user_id()
                        customer = db.scalar(select(Customer).where(
                            func.lower(Customer.name) == customer_value.casefold()
                        ))
                        if not customer:
                            customer = Customer(name=customer_value, contact_email=(customer_email.value or '').strip() or None,
                                                created_by_id=user_id)
                            db.add(customer); db.flush()
                        elif (customer_email.value or '').strip():
                            customer.contact_email = customer_email.value.strip()
                        project = db.scalar(select(AuditProject).where(
                            AuditProject.customer_id == customer.id,
                            func.lower(AuditProject.name) == project_value.casefold(),
                        ))
                        if not project:
                            project = AuditProject(customer_id=customer.id, name=project_value,
                                                   repository_url=(repository_url.value or '').strip() or None,
                                                   owner_id=user_id)
                            db.add(project); db.flush()
                        elif (repository_url.value or '').strip():
                            project.repository_url = repository_url.value.strip()
                        # Serialize audit-session creation per project. This
                        # complements the duplicate lookup below when two UI
                        # submissions arrive at the same time.
                        project = db.scalar(select(AuditProject).where(
                            AuditProject.id == project.id
                        ).with_for_update())
                        audit = db.scalar(select(AuditSession).where(
                            AuditSession.project_id == project.id,
                            func.lower(AuditSession.audit_name) == audit_value.casefold(),
                            AuditSession.audit_date == parsed_date,
                        ))
                        created_audit = audit is None
                        if not audit:
                            version = db.scalar(select(ChecklistVersion).where(ChecklistVersion.is_active.is_(True)).order_by(ChecklistVersion.id.desc()))
                            if not version:
                                raise ValueError('No active ruleset is available. Ask an administrator to activate a rules catalogue.')
                            audit = AuditSession(project_id=project.id, checklist_version_id=version.id,
                                                 audit_name=audit_value, audit_date=parsed_date,
                                                 auditors=(auditors.value or '').strip() or None,
                                                 auditees=(auditees.value or '').strip() or None,
                                                 created_by_id=user_id)
                            db.add(audit); db.flush()
                            db.add_all([AuditSessionPracticeArea(audit_session_id=audit.id, practice_area_id=item.id)
                                        for item in db.scalars(select(PracticeArea)).all()])
                        db.commit()
                        customer_id, project_id, audit_id = customer.id, project.id, audit.id
                    app.storage.user['selected_evidence_customer_id'] = customer_id
                    app.storage.user['selected_evidence_project_id'] = project_id
                    app.storage.user['selected_audit_session_id'] = audit_id
                    saved_details.refresh()
                    ui.notify(f'Customer and project saved; audit session was {"created" if created_audit else "reused"}.', type='positive')
                    add_project_dialog.close()
                except Exception as exc:
                    ui.notify(f'Could not save details: {exc}', type='negative')

            with ui.row().classes('w-full justify-end gap-2 mt-4'):
                ui.button('Cancel', on_click=add_project_dialog.close).props('flat')
                save_button = ui.button('Save project details', icon='save', on_click=save_details).props('color=primary')
            if not _screen_allowed('add_project', 'write'):
                save_button.disable()

        saved_details()
