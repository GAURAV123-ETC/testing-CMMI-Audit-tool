from fastapi import FastAPI
from nicegui import core, ui
import uvicorn
from slowapi.errors import RateLimitExceeded
from slowapi import _rate_limit_exceeded_handler
from app.api.router import router
from app.api.endpoints.auth import limiter
from app.core.config import get_settings
from app.core.middleware import SecurityHeadersMiddleware, GuiAuthenticationMiddleware
from app.db.init_db import initialise_database
from app.gui.pages import (add_project, login, dashboard, audit_workspace,
                           evidence_scan, rule_catalog, user_administration,
                           role_administration)

settings=get_settings(); settings.prepare_directories()
app=FastAPI(title=settings.app_title, docs_url='/api/docs', redoc_url=None)
app.state.limiter=limiter; app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler); app.add_middleware(SecurityHeadersMiddleware); app.add_middleware(GuiAuthenticationMiddleware); app.include_router(router)
@app.on_event('startup')
def startup(): initialise_database()
login.register(); dashboard.register(); audit_workspace.register(); add_project.register(); rule_catalog.register(); evidence_scan.register(); user_administration.register(); role_administration.register()
# NiceGUI 2.24's mounted-FastAPI template emits Python literals (`False` and
# `None`) into JavaScript. Override its small Vue setup snippet with valid JS.
core.app.config.vue_config_script = '''
app.use(Quasar, {config: vue_config});
Quasar.lang.set(Quasar.lang[language.replace('-', '')]);
Quasar.Dark.set(dark === null ? "auto" : dark);
'''
ui.run_with(app, storage_secret=settings.secret_key, title=settings.app_title, dark='false')


if __name__ == '__main__':
    # ``python main.py`` is the supported local entrypoint. Set APP_RELOAD=true
    # in a development-only environment when automatic reload is wanted.
    uvicorn.run('main:app' if settings.app_reload else app,
                host=settings.app_host, port=settings.app_port,
                reload=settings.app_reload)
