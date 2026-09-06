import json
from nicegui import ui
from app.db.database import SessionLocal
from app.services.auth.service import authenticate, create_session
from app.core.config import get_settings
def register():
    @ui.page('/login')
    def login_page():
        ui.label('Secure sign in').classes('text-2xl font-bold m-6')
        with ui.card().classes('m-6 w-96'):
            email=ui.input('Email').props('type=email').classes('w-full'); password=ui.input('Password', password=True).classes('w-full')
            async def submit():
                body=json.dumps({'email':email.value,'password':password.value})
                result=await ui.run_javascript(f"fetch('/api/v1/auth/login',{{method:'POST',headers:{{'Content-Type':'application/json'}},credentials:'same-origin',body:{json.dumps(body)}}}).then(async r=>({{ok:r.ok,data:await r.json()}}))", timeout=15)
                if result and result.get('ok'): ui.navigate.to(result.get('data', {}).get('landing_url') or '/')
                else: ui.notify((result or {}).get('data',{}).get('detail','Sign in failed'),type='negative')
            ui.button('Sign in',on_click=submit).classes('w-full')
            if get_settings().microsoft_oauth_enabled: ui.button('Sign in with Microsoft',on_click=lambda: ui.notify('Microsoft OAuth configured server-side; redirect endpoint pending provider credentials')).props('outline')
