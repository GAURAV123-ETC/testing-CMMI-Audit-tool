"""Single-form customer, project, and audit-session setup."""
from datetime import date

from nicegui import app, ui
from app.core.screen_registry import screen_url
from sqlalchemy import delete, func, select

from app.db.database import SessionLocal
from app.db.models import (
    Approval,
    AuditProject,
    AuditSession,
    AuditSessionPracticeArea,
    ChecklistVersion,
    Customer,
    EvidenceSource,
    Finding,
    GeneratedReport,
    IncidentLog,
    IrpValidationFinding,
    PracticeArea,
    ScanJob,
)
from app.gui.layout import layout
from app.gui.pages.audit_workspace import _current_user_id, _screen_allowed


def register():
    @ui.page(screen_url('add_project'))
    def add_project_page():
        layout('Add Project', 'Add customer, project, and audit-session details in one form. The saved details become available in Evidence Scan immediately.')
        if not _screen_allowed('add_project'):
            ui.label('You do not have permission to add project details.').classes('text-negative')
            return

        def edit_saved_details(session_id: int) -> None:
            """Edit the customer, project, and session represented by one saved row."""
            if not _screen_allowed('add_project', 'write'):
                ui.notify('Add Project write permission is required.', type='negative')
                return
            with SessionLocal() as db:
                audit = db.get(AuditSession, session_id)
                project = db.get(AuditProject, audit.project_id) if audit else None
                customer = db.get(Customer, project.customer_id) if project else None
            if not audit or not project or not customer:
                ui.notify('The saved project details no longer exist.', type='negative')
                return

            with ui.dialog() as edit_dialog, ui.card().classes('w-[1000px] max-w-full'):
                ui.label('Edit saved project details').classes('text-xl font-bold')
                ui.label('Changes keep existing scan history attached to this same audit session.').classes('text-sm text-slate-600')
                with ui.row().classes('w-full gap-4 flex-wrap mt-2'):
                    customer_name = ui.input('Customer name', value=customer.name).classes('w-80')
                    customer_email = ui.input('Customer contact email (optional)', value=customer.contact_email or '').classes('w-80')
                    project_name = ui.input('Project name', value=project.name).classes('w-80')
                    repository_url = ui.input('Repository URL (optional)', value=project.repository_url or '').classes('w-80')
                    audit_name = ui.input('Audit session name', value=audit.audit_name or '').classes('w-80')
                    audit_date = ui.input('Audit date (optional)', value=audit.audit_date.isoformat() if audit.audit_date else '').props('type=date').classes('w-80')
                    auditors = ui.input('Auditors (optional, comma-separated)', value=audit.auditors or '').classes('w-80')
                    auditees = ui.input('Auditees (optional, comma-separated)', value=audit.auditees or '').classes('w-80')

                def update_details() -> None:
                    customer_value = (customer_name.value or '').strip()
                    project_value = (project_name.value or '').strip()
                    audit_value = (audit_name.value or '').strip()
                    if not customer_value or not project_value or not audit_value:
                        ui.notify('Customer name, project name, and audit-session name are required.', type='warning')
                        return
                    try:
                        parsed_date = date.fromisoformat(audit_date.value) if audit_date.value else None
                    except ValueError:
                        ui.notify('Choose a valid audit date from the calendar.', type='warning')
                        return
                    try:
                        with SessionLocal() as db:
                            current_audit = db.get(AuditSession, session_id)
                            current_project = db.get(AuditProject, current_audit.project_id) if current_audit else None
                            current_customer = db.get(Customer, current_project.customer_id) if current_project else None
                            if not current_audit or not current_project or not current_customer:
                                raise ValueError('The saved project details no longer exist.')
                            if db.scalar(select(Customer.id).where(
                                func.lower(Customer.name) == customer_value.casefold(), Customer.id != current_customer.id,
                            )):
                                raise ValueError('Another customer already uses that name.')
                            if db.scalar(select(AuditProject.id).where(
                                AuditProject.customer_id == current_customer.id,
                                func.lower(AuditProject.name) == project_value.casefold(),
                                AuditProject.id != current_project.id,
                            )):
                                raise ValueError('Another project for this customer already uses that name.')
                            if db.scalar(select(AuditSession.id).where(
                                AuditSession.project_id == current_project.id,
                                func.lower(AuditSession.audit_name) == audit_value.casefold(),
                                AuditSession.audit_date == parsed_date,
                                AuditSession.id != current_audit.id,
                            )):
                                raise ValueError('Another audit session already uses that name and date for this project.')
                            current_customer.name = customer_value
                            current_customer.contact_email = (customer_email.value or '').strip() or None
                            current_project.name = project_value
                            current_project.repository_url = (repository_url.value or '').strip() or None
                            current_audit.audit_name = audit_value
                            current_audit.audit_date = parsed_date
                            current_audit.auditors = (auditors.value or '').strip() or None
                            current_audit.auditees = (auditees.value or '').strip() or None
                            db.commit()
                        saved_details.refresh()
                        edit_dialog.close()
                        ui.notify('Saved project details updated.', type='positive')
                    except Exception as exc:
                        ui.notify(f'Could not update details: {exc}', type='negative')

                with ui.row().classes('w-full justify-end gap-2 mt-4'):
                    ui.button('Cancel', on_click=edit_dialog.close).props('flat')
                    ui.button('Save changes', icon='save', on_click=update_details).props('color=primary')
            edit_dialog.open()

        def confirm_delete_saved_details(session_id: int) -> None:
            """Delete only a setup that has never accumulated audit history."""
            if not _screen_allowed('add_project', 'write'):
                ui.notify('Add Project write permission is required.', type='negative')
                return
            with SessionLocal() as db:
                audit = db.get(AuditSession, session_id)
            if not audit:
                ui.notify('The saved project details no longer exist.', type='negative')
                return
            with ui.dialog() as delete_dialog, ui.card().classes('w-full max-w-lg'):
                ui.label('Delete saved project details?').classes('text-xl font-bold text-negative')
                ui.label(f'This removes audit session "{audit.audit_name or session_id}". If it is the project\'s only session, the empty project and customer are also removed.').classes('text-slate-700')
                ui.label('Deletion is blocked when the session contains uploaded evidence, scan results, findings, approvals, reports, or validation history.').classes('text-sm text-slate-600 mt-2')

                def delete_details() -> None:
                    try:
                        with SessionLocal() as db:
                            current_audit = db.get(AuditSession, session_id)
                            if not current_audit:
                                raise ValueError('The audit session no longer exists.')
                            blockers = {
                                'uploaded evidence': db.scalar(select(func.count(EvidenceSource.id)).where(EvidenceSource.audit_session_id == session_id)) or 0,
                                'scan jobs': db.scalar(select(func.count(ScanJob.id)).where(ScanJob.audit_session_id == session_id)) or 0,
                                'findings': db.scalar(select(func.count(Finding.id)).where(Finding.audit_session_id == session_id)) or 0,
                                'approvals': db.scalar(select(func.count(Approval.id)).where(Approval.audit_session_id == session_id)) or 0,
                                'reports': db.scalar(select(func.count(GeneratedReport.id)).where(GeneratedReport.audit_session_id == session_id)) or 0,
                                'incident validation data': (db.scalar(select(func.count(IncidentLog.id)).where(IncidentLog.audit_session_id == session_id)) or 0) + (db.scalar(select(func.count(IrpValidationFinding.id)).where(IrpValidationFinding.audit_session_id == session_id)) or 0),
                            }
                            used_by = [name for name, count in blockers.items() if count]
                            if used_by:
                                raise ValueError(f'Cannot delete this audit session because it has {", ".join(used_by)}. Historical audit data is protected.')
                            project_id = current_audit.project_id
                            project = db.get(AuditProject, project_id)
                            customer_id = project.customer_id if project else None
                            db.execute(delete(AuditSessionPracticeArea).where(AuditSessionPracticeArea.audit_session_id == session_id))
                            db.delete(current_audit)
                            db.flush()
                            if project and not db.scalar(select(AuditSession.id).where(AuditSession.project_id == project_id).limit(1)):
                                db.delete(project)
                                db.flush()
                                if customer_id and not db.scalar(select(AuditProject.id).where(AuditProject.customer_id == customer_id).limit(1)):
                                    customer = db.get(Customer, customer_id)
                                    if customer:
                                        db.delete(customer)
                            db.commit()
                        if app.storage.user.get('selected_audit_session_id') == session_id:
                            app.storage.user.pop('selected_evidence_customer_id', None)
                            app.storage.user.pop('selected_evidence_project_id', None)
                            app.storage.user.pop('selected_audit_session_id', None)
                        saved_details.refresh()
                        delete_dialog.close()
                        ui.notify('Unused saved project details deleted.', type='positive')
                    except Exception as exc:
                        ui.notify(f'Could not delete details: {exc}', type='negative')

                with ui.row().classes('w-full justify-end gap-2 mt-4'):
                    ui.button('Cancel', on_click=delete_dialog.close).props('flat')
                    ui.button('Delete permanently', icon='delete_forever', on_click=delete_details).props('color=negative')
            delete_dialog.open()

        @ui.refreshable
        def saved_details() -> None:
            with SessionLocal() as db:
                sessions = db.execute(
                    select(AuditSession, AuditProject, Customer)
                    .join(AuditProject, AuditSession.project_id == AuditProject.id)
                    .join(Customer, AuditProject.customer_id == Customer.id)
                    .order_by(AuditSession.created_at.desc())
                ).all()
                rows = []
                for session, project, customer in sessions:
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
            table = ui.table(columns=[
                {'name': 'customer', 'label': 'Customer', 'field': 'customer', 'align': 'left'},
                {'name': 'project', 'label': 'Project', 'field': 'project', 'align': 'left'},
                {'name': 'repository', 'label': 'Repository', 'field': 'repository', 'align': 'left'},
                {'name': 'audit_session', 'label': 'Audit session', 'field': 'audit_session', 'align': 'left'},
                {'name': 'audit_date', 'label': 'Audit date', 'field': 'audit_date', 'align': 'left'},
                {'name': 'auditors', 'label': 'Auditors', 'field': 'auditors', 'align': 'left'},
                {'name': 'auditees', 'label': 'Auditees', 'field': 'auditees', 'align': 'left'},
                {'name': 'ruleset', 'label': 'Ruleset ID', 'field': 'ruleset', 'align': 'right'},
                {'name': 'created', 'label': 'Added', 'field': 'created', 'align': 'left'},
                {'name': 'actions', 'label': 'Actions', 'field': 'actions', 'align': 'right'},
            ], rows=rows, row_key='id').props("pagination={'rowsPerPage': 10}").classes('w-full max-w-7xl')
            table.add_slot('body-cell-actions', '''
                <q-td :props="props" class="q-gutter-xs">
                    <q-btn flat round dense icon="edit" color="primary" aria-label="Edit saved project details"
                           @click="$parent.$emit('edit_saved_details', props.row.id)" />
                    <q-btn flat round dense icon="delete" color="negative" aria-label="Delete saved project details"
                           @click="$parent.$emit('delete_saved_details', props.row.id)" />
                </q-td>
            ''')
            table.on('edit_saved_details', lambda event: edit_saved_details(int(event.args)))
            table.on('delete_saved_details', lambda event: confirm_delete_saved_details(int(event.args)))

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
                audit_date = ui.input('Audit date (optional)').props('type=date').classes('w-80')
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
                    ui.notify('Choose a valid audit date from the calendar.', type='warning')
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
