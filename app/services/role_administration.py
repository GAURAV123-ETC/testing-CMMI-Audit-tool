"""Transactional role and screen-access administration operations."""
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.screen_registry import ADMINISTRATION_SCREEN_IDS
from app.db.models import MapRoleScreen, MdScreen, Role, User


def active_screens(db: Session) -> list[MdScreen]:
    return list(db.scalars(
        select(MdScreen).where(MdScreen.is_active.is_(True)).order_by(MdScreen.display_order, MdScreen.menu_name)
    ).all())


def role_view(db: Session, role: Role) -> dict:
    mappings = {
        mapping.screen_id: mapping
        for mapping in db.scalars(select(MapRoleScreen).where(MapRoleScreen.role_id == role.id)).all()
    }
    return {
        'id': role.id,
        'name': role.name,
        'description': role.description or '',
        'is_active': role.is_active,
        'default_screen_id': role.default_screen_id,
        'screens': [
            {
                'screen_id': screen.screen_id,
                'menu_name': screen.menu_name,
                'url': screen.url,
                'display_order': screen.display_order,
                'can_read': bool(mappings.get(screen.screen_id) and mappings[screen.screen_id].can_read),
                'can_write': bool(mappings.get(screen.screen_id) and mappings[screen.screen_id].can_write),
            }
            for screen in active_screens(db)
        ],
    }


def _ensure_no_administration_lockout(db: Session, role_id: int, requested: dict[str, tuple[bool, bool]]) -> None:
    """Validate the final bulk state instead of rejecting a safe reorder."""
    for screen_id in ADMINISTRATION_SCREEN_IDS:
        current = db.get(MapRoleScreen, (role_id, screen_id))
        requested_write = requested.get(screen_id, (False, False))[1]
        if not current or not current.can_write or requested_write:
            continue
        remaining = db.scalars(select(User).where(User.is_active.is_(True))).all()
        has_other_manager = False
        for account in remaining:
            for member in account.roles:
                if member.id == role_id:
                    continue
                mapping = db.get(MapRoleScreen, (member.id, screen_id))
                if mapping and mapping.can_write:
                    has_other_manager = True
                    break
            if has_other_manager:
                break
        if not has_other_manager:
            raise ValueError(
                f'Grant {screen_id.replace("_", " ").title()} manage access to another active user before removing this access'
            )


def replace_screen_permissions(
    db: Session, role: Role, permissions: Iterable[dict[str, object]], default_screen_id: str | None,
) -> None:
    """Replace active screen grants atomically after validating the full matrix."""
    known = {screen.screen_id: screen for screen in active_screens(db)}
    requested: dict[str, tuple[bool, bool]] = {}
    for item in permissions:
        screen_id = str(item.get('screen_id') or '')
        if screen_id in requested:
            raise ValueError('A screen can appear only once in the permission matrix.')
        if screen_id not in known:
            raise ValueError('Unknown or inactive screen in the permission matrix.')
        can_read = bool(item.get('can_read'))
        can_write = bool(item.get('can_write'))
        if can_write and not can_read:
            raise ValueError('Write permission requires Read permission.')
        requested[screen_id] = (can_read, can_write)
    if set(requested) != set(known):
        raise ValueError('The permission matrix must include every active screen.')
    if default_screen_id:
        landing = known.get(default_screen_id)
        if landing is None or not requested[default_screen_id][0]:
            raise ValueError('The default landing page must be an active screen with Read access.')
    _ensure_no_administration_lockout(db, role.id, requested)
    for screen_id, (can_read, can_write) in requested.items():
        mapping = db.get(MapRoleScreen, (role.id, screen_id))
        if mapping is None:
            mapping = MapRoleScreen(role_id=role.id, screen_id=screen_id)
            db.add(mapping)
        mapping.can_read = can_read
        mapping.can_write = can_write
    role.default_screen_id = default_screen_id or None
    db.flush()
