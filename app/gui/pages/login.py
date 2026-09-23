"""Public sign-in page and one-time first-administrator setup."""
import json
import uuid

from nicegui import ui

from app.db.database import SessionLocal
from app.core.config import get_settings
from app.services.auth.service import first_administrator_required


def _request_script(path: str, body: dict) -> str:
    """Generate the browser request used by the public login forms."""
    encoded = json.dumps(json.dumps(body))
    return (
        f"fetch('{path}',{{method:'POST',headers:{{'Content-Type':'application/json'}},"
        f"credentials:'same-origin',body:{encoded}}})"
        ".then(async response=>({ok:response.ok,data:await response.json()}))"
    )


def _request_error_message(result: object, fallback: str) -> str:
    """Convert API validation payloads into a safe, useful UI message."""
    if not isinstance(result, dict):
        return fallback
    data = result.get('data')
    if not isinstance(data, dict):
        return fallback
    detail = data.get('detail')
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    if isinstance(detail, list):
        password_minimum = None
        for item in detail:
            if not isinstance(item, dict) or tuple(item.get('loc') or ())[-1:] != ('password',):
                continue
            context = item.get('ctx') or {}
            if isinstance(context.get('min_length'), int):
                password_minimum = context['min_length']
                break
        locations = {
            tuple(item.get('loc') or ())[-1]
            for item in detail if isinstance(item, dict) and item.get('loc')
        }
        if 'email' in locations:
            return 'Enter a valid email address.'
        if 'password' in locations:
            return (f'Password must contain at least {password_minimum} characters.'
                    if password_minimum else 'Enter your password.')
    return fallback


def _render_turnstile() -> bool:
    """Render a verified-browser challenge when it is enabled in configuration."""
    settings = get_settings()
    if not settings.turnstile_enabled:
        return False
    if not settings.turnstile_site_key:
        ui.label('Sign-in security is not configured. Contact an administrator.').classes('text-negative text-sm')
        return True
    widget_id = f'cmmi-turnstile-{uuid.uuid4().hex}'
    ui.add_head_html(
        '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>'
    )
    ui.add_head_html(f"""
        <script>
          window.cmmiTurnstileToken = '';
          (function renderTurnstile() {{
            const target = document.getElementById('{widget_id}');
            if (!target || !window.turnstile) {{ setTimeout(renderTurnstile, 100); return; }}
            if (!target.hasChildNodes()) {{
              window.cmmiTurnstileWidget = window.turnstile.render(target, {{
                sitekey: {json.dumps(settings.turnstile_site_key)},
                callback: token => window.cmmiTurnstileToken = token,
                'expired-callback': () => window.cmmiTurnstileToken = '',
              }});
            }}
          }})();
        </script>
    """)
    ui.element('div').props(f'id="{widget_id}"').classes('w-full mt-3')
    return True


async def _turnstile_token(enabled: bool) -> str | None:
    if not enabled:
        return None
    try:
        return await ui.run_javascript('window.cmmiTurnstileToken || ""', timeout=5)
    except TimeoutError:
        return ''


def register():
    @ui.page('/login')
    def login_page():
        with SessionLocal() as db:
            setup_required = first_administrator_required(db)

        ui.label('CMMI V3.0 Audit Platform').classes('text-2xl font-bold m-6')
        if setup_required:
            _first_administrator_form()
        else:
            _sign_in_form()


def _first_administrator_form() -> None:
    """Show registration only while the database contains no user accounts."""
    with ui.card().classes('m-6 w-96'):
        ui.label('Initial setup').classes('text-xl font-bold')
        ui.label('Create the first administrator account. Later accounts can only be created by an administrator.').classes('text-sm text-slate-600')
        display_name = ui.input('Full name').classes('w-full')
        email = ui.input('Email').props('type=email').classes('w-full')
        password = ui.input('Password', password=True, password_toggle_button=True).classes('w-full')
        confirmation = ui.input('Confirm password', password=True, password_toggle_button=True).classes('w-full')
        turnstile_enabled = _render_turnstile()

        async def submit() -> None:
            name = (display_name.value or '').strip()
            if len(name) < 2:
                ui.notify('Enter a full name of at least two characters.', type='negative')
                return
            if password.value != confirmation.value:
                ui.notify('Passwords do not match.', type='negative')
                return
            body = {'email': email.value, 'display_name': name, 'password': password.value,
                    'turnstile_token': await _turnstile_token(turnstile_enabled)}
            result = await ui.run_javascript(
                _request_script('/api/v1/auth/first-administrator', body), timeout=15
            )
            if result and result.get('ok'):
                ui.navigate.to(result.get('data', {}).get('landing_url') or '/')
            else:
                ui.notify(_request_error_message(result, 'Initial setup failed.'), type='negative')

        ui.button('Create administrator account', on_click=submit).classes('w-full')


def _sign_in_form() -> None:
    with ui.card().classes('m-6 w-96'):
        ui.label('Secure sign in').classes('text-xl font-bold')
        email = ui.input('Email').props('type=email').classes('w-full')
        password = ui.input('Password', password=True, password_toggle_button=True).classes('w-full')
        turnstile_enabled = _render_turnstile()

        async def submit() -> None:
            body = {'email': email.value,
                    'password': password.value,
                    'turnstile_token': await _turnstile_token(turnstile_enabled)}
            result = await ui.run_javascript(_request_script('/api/v1/auth/login', body), timeout=15)
            if result and result.get('ok'):
                ui.navigate.to(result.get('data', {}).get('landing_url') or '/')
            else:
                ui.notify(_request_error_message(result, 'Sign in failed.'), type='negative')

        ui.button('Sign in', on_click=submit).classes('w-full')
        if get_settings().microsoft_oauth_enabled:
            ui.button(
                'Sign in with Microsoft',
                on_click=lambda: ui.notify('Microsoft OAuth is configured server-side; redirect endpoint pending provider credentials.'),
            ).props('outline')
