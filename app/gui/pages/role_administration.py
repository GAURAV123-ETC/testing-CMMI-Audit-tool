"""Clean two-pane role administration, modelled on the CSD management flow."""
from nicegui import ui
from sqlalchemy import func, select

from app.core.audit_log import log_action
from app.core.screen_registry import create_disabled_screen_mappings, has_screen_permission, screen_url
from app.db.database import SessionLocal
from app.db.models import Role
from app.gui.layout import layout
from app.services.auth.service import get_session_user
from app.services.role_administration import replace_screen_permissions, role_view


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
        return bool(user and has_screen_permission(db, user, 'role_administration', action))


def register() -> None:
    @ui.page(screen_url('role_administration'))
    def roles_page() -> None:
        layout('Manage Roles', 'Select a role, then manage its landing page and screen access.')
        if not _allowed():
            ui.label('You do not have permission to view Manage Roles.').classes('text-negative')
            return
        can_write = _allowed('write')
        selected_role: dict[str, int | None] = {'id': None}

        def active_roles() -> list[Role]:
            with SessionLocal() as db:
                return list(db.scalars(select(Role).where(Role.is_active.is_(True)).order_by(Role.name)).all())

        with ui.row().classes('w-full gap-6 items-start'):
            with ui.card().classes('w-72 shrink-0 p-0 overflow-hidden'):
                with ui.row().classes('w-full items-center justify-between px-5 py-4 border-b border-slate-200'):
                    ui.label('Roles').classes('text-xl font-bold')

                    def open_create_dialog() -> None:
                        with ui.dialog() as dialog, ui.card().classes('w-full max-w-md p-6'):
                            ui.label('Add role').classes('text-xl font-bold')
                            name = ui.input('Role name').classes('w-full')
                            description = ui.input('Description').classes('w-full')

                            def create() -> None:
                                try:
                                    role_name = (name.value or '').strip()
                                    if not 2 <= len(role_name) <= 64:
                                        raise ValueError('Role name must contain 2 to 64 characters.')
                                    if len((description.value or '').strip()) > 255:
                                        raise ValueError('Role description must not exceed 255 characters.')
                                    with SessionLocal() as db:
                                        if db.scalar(select(Role.id).where(func.lower(Role.name) == role_name.casefold())):
                                            raise ValueError('A role with this name already exists.')
                                        role = Role(name=role_name, description=(description.value or '').strip())
                                        db.add(role)
                                        db.flush()
                                        create_disabled_screen_mappings(db, role)
                                        log_action(db, 'role_created', user_id=_current_user_id(),
                                                   entity_type='role', entity_id=str(role.id), detail=role.name)
                                        db.commit()
                                        selected_role['id'] = role.id
                                    ui.notify('Role created. Configure its screen access before assigning it to a user.', type='positive')
                                    dialog.close()
                                    role_list.refresh()
                                    role_editor.refresh()
                                except Exception as exc:
                                    ui.notify(str(exc), type='negative')

                            with ui.row().classes('w-full justify-end gap-2 mt-4'):
                                ui.button('Cancel', on_click=dialog.close).props('flat')
                                ui.button('Add role', on_click=create).props('color=primary')
                        dialog.open()

                    if can_write:
                        ui.button(icon='add', on_click=open_create_dialog).props('flat round aria-label="Add role"')

                @ui.refreshable
                def role_list() -> None:
                    roles = active_roles()
                    if selected_role['id'] not in {role.id for role in roles}:
                        selected_role['id'] = roles[0].id if roles else None
                    with ui.column().classes('w-full gap-0 p-2'):
                        for role in roles:
                            active = role.id == selected_role['id']

                            def choose(role_id=role.id) -> None:
                                selected_role['id'] = role_id
                                role_list.refresh()
                                role_editor.refresh()

                            ui.button(role.name, on_click=choose).props('flat no-caps').classes(
                                'w-full justify-start px-3 py-2 text-left font-medium '
                                + ('bg-blue-50 text-blue-800' if active else 'text-slate-700 hover:bg-slate-50')
                            )
                    if not roles:
                        ui.label('No active roles.').classes('px-5 py-4 text-slate-500')

                role_list()

            with ui.column().classes('flex-1 min-w-0 gap-4'):
                @ui.refreshable
                def role_editor() -> None:
                    role_id = selected_role['id']
                    if role_id is None:
                        ui.label('Select a role to manage its access.').classes('text-slate-600')
                        return
                    with SessionLocal() as db:
                        role = db.get(Role, role_id)
                        if not role or not role.is_active:
                            ui.notify('This role is no longer available.', type='warning')
                            role_list.refresh()
                            return
                        data = role_view(db, role)

                    with ui.card().classes('w-full p-5'):
                        ui.label('Role details').classes('text-xl font-bold mb-3')
                        name = ui.input('Role name', value=data['name']).classes('w-full max-w-xl')
                        description = ui.input('Description', value=data['description']).classes('w-full max-w-xl')
                        if not can_write:
                            name.disable()
                            description.disable()

                    with ui.card().classes('w-full p-5'):
                        ui.label('Login experience').classes('text-xl font-bold')
                        ui.label('Choose where users with this role open after signing in.').classes('text-sm text-slate-600 mb-2')
                        initial_landing = {'': 'First permitted page'} | {
                            item['screen_id']: item['menu_name'] for item in data['screens'] if item['can_read']
                        }
                        landing = ui.select(initial_landing, value=data['default_screen_id'] or '',
                                            label='Default landing page').classes('w-full max-w-xl')
                        if not can_write:
                            landing.disable()

                    with ui.card().classes('w-full p-5'):
                        ui.label('Screen permissions').classes('text-xl font-bold')
                        ui.label('Select what this role can open and manage. Manage automatically includes View.').classes('text-sm text-slate-600 mb-4')
                        with ui.row().classes('w-full items-center border-b border-slate-200 pb-2 text-sm font-bold text-slate-600'):
                            ui.label('Page').classes('flex-1')
                            ui.label('View').classes('w-24 text-center')
                            ui.label('Manage').classes('w-24 text-center')
                        controls: dict[str, tuple] = {}
                        for screen in data['screens']:
                            with ui.row().classes('w-full items-center border-b border-slate-100 py-2'):
                                ui.label(screen['menu_name']).classes('flex-1 font-medium')
                                read = ui.checkbox(value=screen['can_read']).classes('w-24 justify-center')
                                write = ui.checkbox(value=screen['can_write']).classes('w-24 justify-center')
                                if not can_write:
                                    read.disable()
                                    write.disable()

                                def read_changed(_, read_control=read, write_control=write) -> None:
                                    if not read_control.value and write_control.value:
                                        write_control.value = False
                                        write_control.update()

                                def write_changed(_, read_control=read, write_control=write) -> None:
                                    if write_control.value and not read_control.value:
                                        read_control.value = True
                                        read_control.update()

                                if can_write:
                                    read.on_value_change(read_changed)
                                    write.on_value_change(write_changed)
                                controls[screen['screen_id']] = (read, write)

                        if can_write:
                            def save() -> None:
                                try:
                                    role_name = (name.value or '').strip()
                                    if not 2 <= len(role_name) <= 64:
                                        raise ValueError('Role name must contain 2 to 64 characters.')
                                    if len((description.value or '').strip()) > 255:
                                        raise ValueError('Role description must not exceed 255 characters.')
                                    permissions = [
                                        {'screen_id': screen_id, 'can_read': bool(read.value), 'can_write': bool(write.value)}
                                        for screen_id, (read, write) in controls.items()
                                    ]
                                    readable = {'': 'First permitted page'} | {
                                        screen['screen_id']: screen['menu_name']
                                        for screen in data['screens'] if bool(controls[screen['screen_id']][0].value)
                                    }
                                    if landing.value not in readable:
                                        raise ValueError('Select a default landing page that has View access.')
                                    with SessionLocal() as db:
                                        role = db.get(Role, role_id)
                                        if not role:
                                            raise ValueError('Role no longer exists.')
                                        duplicate = db.scalar(select(Role.id).where(
                                            func.lower(Role.name) == role_name.casefold(), Role.id != role.id,
                                        ))
                                        if duplicate:
                                            raise ValueError('A role with this name already exists.')
                                        replace_screen_permissions(db, role, permissions, landing.value or None)
                                        role.name = role_name
                                        role.description = (description.value or '').strip()
                                        log_action(db, 'role_updated', user_id=_current_user_id(),
                                                   entity_type='role', entity_id=str(role.id), detail=role.name)
                                        db.commit()
                                    ui.notify('Role saved.', type='positive')
                                    role_list.refresh()
                                    role_editor.refresh()
                                except Exception as exc:
                                    ui.notify(str(exc), type='negative')

                            ui.button('Save role', icon='save', on_click=save).props('color=primary').classes('mt-4')

                role_editor()
