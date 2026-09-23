"""Single source of truth for menu definitions and screen-level RBAC.

The registry is code-owned so deployment does not depend on an administrator
remembering to create a menu row.  Its database projection remains editable
through controlled configuration, while stable ``screen_id`` values protect
existing role permissions from display-name changes.
"""
from dataclasses import dataclass
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import MapRoleScreen, MdScreen, Role, User


@dataclass(frozen=True)
class ScreenDefinition:
    screen_id: str
    menu_name: str
    url: str
    icon: str
    display_order: int
    read_permissions: tuple[str, ...] = ()
    write_permissions: tuple[str, ...] = ()
    is_active: bool = True
    is_default_landing: bool = False


# Do not duplicate these values in pages, API dependencies, or the sidebar.
SCREEN_REGISTRY: tuple[ScreenDefinition, ...] = (
    ScreenDefinition('dashboard', 'Dashboard', '/', 'dashboard', 10, is_default_landing=True),
    ScreenDefinition('rule_catalog', 'Rules Catalogue', '/rule-catalog', 'admin_panel_settings', 40, ('*',), ('*',)),
    ScreenDefinition('add_project', 'Add Project', '/add-project', 'add_business', 50, ('customers:read', 'customers:write', 'projects:read', 'projects:write', 'audits:read', 'audits:write'), ('customers:write', 'projects:write', 'audits:write')),
    ScreenDefinition('evidence_scan', 'Evidence Scan', '/evidence-scan', 'manage_search', 60, ('evidence:read', 'evidence:write', 'audits:read', 'audits:write'), ('evidence:write', 'audits:write')),
    ScreenDefinition('reports', 'AFR Reports', '/reports', 'summarize', 120, ('reports:read', 'reports:write'), ('reports:write',)),
    ScreenDefinition('user_administration', 'Manage Users', '/users', 'group', 150, ('*',), ('*',)),
    ScreenDefinition('role_administration', 'Manage Roles', '/roles', 'admin_panel_settings', 160, ('*',), ('*',)),
    # Preserves legacy bookmarks without rendering a duplicate navigation item.
    ScreenDefinition('audit_workspace', 'Audit Workspace', '/audit-workspace', 'workspaces', 999, is_active=False),
)

# These duplicate repository-ingestion screens and the former global Findings
# screen were retired in favour of the project-scoped Evidence Scan workflow.
# Existing installations may still have rows and role mappings from earlier
# versions, so disable those rows at every startup instead of relying on a
# manual database clean-up.
RETIRED_SCREEN_IDS = ('repository_scan', 'integrations', 'rule_library', 'pa_validation', 'package_checker', 'gap_analysis', 'ai_guide', 'correlation_map', 'findings')


def registry_by_id() -> dict[str, ScreenDefinition]:
    return {screen.screen_id: screen for screen in SCREEN_REGISTRY}


def screen_for_url(url: str) -> ScreenDefinition | None:
    return next((screen for screen in SCREEN_REGISTRY if screen.url == url), None)


def screen_url(screen_id: str) -> str:
    """Return the registered URL for a page declaration; fail fast on typos."""
    screen = registry_by_id().get(screen_id)
    if not screen:
        raise ValueError(f'Unknown registered screen: {screen_id}')
    return screen.url


def _legacy_codes(role: Role) -> set[str]:
    return {permission.code for permission in role.permissions}


def _is_super_admin(role: Role) -> bool:
    """Return whether the role has the explicit global-access permission.

    Access is permission and mapping based; role names are not authorization
    logic. This keeps custom roles and renamed roles scalable.
    """
    return '*' in _legacy_codes(role)


def _legacy_grant(role: Role, screen: ScreenDefinition) -> tuple[bool, bool]:
    if _is_super_admin(role):
        return True, True
    codes = _legacy_codes(role)
    # The consolidated Add Project form creates all three records in one
    # transaction, so its legacy migration requires every former write grant.
    # Other screens retain the previous "any applicable write grant" behavior.
    write = (
        set(screen.write_permissions).issubset(codes)
        if screen.screen_id == 'add_project'
        else bool(set(screen.write_permissions) & codes)
    )
    # Dashboard is the non-sensitive landing page for all authenticated users.
    read = screen.screen_id == 'dashboard' or write or bool(set(screen.read_permissions) & codes)
    return read, write


