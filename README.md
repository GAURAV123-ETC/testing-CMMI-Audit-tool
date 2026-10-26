# CMMI V3.0 Audit Platform

This repository is a server-first Python/NiceGUI/FastAPI/MySQL platform. The production entrypoint is `main.py`.

## Local development

Install Python 3.12, copy `.env.example` to `.env`, configure MySQL, then run:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
pytest -q
```

On an empty database, open `http://127.0.0.1:8090/login` and create the one
initial administrator account. After that, public registration is disabled;
administrators create all later accounts from Manage Users. On Windows,
`run-local.cmd` activates the same entrypoint with development reload enabled.

For deployment, see `docs/deployment.md`.

## Security operations

Production requires a dedicated non-root runtime database account, a unique
32-character-or-longer `SECRET_KEY`, HTTPS `PUBLIC_BASE_URL`, and
`AUTO_MIGRATE_ON_STARTUP=false`. Apply the controlled bootstrap/migration step
with `python -m app.db.migrate` using a separate DDL-capable account before
starting the runtime container. The CI security workflow runs dependency,
static-analysis, secret, SBOM, and container-image checks. A fully hash-pinned
lockfile still requires generating and reviewing it against the Python 3.12
production build environment before it can replace the current compatibility
ranges in `requirements.txt`.
