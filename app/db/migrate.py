"""Controlled schema/bootstrap command.

Run this command with a migration-capable database account during deployment,
never with the application's runtime account::

    python -m app.db.migrate

The existing bootstrap preserves legacy installations. Runtime startup is
disabled in production through ``AUTO_MIGRATE_ON_STARTUP=false``.
"""
from app.core.config import get_settings
from app.db.init_db import initialise_database


def main() -> None:
    settings = get_settings()
    if settings.environment.lower() == 'production' and settings.auto_migrate_on_startup:
        raise RuntimeError('Set AUTO_MIGRATE_ON_STARTUP=false before production migration.')
    initialise_database()


if __name__ == '__main__':
    main()
