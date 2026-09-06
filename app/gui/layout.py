"""Shared responsive left navigation for authenticated NiceGUI pages."""
from dataclasses import dataclass

from nicegui import app, ui

from app.db.database import SessionLocal
from app.core.screen_registry import visible_screens
from app.services.auth.service import get_session_user


EXPANDED_WIDTH = 300
COLLAPSED_WIDTH = 72


@dataclass(frozen=True)
class NavigationItem:
    label: str
    route: str
    icon: str
    permissions: tuple[str, ...] = ()
    badge: str | None = None


SIDEBAR_CSS = '''
<style>
.audit-sidebar, .audit-sidebar .q-drawer__content {background:#ffffff; border-right:1px solid #dfe5ec; box-shadow:2px 0 10px rgba(15,23,42,.04); transition:width 220ms ease, transform 220ms ease; overflow:hidden}
.audit-sidebar .sidebar-toggle {display:inline-flex!important; min-width:44px!important; min-height:44px!important; width:44px!important; height:44px!important; color:#13294b!important; background:#f4f7fb!important; border:1px solid #d6e0eb!important; border-radius:8px!important; flex:0 0 44px!important}
.audit-sidebar .sidebar-toggle:hover {background:#e6f1fd!important; color:#155fa8!important}
.audit-sidebar .sidebar-toggle:focus-visible {outline:3px solid #2f80d1!important; outline-offset:2px!important}
.audit-sidebar .sidebar-toggle-icon {display:inline-flex!important; color:currentColor!important; font-size:25px!important; transition:transform 220ms ease}
.audit-sidebar.sidebar-collapsed .sidebar-toggle-icon {transform:rotate(180deg)}
.audit-sidebar .sidebar-label {white-space:nowrap; overflow:hidden; min-width:0; visibility:visible; opacity:1; max-width:240px; transition:opacity 140ms ease, max-width 220ms ease, margin 220ms ease}
.audit-sidebar .nav-label {color:#13294b!important; font-weight:600}
.audit-sidebar .nav-entry {min-height:44px!important; color:#13294b!important; transition:background-color 180ms ease, color 180ms ease, padding 240ms ease}
.audit-sidebar .nav-entry .q-btn__content {width:100%; justify-content:flex-start}
.audit-sidebar .nav-entry .nav-icon {display:inline-flex!important; flex:0 0 auto!important; color:#647b98!important; opacity:1!important; visibility:visible!important; font-size:25px!important}
.audit-sidebar .nav-entry:focus-visible, .audit-sidebar .account-menu-button:focus-visible {outline:3px solid #2f80d1!important; outline-offset:2px!important}
.audit-sidebar.sidebar-collapsed .sidebar-label {visibility:hidden!important; opacity:0; max-width:0; margin-left:0!important; margin-right:0!important; pointer-events:none!important}
.audit-sidebar .nav-scroll {box-sizing:border-box!important; width:100%!important; min-width:0!important; overflow-y:auto!important; overflow-x:hidden!important; align-items:stretch; scrollbar-gutter:stable}
.audit-sidebar .nav-list {width:100%; min-width:0; gap:4px; align-items:stretch}
.audit-sidebar.sidebar-collapsed .sidebar-header {justify-content:center!important; padding-left:0!important; padding-right:0!important; gap:0!important}
.audit-sidebar.sidebar-collapsed .nav-scroll {padding-left:8px!important; padding-right:8px!important; overscroll-behavior-x:none!important}
.audit-sidebar.sidebar-collapsed .nav-scroll {scrollbar-width:none!important; -ms-overflow-style:none!important; scrollbar-gutter:auto}
.audit-sidebar.sidebar-collapsed .nav-scroll::-webkit-scrollbar {width:0!important; height:0!important; display:none!important}
.audit-sidebar.sidebar-collapsed .nav-list {width:100%!important; min-width:0!important; max-width:none!important; align-self:stretch!important; align-items:stretch!important; overflow:visible!important}
.audit-sidebar.sidebar-collapsed .nav-entry {display:flex!important; width:100%!important; min-width:0!important; max-width:none!important; height:44px!important; min-height:44px!important; overflow:visible!important; padding:0!important}
.audit-sidebar.sidebar-collapsed .nav-entry .q-btn__content {display:flex!important; width:100%!important; min-width:0!important; height:44px!important; align-items:center!important; justify-content:center!important; overflow:visible!important}
.audit-sidebar.sidebar-collapsed .nav-entry .nav-icon {position:static!important; display:inline-flex!important; flex:0 0 28px!important; width:28px!important; min-width:28px!important; max-width:28px!important; height:28px!important; align-items:center!important; justify-content:center!important; transform:none!important; color:#647b98!important; font-size:25px!important; line-height:28px!important; opacity:1!important; visibility:visible!important; overflow:visible!important}
.audit-sidebar.sidebar-collapsed .account-details {display:none}
.audit-sidebar.sidebar-collapsed .account-actions {display:none}
.audit-sidebar.sidebar-collapsed .account-row {justify-content:center!important; padding:8px 0!important; gap:0!important}
.audit-sidebar.sidebar-collapsed .account-row .q-space {display:none!important}
.audit-sidebar.sidebar-collapsed .account-avatar {width:40px!important; height:40px!important; min-width:40px!important; font-size:20px!important}
.audit-sidebar .account-avatar-button {min-width:44px!important; min-height:44px!important; width:44px!important; height:44px!important; padding:2px!important}
.audit-sidebar .nav-entry:hover {background:#f1f5f9}
.audit-sidebar .nav-entry.nav-active {background:#eaf4ff; color:#13294b!important}
.audit-sidebar .nav-entry.nav-active .q-icon {color:#357ac3!important}
.mobile-sidebar-toggle {display:none!important}
@media (max-width:1023px) {
  .global-strip {height:56px!important; min-height:56px!important; padding:6px 10px!important}
  .mobile-sidebar-toggle {display:inline-flex!important; min-width:44px!important; min-height:44px!important; color:#ffffff!important; border:1px solid rgba(255,255,255,.45)!important}
  .mobile-sidebar-toggle:focus-visible {outline:3px solid #93c5fd!important; outline-offset:2px!important}
}
@media (prefers-reduced-motion: reduce) {.audit-sidebar, .audit-sidebar *, .audit-sidebar .q-drawer__content {transition:none!important; animation:none!important}}
</style>
'''


