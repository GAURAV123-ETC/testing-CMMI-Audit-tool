"""Compatibility ASGI entry point.

The application is implemented in the workspace-level :mod:`main` module.
Some development tools conventionally start FastAPI with ``app.main:app``;
re-exporting the same instance keeps that command valid without creating a
second application or duplicating startup registration.
"""

from main import app

__all__ = ['app']
