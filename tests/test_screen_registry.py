import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.screen_registry import (
    RETIRED_SCREEN_IDS,
    SCREEN_REGISTRY,
    ScreenDefinition,
    create_disabled_screen_mappings,
    has_screen_permission,
    landing_url_for_user,
    set_role_screen_permission,
    sync_screen_registry,
)
from app.db.database import Base
from app.db.models import MapRoleScreen, MdScreen, Permission, Role, User


def db_session():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_menu_rename_keeps_stable_screen_mapping():
    db = db_session()
    role = Role(name='Custom')
    db.add(role)
    db.flush()
    first = (ScreenDefinition('evidence_scan', 'Evidence Scan', '/evidence-scan', 'search', 10, is_default_landing=True),)
    sync_screen_registry(db, first)
    set_role_screen_permission(db, role.id, 'evidence_scan', True, False)
    renamed = (ScreenDefinition('evidence_scan', 'Evidence Review', '/evidence-scan', 'search', 20, is_default_landing=True),)
    sync_screen_registry(db, renamed)
    assert db.get(MdScreen, 'evidence_scan').menu_name == 'Evidence Review'
    assert db.get(MapRoleScreen, (role.id, 'evidence_scan')).can_read is True
    assert db.get(MapRoleScreen, (role.id, 'evidence_scan')).can_write is False


def test_new_screen_backfill_and_super_admin_access():
    db = db_session()
    star = Permission(code='*')
    admin = Role(name='Super Admin', permissions=[star])
    reader = Role(name='Reader')
    db.add_all([admin, reader])
    db.flush()
    screens = (ScreenDefinition('dashboard', 'Dashboard', '/', 'dashboard', 10, is_default_landing=True), ScreenDefinition('new_screen', 'New Screen', '/new', 'new', 20))
    sync_screen_registry(db, screens)
    assert db.get(MapRoleScreen, (admin.id, 'new_screen')).can_write is True
    assert db.get(MapRoleScreen, (reader.id, 'new_screen')).can_read is False
    assert db.get(MapRoleScreen, (reader.id, 'new_screen')).can_write is False


def test_new_roles_receive_explicit_disabled_permissions():
    db = db_session()
    sync_screen_registry(db)
    role = Role(name='New role')
    db.add(role)
    db.flush()
    create_disabled_screen_mappings(db, role)
    mappings = db.query(MapRoleScreen).filter_by(role_id=role.id).all()
    assert mappings
    assert all(not mapping.can_read and not mapping.can_write for mapping in mappings)


def test_read_only_and_write_without_read_rejection():
    db = db_session()
    role = Role(name='Reader')
    user = User(email='reader@example.test', display_name='Reader', password_hash='x', roles=[role])
    db.add(user)
    db.flush()
    screens = (ScreenDefinition('dashboard', 'Dashboard', '/', 'dashboard', 10, is_default_landing=True), ScreenDefinition('findings', 'Findings', '/findings', 'fact_check', 20))
    sync_screen_registry(db, screens)
    set_role_screen_permission(db, role.id, 'findings', True, False)
    assert has_screen_permission(db, user, 'findings', 'read') is True
    assert has_screen_permission(db, user, 'findings', 'write') is False
    with pytest.raises(ValueError, match='requires Read'):
        set_role_screen_permission(db, role.id, 'findings', False, True)


def test_inactive_screens_cannot_receive_role_permissions():
    db = db_session()
    role = Role(name='Reader')
    db.add(role)
    db.flush()
    screens = (
        ScreenDefinition('dashboard', 'Dashboard', '/', 'dashboard', 10, is_default_landing=True),
        ScreenDefinition('retired', 'Retired', '/retired', 'block', 20, is_active=False),
    )
    sync_screen_registry(db, screens)

    with pytest.raises(ValueError, match='inactive screen'):
        set_role_screen_permission(db, role.id, 'retired', True, False)


def test_default_landing_and_existing_routes_are_registered():
    db = db_session()
    role = Role(name='Reader')
    user = User(email='landing@example.test', display_name='Landing', password_hash='x', roles=[role])
    db.add(user)
    db.flush()
    sync_screen_registry(db)
    assert landing_url_for_user(db, user) == '/'
    routes = {screen.url for screen in SCREEN_REGISTRY}
    assert {'/add-project', '/evidence-scan', '/audit-workspace', '/reports'} <= routes


def test_startup_disables_previously_persisted_retired_screens():
    db = db_session()
    db.add_all([
        MdScreen(
            screen_id=screen_id,
            menu_name=screen_id,
            url=f'/retired-{index}',
            icon='block',
            is_active=True,
            is_default_landing=True,
        )
        for index, screen_id in enumerate(RETIRED_SCREEN_IDS)
    ])
    db.flush()

    sync_screen_registry(db)

    for screen_id in RETIRED_SCREEN_IDS:
        screen = db.get(MdScreen, screen_id)
        assert screen is not None
        assert screen.is_active is False
        assert screen.is_default_landing is False