def sync_screen_registry(db: Session, definitions: tuple[ScreenDefinition, ...] = SCREEN_REGISTRY) -> None:
    """Upsert metadata and add only missing access mappings.

    This is idempotent and never overwrites an existing administrator grant.
    """
    active_defaults = [screen for screen in definitions if screen.is_active and screen.is_default_landing]
    if len(active_defaults) != 1:
        raise ValueError('Exactly one active default landing screen must be registered')
    ids = [screen.screen_id for screen in definitions]
    if len(ids) != len(set(ids)) or len({screen.url for screen in definitions}) != len(definitions):
        raise ValueError('Screen ids and URLs must be unique')
    for definition in definitions:
        row = db.get(MdScreen, definition.screen_id)
        if not row:
            row = MdScreen(screen_id=definition.screen_id)
            db.add(row)
        row.menu_name = definition.menu_name
        row.url = definition.url
        row.icon = definition.icon
        row.is_active = definition.is_active
        row.display_order = definition.display_order
        row.is_default_landing = definition.is_default_landing
    for screen_id in RETIRED_SCREEN_IDS:
        retired = db.get(MdScreen, screen_id)
        if retired:
            retired.is_active = False
            retired.is_default_landing = False
    # A role must never retain a retired screen as its landing page. Leaving
    # the historic mapping in place preserves auditability; clearing only the
    # default lets normal landing-page fallback choose an allowed active page.
    for role in db.scalars(select(Role).where(Role.default_screen_id.in_(RETIRED_SCREEN_IDS))).all():
        role.default_screen_id = None
    db.flush()
    roles = db.scalars(select(Role)).all()
    active_screens = [screen for screen in definitions if screen.is_active]
    for role in roles:
        for screen in active_screens:
            mapping = db.get(MapRoleScreen, (role.id, screen.screen_id))
            if not mapping:
                read, write = _legacy_grant(role, screen)
                db.add(MapRoleScreen(role_id=role.id, screen_id=screen.screen_id, can_read=read, can_write=write))
            elif mapping.can_write and not mapping.can_read:
                mapping.can_read = True


def create_disabled_screen_mappings(db: Session, role: Role) -> None:
    """Backfill a newly created role with explicit disabled rows for every screen."""
    for screen in db.scalars(select(MdScreen).where(MdScreen.is_active.is_(True))).all():
        if not db.get(MapRoleScreen, (role.id, screen.screen_id)):
            db.add(MapRoleScreen(role_id=role.id, screen_id=screen.screen_id, can_read=False, can_write=False))


ADMINISTRATION_SCREEN_IDS = ('user_administration', 'role_administration')


def _ensure_administration_access_remains(db: Session, role_id: int, screen_id: str, can_write: bool) -> None:
    """Avoid orphaning a deployment from its final active administration user."""
    if screen_id not in ADMINISTRATION_SCREEN_IDS or can_write:
        return
    remaining_manager = db.scalar(
        select(User.id)
        .join(User.roles)
        .join(MapRoleScreen, MapRoleScreen.role_id == Role.id)
        .where(
            User.is_active.is_(True),
            Role.id != role_id,
            MapRoleScreen.screen_id == screen_id,
            MapRoleScreen.can_read.is_(True),
            MapRoleScreen.can_write.is_(True),
        )
        .limit(1)
    )
    if remaining_manager is None:
        raise ValueError(
            f'Grant {screen_id.replace("_", " ").title()} manage access to another active user before removing this access'
        )


def set_role_screen_permission(db: Session, role_id: int, screen_id: str, can_read: bool, can_write: bool) -> MapRoleScreen:
    if can_write and not can_read:
        raise ValueError('Write permission requires Read permission')
    screen = db.get(MdScreen, screen_id)
    if not screen:
        raise ValueError('Unknown screen')
    role = db.get(Role, role_id)
    if not role:
        raise ValueError('Unknown role')
    if not screen.is_active:
        raise ValueError('Cannot grant permissions to an inactive screen')
    if role.default_screen_id == screen_id and not can_read:
        raise ValueError('Clear or change the role default landing page before removing its Read access')
    _ensure_administration_access_remains(db, role_id, screen_id, can_write)
    mapping = db.get(MapRoleScreen, (role_id, screen_id))
    if not mapping:
        mapping = MapRoleScreen(role_id=role_id, screen_id=screen_id)
        db.add(mapping)
    mapping.can_read = can_read
    mapping.can_write = can_write
    return mapping


def has_screen_permission(db: Session, user: User, screen_id: str, action: str = 'read') -> bool:
    if action not in {'read', 'write'}:
        raise ValueError('action must be read or write')
    screen = db.get(MdScreen, screen_id)
    if not screen or not screen.is_active:
        return False
    for role in user.roles:
        mapping = db.get(MapRoleScreen, (role.id, screen_id))
        if not mapping or not mapping.can_read:
            continue
        if action == 'read' or mapping.can_write:
            return True
    return False


def visible_screens(db: Session, user: User) -> list[MdScreen]:
    screens = db.scalars(select(MdScreen).where(MdScreen.is_active.is_(True)).order_by(MdScreen.display_order, MdScreen.menu_name)).all()
    return [screen for screen in screens if has_screen_permission(db, user, screen.screen_id)]


def landing_url_for_user(db: Session, user: User) -> str:
    # A role may nominate an allowed landing screen. Users currently receive
    # one primary role through Manage Users; sorting also makes the fallback
    # deterministic for legacy multi-role accounts.
    for role in sorted(user.roles, key=lambda item: (item.name.casefold(), item.id)):
        if role.default_screen_id and has_screen_permission(db, user, role.default_screen_id):
            screen = db.get(MdScreen, role.default_screen_id)
            if screen and screen.is_active:
                return screen.url
    screens = visible_screens(db, user)
    default = next((screen for screen in screens if screen.is_default_landing), None)
    return default.url if default else (screens[0].url if screens else '/login')
