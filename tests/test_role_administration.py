import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.screen_registry import (has_screen_permission, landing_url_for_user,
                                      set_role_screen_permission, sync_screen_registry)
from app.db.database import Base
from app.db.models import MdScreen, Role, User, UserSession
from app.services.role_administration import replace_screen_permissions
from app.services.user_administration import set_user_active


def _database():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    manager_role = Role(name='Access Manager')
    reader_role = Role(name='Reader')
    db.add_all([manager_role, reader_role])
    db.flush()
    sync_screen_registry(db)
    set_role_screen_permission(db, manager_role.id, 'user_administration', True, True)
    set_role_screen_permission(db, manager_role.id, 'role_administration', True, True)
    manager = User(email='manager@example.test', display_name='Manager', password_hash='x', roles=[manager_role])
    reader = User(email='reader@example.test', display_name='Reader', password_hash='x', roles=[reader_role])
    db.add_all([manager, reader])
    db.commit()
    return db, manager, reader, manager_role, reader_role


def _matrix(db, role, overrides=None):
    overrides = overrides or {}
    return [
        {'screen_id': screen.screen_id, 'can_read': overrides.get(screen.screen_id, (False, False))[0],
         'can_write': overrides.get(screen.screen_id, (False, False))[1]}
        for screen in db.query(MdScreen).filter_by(is_active=True)
    ]


def test_role_landing_requires_read_access_and_is_used_for_the_user():
    db, manager, reader, manager_role, reader_role = _database()
    try:
        permissions = _matrix(db, reader_role, {'evidence_scan': (True, False)})
        replace_screen_permissions(db, reader_role, permissions, 'evidence_scan')
        db.commit()

        assert reader_role.default_screen_id == 'evidence_scan'
        assert has_screen_permission(db, reader, 'evidence_scan') is True
        assert landing_url_for_user(db, reader) == '/evidence-scan'

        with pytest.raises(ValueError, match='must be an active screen with Read access'):
            replace_screen_permissions(db, reader_role, _matrix(db, reader_role), 'evidence_scan')

        with pytest.raises(ValueError, match='default landing page'):
            set_role_screen_permission(db, reader_role.id, 'evidence_scan', False, False)
    finally:
        db.close()


def test_bulk_permission_update_protects_final_role_manager_and_deactivation_revokes_sessions():
    db, manager, reader, manager_role, reader_role = _database()
    try:
        with pytest.raises(ValueError, match='manage access'):
            replace_screen_permissions(db, manager_role, _matrix(db, manager_role), None)

        session = UserSession(token_hash='a' * 64, user_id=reader.id, expires_at=manager.created_at)
        db.add(session)
        db.commit()
        set_user_active(db, actor_id=manager.id, user_id=reader.id, is_active=False)
        db.commit()
        assert reader.is_active is False
        assert session.revoked_at is not None
    finally:
        db.close()
