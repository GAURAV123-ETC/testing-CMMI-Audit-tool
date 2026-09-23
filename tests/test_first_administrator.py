import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.models import Role, User
from app.services.auth.service import first_administrator_required, register_first_administrator


def test_first_administrator_is_created_once_and_receives_admin_role():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)

    with factory() as db:
        db.add(Role(name='Admin'))
        db.commit()
        assert first_administrator_required(db)

        user = register_first_administrator(
            db, 'FIRST.ADMIN@example.com', 'First Administrator', 'a-secure-password'
        )
        db.commit()

        assert user.email == 'first.admin@example.com'
        assert [role.name for role in user.roles] == ['Admin']
        assert not first_administrator_required(db)
        with pytest.raises(ValueError, match='already complete'):
            register_first_administrator(db, 'second@example.com', 'Second Administrator', 'another-secure-password')
        assert db.query(User).count() == 1


def test_first_administrator_requires_seeded_role_and_nonblank_name():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)

    with factory() as db:
        with pytest.raises(ValueError, match='at least two'):
            register_first_administrator(db, 'first@example.com', ' ', 'a-secure-password')
        with pytest.raises(ValueError, match='role is unavailable'):
            register_first_administrator(db, 'first@example.com', 'First Administrator', 'a-secure-password')
