import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.init_db import ROLES, _rename_reviewer_role, _retire_unsupported_roles
from app.db.models import Role, User
from app.core.screen_registry import set_role_screen_permission, sync_screen_registry
from app.services.user_administration import assignable_role_names, create_user, delete_user, update_user


def _database():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    db.add_all([Role(name='Admin'), Role(name='Super Admin'), Role(name='Auditor'), Role(name='Auditee')])
    db.commit()
    sync_screen_registry(db)
    admin_role = db.scalar(select(Role).where(Role.name == 'Admin'))
    set_role_screen_permission(db, admin_role.id, 'user_administration', True, True)
    set_role_screen_permission(db, admin_role.id, 'role_administration', True, True)
    db.commit()
    actor = User(email='operator@example.com', display_name='Operator', password_hash='not-used')
    db.add(actor)
    db.commit()
    return db, actor


def test_user_administration_uses_database_backed_roles():
    db, actor = _database()
    try:
        admin = create_user(
            db, actor_id=actor.id, email='admin@example.com', display_name='Admin User',
            password='a-secure-password', role_name='Admin',
        )
        db.commit()
        auditor = create_user(
            db, actor_id=admin.id, email='auditor@example.com', display_name='Auditor User',
            password='another-secure-password', role_name='Auditor',
        )
        db.commit()

        assert [role.name for role in auditor.roles] == ['Auditor']
        auditee = create_user(
            db, actor_id=admin.id, email='auditee@example.com', display_name='Auditee User',
            password='another-secure-password', role_name='Auditee',
        )
        db.commit()
        assert [role.name for role in auditee.roles] == ['Auditee']
        assert assignable_role_names(db) == ['Admin', 'Auditee', 'Auditor', 'Super Admin']
        with pytest.raises(ValueError, match='valid role'):
            create_user(
                db, actor_id=admin.id, email='unknown@example.com', display_name='Unknown User',
                password='another-secure-password', role_name='Not a role',
            )
        assert db.query(User).count() == 4
    finally:
        db.close()


def test_legacy_reviewer_role_is_migrated_to_auditee_without_losing_membership():
    db, actor = _database()
    try:
        db.delete(db.scalar(select(Role).where(Role.name == 'Auditee')))
        db.commit()
        legacy_role = Role(name='Reviewer', description='Reviewer role')
        legacy_user = User(
            email='legacy@example.com', display_name='Legacy User', password_hash='not-used',
            roles=[legacy_role],
        )
        db.add_all([legacy_role, legacy_user])
        db.commit()
        legacy_role_id = legacy_role.id

        _rename_reviewer_role(db)
        db.commit()

        auditee = db.scalar(select(Role).where(Role.name == 'Auditee'))
        assert auditee.id == legacy_role_id
        assert db.scalar(select(Role).where(Role.name == 'Reviewer')) is None
        assert [role.name for role in legacy_user.roles] == ['Auditee']
        assert 'Auditee' in ROLES
        assert 'Reviewer' not in ROLES
    finally:
        db.close()


def test_legacy_reviewer_role_merges_into_an_existing_auditee_role():
    db, actor = _database()
    try:
        auditee = db.scalar(select(Role).where(Role.name == 'Auditee'))
        legacy_role = Role(name='Reviewer')
        legacy_user = User(
            email='legacy@example.com', display_name='Legacy User', password_hash='not-used',
            roles=[legacy_role],
        )
        db.add_all([legacy_role, legacy_user])
        db.commit()

        _rename_reviewer_role(db)
        db.commit()

        assert db.scalar(select(Role).where(Role.name == 'Reviewer')) is None
        assert [role.id for role in legacy_user.roles] == [auditee.id]
    finally:
        db.close()


def test_legacy_account_manager_and_viewer_are_consolidated_into_auditee():
    db, actor = _database()
    try:
        account_manager = Role(name='Account Manager')
        viewer = Role(name='Viewer')
        manager_user = User(email='manager@example.com', display_name='Manager', password_hash='not-used', roles=[account_manager])
        viewer_user = User(email='viewer@example.com', display_name='Viewer', password_hash='not-used', roles=[viewer])
        db.add_all([account_manager, viewer, manager_user, viewer_user])
        db.commit()

        _retire_unsupported_roles(db)
        db.commit()

        assert db.scalar(select(Role).where(Role.name == 'Account Manager')) is None
        assert db.scalar(select(Role).where(Role.name == 'Viewer')) is None
        assert [role.name for role in manager_user.roles] == ['Auditee']
        assert [role.name for role in viewer_user.roles] == ['Auditee']
    finally:
        db.close()


def test_user_administration_preserves_an_admin_and_blocks_self_delete():
    db, actor = _database()
    try:
        admin = create_user(
            db, actor_id=actor.id, email='admin@example.com', display_name='Admin User',
            password='a-secure-password', role_name='Admin',
        )
        db.commit()
        with pytest.raises(ValueError, match='Manage Users'):
            update_user(
                db, actor_id=admin.id, user_id=admin.id, email=admin.email,
                display_name=admin.display_name, role_name='Auditor',
            )
        with pytest.raises(ValueError, match='own account'):
            delete_user(db, actor_id=admin.id, user_id=admin.id)

        second_admin = create_user(
            db, actor_id=admin.id, email='second@example.com', display_name='Second Admin',
            password='another-secure-password', role_name='Admin',
        )
        db.commit()
        delete_user(db, actor_id=admin.id, user_id=second_admin.id)
        db.commit()
        assert db.get(User, second_admin.id) is None
    finally:
        db.close()


def test_user_administration_enforces_persisted_field_limits():
    db, actor = _database()
    try:
        with pytest.raises(ValueError, match='must not exceed 160'):
            create_user(
                db, actor_id=actor.id, email='oversized-name@example.com', display_name='x' * 161,
                password='a-secure-password', role_name='Auditor',
            )
        with pytest.raises(ValueError, match='valid email'):
            create_user(
                db, actor_id=actor.id, email='invalid-email', display_name='Auditor User',
                password='a-secure-password', role_name='Auditor',
            )
    finally:
        db.close()
