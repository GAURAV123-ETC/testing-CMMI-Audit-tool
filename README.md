# CMMI V3.0 Audit Platform

This repository is being migrated to a server-first Python/NiceGUI/FastAPI/MySQL platform. The Python production entrypoint is `main.py`; the legacy React/Vite implementation remains only as a temporary migration reference pending test and Docker verification.

## Local development

Install Python 3.12, copy `.env.example` to `.env`, configure MySQL, then run:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8010
pytest -q
```

For deployment, see `docs/deployment.md`.
