from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from app.core.config import get_settings

class Base(DeclarativeBase):
    pass

def _engine():
    url = get_settings().sqlalchemy_url
    options = {'pool_pre_ping': True}
    if url.startswith('sqlite'):
        options['connect_args'] = {'check_same_thread': False}
    return create_engine(url, **options)

engine = _engine()
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
