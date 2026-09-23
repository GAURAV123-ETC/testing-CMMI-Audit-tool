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

On an empty database, open `http://127.0.0.1:8010/login` and create the one
initial administrator account. After that, public registration is disabled;
administrators create all later accounts from Manage Users. On Windows,
`run-local.cmd` activates the same entrypoint with development reload enabled.

For deployment, see `docs/deployment.md`.
