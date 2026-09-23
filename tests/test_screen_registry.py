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
    screen_for_url,
    set_role_screen_permission,
    sync_screen_registry,
    visible_screens,
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


def test_retiring_findings_hides_it_and_clears_legacy_role_landing_page():
    db = db_session()
    role = Role(name='Legacy findings user', default_screen_id='findings')
    user = User(email='legacy-findings@example.test', display_name='Legacy', password_hash='x', roles=[role])
    db.add_all([
        MdScreen(screen_id='findings', menu_name='Findings', url='/findings', icon='fact_check',
                 is_active=True, display_order=80),
        role,
        user,
    ])
    db.commit()

    sync_screen_registry(db)

    assert db.get(MdScreen, 'findings').is_active is False
    assert db.get(Role, role.id).default_screen_id is None
    assert screen_for_url('/findings') is None
    assert all(screen.screen_id != 'findings' for screen in visible_screens(db, user))


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


def test_rules_catalogue_access_uses_persisted_role_screen_mappings():
    db = db_session()
    star = Permission(code='*')
    admin = Role(name='Admin', permissions=[star])
    super_admin = Role(name='Super Admin', permissions=[star])
    admin_user = User(email='admin@example.test', display_name='Admin', password_hash='x', roles=[admin])
    super_user = User(email='super@example.test', display_name='Super', password_hash='x', roles=[super_admin])
    db.add_all([admin, super_admin, admin_user, super_user])
    db.flush()

    sync_screen_registry(db)

    assert db.get(MapRoleScreen, (admin.id, 'rule_catalog')).can_write is True
    assert db.get(MapRoleScreen, (super_admin.id, 'rule_catalog')).can_write is True
    assert has_screen_permission(db, admin_user, 'rule_catalog', 'write') is True
    assert has_screen_permission(db, super_user, 'rule_catalog', 'write') is True
    set_role_screen_permission(db, super_admin.id, 'rule_catalog', False, False)
    assert has_screen_permission(db, super_user, 'rule_catalog') is False

    # Global access is a seeded permission, whereas normal custom roles use
    # their explicit database page mapping.
    custom_role = Role(name='Catalogue Reader')
    custom_user = User(email='reader@example.test', display_name='Reader', password_hash='x', roles=[custom_role])
    db.add_all([custom_role, custom_user])
    db.flush()
    create_disabled_screen_mappings(db, custom_role)
    set_role_screen_permission(db, custom_role.id, 'rule_catalog', True, False)
    assert has_screen_permission(db, custom_user, 'rule_catalog') is True
    assert has_screen_permission(db, custom_user, 'rule_catalog', 'write') is False


def test_last_user_administration_manager_cannot_be_removed():
    db = db_session()
    manager_role = Role(name='Role Manager')
    manager = User(email='manager@example.test', display_name='Manager', password_hash='x', roles=[manager_role])
    db.add_all([manager_role, manager])
    db.flush()
    sync_screen_registry(db)
    set_role_screen_permission(db, manager_role.id, 'user_administration', True, True)

    with pytest.raises(ValueError, match='another active user'):
        set_role_screen_permission(db, manager_role.id, 'user_administration', True, False)


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
    screens = (ScreenDefinition('dashboard', 'Dashboard', '/', 'dashboard', 10, is_default_landing=True), ScreenDefinition('review', 'Review', '/review', 'fact_check', 20))
    sync_screen_registry(db, screens)
    set_role_screen_permission(db, role.id, 'review', True, False)
    assert has_screen_permission(db, user, 'review', 'read') is True
    assert has_screen_permission(db, user, 'review', 'write') is False
    with pytest.raises(ValueError, match='requires Read'):
        set_role_screen_permission(db, role.id, 'review', False, True)


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
