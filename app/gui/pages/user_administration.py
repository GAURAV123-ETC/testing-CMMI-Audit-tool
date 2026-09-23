"""Manage Users page, kept separate from role and permission administration."""
from nicegui import ui
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.screen_registry import has_screen_permission, screen_url
from app.db.database import SessionLocal
from app.db.models import User
from app.gui.layout import layout
from app.gui.search import table_search_input
from app.services.auth.service import get_session_user
from app.services.user_administration import (
    assignable_role_names, create_user, set_user_active, update_user,
)


def _current_user_id() -> int:
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        if not user:
            raise RuntimeError('Your session has expired. Please sign in again.')
        return user.id


def _allowed(action: str = 'read') -> bool:
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        return bool(user and has_screen_permission(db, user, 'user_administration', action))


def register() -> None:
    @ui.page(screen_url('user_administration'))
    def users_page() -> None:
        layout('Manage Users', 'Create, update, activate, and deactivate application accounts.')
        if not _allowed():
            ui.label('You do not have permission to view Manage Users.').classes('text-negative')
            return
        can_write = _allowed('write')
        state = {'query': '', 'status': 'all'}

        def open_user_dialog(user_id: int | None = None) -> None:
            existing = None
            if user_id is not None:
                with SessionLocal() as db:
                    existing = db.scalar(select(User).options(selectinload(User.roles)).where(User.id == user_id))
            if user_id is not None and not existing:
                ui.notify('This user no longer exists.', type='warning')
                users_table.refresh()
                return
            with SessionLocal() as db:
                roles = assignable_role_names(db)
            if not roles:
                ui.notify('Create a role in Manage Roles before adding a user.', type='negative')
                return
            editing = existing is not None
            selected_role = existing.roles[0].name if editing and existing.roles else roles[0]
            with ui.dialog() as dialog, ui.card().classes('w-full max-w-lg p-6'):
                ui.label('Edit user' if editing else 'Add user').classes('text-xl font-bold')
                ui.label('Each account receives one database-backed access role.').classes('text-sm text-slate-600')
                email = ui.input('Email', value=existing.email if existing else '').props('type=email').classes('w-full')
                name = ui.input('Display name', value=existing.display_name if existing else '').classes('w-full')
                role = ui.select(roles, value=selected_role, label='Role').classes('w-full')
                password = ui.input(
                    'New password (leave blank to keep the current password)' if editing else 'Temporary password',
                    password=True, password_toggle_button=True,
                ).classes('w-full')

                def save() -> None:
                    try:
                        with SessionLocal() as db:
                            if editing:
                                update_user(db, actor_id=_current_user_id(), user_id=existing.id, email=email.value,
                                            display_name=name.value, role_name=role.value, password=password.value or None)
                            else:
                                create_user(db, actor_id=_current_user_id(), email=email.value,
                                            display_name=name.value, role_name=role.value, password=password.value)
                            db.commit()
                        ui.notify('User updated.' if editing else 'User created.', type='positive')
                        dialog.close()
                        users_table.refresh()
                    except Exception as exc:
                        ui.notify(str(exc), type='negative')

                with ui.row().classes('w-full justify-end gap-2 mt-4'):
                    ui.button('Cancel', on_click=dialog.close).props('flat')
                    ui.button('Save changes' if editing else 'Add user', on_click=save).props('color=primary')
            dialog.open()

        def confirm_status(user_id: int, is_active: bool) -> None:
            with SessionLocal() as db:
                account = db.get(User, user_id)
            if not account:
                users_table.refresh()
                return
            verb = 'Reactivate' if is_active else 'Deactivate'
            with ui.dialog() as dialog, ui.card().classes('w-full max-w-md p-6'):
                ui.label(f'{verb} user?').classes('text-xl font-bold')
                ui.label(f'{verb} {account.display_name} ({account.email})?').classes('text-slate-600')
                if not is_active:
                    ui.label('Their active sessions will be revoked. Audit history remains available.').classes('text-sm text-slate-600')

                def save_status() -> None:
                    try:
                        with SessionLocal() as db:
                            set_user_active(db, actor_id=_current_user_id(), user_id=user_id, is_active=is_active)
                            db.commit()
                        ui.notify(f'User {"reactivated" if is_active else "deactivated"}.', type='positive')
                        dialog.close()
                        users_table.refresh()
                    except Exception as exc:
                        ui.notify(str(exc), type='negative')

                with ui.row().classes('w-full justify-end gap-2 mt-4'):
                    ui.button('Cancel', on_click=dialog.close).props('flat')
                    ui.button(verb, on_click=save_status).props('color=primary' if is_active else 'color=negative')
            dialog.open()

        with ui.row().classes('w-full items-center justify-between gap-3 mb-3'):
            ui.label('Users').classes('text-xl font-bold')
            if can_write:
                ui.button('Add user', icon='person_add', on_click=open_user_dialog).props('color=primary')
        with ui.row().classes('w-full gap-3 items-center'):
            search = table_search_input(
                'Search users', 'Name, email, or role', max_width='max-w-xl'
            )
            status = ui.select({'all': 'All statuses', 'active': 'Active', 'inactive': 'Inactive'}, value='all', label='Status').classes('w-48')

        @ui.refreshable
        def users_table() -> None:
            with SessionLocal() as db:
                accounts = db.scalars(select(User).options(selectinload(User.roles)).order_by(User.email)).all()
            query = state['query'].casefold()
            rows = []
            for account in accounts:
                roles = ', '.join(sorted(item.name for item in account.roles)) or 'No role'
                if query and query not in f'{account.email} {account.display_name} {roles}'.casefold():
                    continue
                if state['status'] != 'all' and (account.is_active != (state['status'] == 'active')):
                    continue
                rows.append({'id': account.id, 'email': account.email, 'name': account.display_name,
                             'role': roles, 'status': 'Active' if account.is_active else 'Inactive'})
            columns = [
                {'name': 'email', 'label': 'Email', 'field': 'email', 'align': 'left'},
                {'name': 'name', 'label': 'Display name', 'field': 'name', 'align': 'left'},
                {'name': 'role', 'label': 'Role', 'field': 'role', 'align': 'left'},
                {'name': 'status', 'label': 'Status', 'field': 'status', 'align': 'left'},
            ]
            if can_write:
                columns.append({'name': 'actions', 'label': 'Actions', 'field': 'actions', 'align': 'right'})
            table = ui.table(columns=columns, rows=rows, row_key='id').props(
                "pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}"
            ).classes('w-full')
            if can_write:
                table.add_slot('body-cell-actions', '''
                    <q-td :props="props">
                        <q-btn flat dense round icon="edit" color="primary" aria-label="Edit user" @click="$parent.$emit('edit_user', props.row.id)" />
                        <q-btn flat dense round :icon="props.row.status === 'Active' ? 'person_off' : 'person_add'"
                            :color="props.row.status === 'Active' ? 'negative' : 'positive'"
                            :aria-label="props.row.status === 'Active' ? 'Deactivate user' : 'Reactivate user'"
                            @click="$parent.$emit('set_user_status', {id: props.row.id, active: props.row.status !== 'Active'})" />
                    </q-td>
                ''')
                table.on('edit_user', lambda event: open_user_dialog(int(event.args)))
                table.on('set_user_status', lambda event: confirm_status(int(event.args['id']), bool(event.args['active'])))

        def refresh_query() -> None:
            state['query'] = search.value or ''
            state['status'] = status.value or 'all'
            users_table.refresh()

        search.on_value_change(lambda _: refresh_query())
        status.on_value_change(lambda _: refresh_query())
        users_table()