def _identity() -> dict:
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        if not user:
            return {'name': 'Session expired', 'email': '', 'roles': [], 'permissions': set(), 'screens': []}
        return {
            'name': user.display_name or user.email,
            'email': user.email,
            'roles': [role.name for role in user.roles],
            'permissions': {permission.code for role in user.roles for permission in role.permissions},
            'screens': [NavigationItem(screen.menu_name, screen.url, screen.icon) for screen in visible_screens(db, user)],
        }


def _visible(item: NavigationItem, permissions: set[str]) -> bool:
    return not item.permissions or '*' in permissions or any(code in permissions for code in item.permissions)


class LeftSidebar:
    """One reusable, fixed sidebar; native drawer mode is used below 1024px."""

    def __init__(self, active_route: str) -> None:
        self.active_route = active_route
        self.identity = _identity()
        self.has_saved_preference = 'sidebar_expanded' in app.storage.user
        saved_preference = app.storage.user.get('sidebar_expanded', True)
        self.expanded = (
            saved_preference
            if isinstance(saved_preference, bool)
            else str(saved_preference).strip().lower() == 'true'
        )
        self.drawer = None
        self.toggle_button = None

    async def _reset_nav_horizontal_scroll(self) -> None:
        await ui.run_javascript(
            "requestAnimationFrame(() => { const nav = document.querySelector('.audit-sidebar .nav-scroll'); if (nav) nav.scrollLeft = 0; })"
        )

    async def _set_expanded(self, expanded: bool) -> None:
        self.expanded = expanded
        app.storage.user['sidebar_expanded'] = expanded
        self.drawer.props(f'width={EXPANDED_WIDTH if expanded else COLLAPSED_WIDTH}')
        self.drawer.classes(remove='sidebar-collapsed' if expanded else None,
                            add='sidebar-collapsed' if not expanded else None)
        label = 'Collapse sidebar' if expanded else 'Expand sidebar'
        self.toggle_button.props(f'aria-label="{label}" title="{label}"')
        # A horizontally shifted scroll container clips Material glyphs even
        # when overflow-x is hidden. Reset it after every width/class update.
        await self._reset_nav_horizontal_scroll()
        await ui.run_javascript(f"localStorage.setItem('cmmi_sidebar_expanded', '{str(expanded).lower()}')")

    async def toggle(self) -> None:
        # Desktop toggles compact/expanded mode; mobile uses the same single
        # hamburger button to open/close the native overlay drawer.
        if await ui.run_javascript('window.innerWidth < 1024'):
            self.drawer.toggle()
            return
        # Use the rendered class instead of the cached value. A mobile drawer is
        # temporarily expanded without changing the saved desktop preference,
        # and the viewport can be resized before the next page navigation.
        visually_collapsed = await ui.run_javascript(
            "document.querySelector('.audit-sidebar')?.classList.contains('sidebar-collapsed') ?? false"
        )
        await self._set_expanded(bool(visually_collapsed))

    async def open_mobile(self) -> None:
        """Open a usable full-width drawer without changing the desktop preference."""
        self.drawer.props(f'width={EXPANDED_WIDTH}')
        self.drawer.classes(remove='sidebar-collapsed')
        self.toggle_button.props('aria-label="Close sidebar" title="Close sidebar"')
        await self._reset_nav_horizontal_scroll()
        self.drawer.show()

    async def _restore_local_preference(self) -> None:
        """Use localStorage as a fallback; user storage avoids normal reload flashing."""
        if self.has_saved_preference:
            return
        value = await ui.run_javascript("localStorage.getItem('cmmi_sidebar_expanded')")
        if value in {'true', 'false'}:
            await self._set_expanded(value == 'true')

    async def _navigate(self, route: str) -> None:
        if await ui.run_javascript('window.innerWidth < 1024'):
            self.drawer.hide()
        ui.navigate.to(route)

    def _profile_dialog(self) -> None:
        with ui.dialog() as dialog, ui.card().classes('w-96'):
            ui.label('Profile').classes('text-xl font-bold')
            ui.label(self.identity['name']).classes('font-medium')
            ui.label(self.identity['email']).classes('text-slate-600')
            ui.label(f"Role: {', '.join(self.identity['roles']) or 'No assigned role'}").classes('mt-2')
            ui.button('Close', on_click=dialog.close).props('flat')
        dialog.open()

    def _logout(self) -> None:
        app.storage.user.pop('selected_audit_session_id', None)
        ui.run_javascript("fetch('/api/v1/auth/logout',{method:'POST',credentials:'same-origin'}).then(()=>location='/login')")

    def _render_account_menu(self) -> None:
        with ui.menu():
            ui.menu_item('Profile', self._profile_dialog)
            ui.menu_item('Logout', self._logout)

    def render(self):
        width = EXPANDED_WIDTH if self.expanded else COLLAPSED_WIDTH
        with ui.left_drawer(value=None, fixed=True, bordered=True).props(
            f'width={width} breakpoint=1024 role="complementary" aria-label="Application sidebar"'
        ).classes('audit-sidebar') as drawer:
            self.drawer = drawer
            if not self.expanded:
                drawer.classes(add='sidebar-collapsed')
            with ui.column().classes('h-full w-full no-wrap'):
                with ui.row().classes('sidebar-header w-full h-16 min-h-16 px-4 items-center no-wrap border-b border-slate-100'):
                    initial_toggle_label = 'Collapse sidebar' if self.expanded else 'Expand sidebar'
                    with ui.button(on_click=self.toggle).props(
                        f'flat aria-label="{initial_toggle_label}" title="{initial_toggle_label}"'
                    ).classes('sidebar-toggle') as toggle_button:
                        ui.icon('menu_open').classes('sidebar-toggle-icon')
                    self.toggle_button = toggle_button
                    toggle_button.tooltip('Collapse or expand sidebar')
                    ui.label('CMMI Audit Platform').classes('sidebar-label text-base font-bold text-slate-900 ml-3')
                with ui.element('nav').props('aria-label="Primary navigation"').classes('nav-scroll flex-grow w-full px-3 py-4'):
                    with ui.column().classes('nav-list no-wrap'):
                        for item in self.identity['screens']:
                            active = item.route == self.active_route
                            async def navigate_to(target=item.route):
                                await self._navigate(target)
                            with ui.button(on_click=navigate_to).props(f'flat align=left aria-current={"page" if active else "false"}').classes('nav-entry w-full no-caps rounded-lg text-slate-700' + (' nav-active' if active else '')) as button:
                                ui.icon(item.icon).classes('nav-icon')
                                ui.label(item.label).classes('sidebar-label nav-label ml-2')
                                if item.badge:
                                    ui.badge(item.badge).classes('sidebar-label ml-auto')
                            button.tooltip(item.label)
                ui.separator()
                with ui.row().classes('account-row w-full p-3 items-center no-wrap'):
                    with ui.button().props('flat round aria-label="Open account menu" title="Open account menu"').classes('account-avatar-button account-menu-button flex-none'):
                        with ui.avatar(color='blue-1', text_color='blue-8').classes('account-avatar flex-none'):
                            ui.icon('person')
                        self._render_account_menu()
                    with ui.column().classes('account-details sidebar-label ml-2 gap-0'):
                        ui.label(self.identity['name']).classes('font-bold text-sm')
                        ui.label(self.identity['roles'][0] if self.identity['roles'] else 'No role').classes('text-xs text-slate-500 uppercase')
                    ui.space()
                    with ui.button(icon='more_vert').props('flat round aria-label="Open account menu" title="Open account menu"').classes('account-actions account-menu-button flex-none'):
                        self._render_account_menu()
            ui.timer(0.01, self._restore_local_preference, once=True)
            if not self.expanded:
                ui.timer(0.05, self._reset_nav_horizontal_scroll, once=True)
        return drawer


def layout(title: str, subtitle: str = '') -> None:
    """Render the shared left sidebar and responsive page-content container."""
    ui.add_head_html(SIDEBAR_CSS)
    request = ui.context.client.request
    active_route = request.url.path if request else '/'
    sidebar = LeftSidebar(active_route)
    sidebar.render()
    # Keep the global strip separate from the application sidebar. It carries
    # no brand or navigation controls; those belong in the white sidebar row.
    with ui.header().classes('global-strip bg-[#3f3f3f] text-white h-8 min-h-8'):
        mobile_toggle = ui.button(icon='menu', on_click=sidebar.open_mobile).props(
            'flat round aria-label="Open navigation sidebar" title="Open navigation sidebar"'
        ).classes('mobile-sidebar-toggle')
        mobile_toggle.tooltip('Open navigation sidebar')
    # q-drawer manages the matching page-container margin and transitions.
    with ui.column().classes('w-full max-w-7xl mx-auto p-6 gap-2'):
        ui.label(title).classes('text-3xl font-bold')
        if subtitle:
            ui.label(subtitle).classes('text-slate-600')
