# CMMI V3.0 Audit Platform

This repository is a server-first Python/NiceGUI/FastAPI/MySQL platform. The production entrypoint is `main.py`.

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
