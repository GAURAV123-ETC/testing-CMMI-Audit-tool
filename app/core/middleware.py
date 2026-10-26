from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, RedirectResponse

from app.core.config import get_settings

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        # NiceGUI loads its client through module scripts and a WebSocket.  Do
        # not enforce a restrictive CSP during local development: browsers can
        # otherwise render an empty shell without showing the actual page.
        # A production CSP is still applied when ENVIRONMENT=production.
        if get_settings().environment.lower() == 'production':
            turnstile_origin = ' https://challenges.cloudflare.com' if get_settings().turnstile_enabled else ''
            response.headers['Content-Security-Policy'] = (
                "default-src 'self'; img-src 'self' data:; "
                "style-src 'self' 'unsafe-inline'; "
                f"script-src 'self' 'unsafe-inline'{turnstile_origin}; "
                f"frame-src 'self'{turnstile_origin}; "
                f"connect-src 'self' wss:{turnstile_origin}"
            )
            response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
        return response


class OriginValidationMiddleware(BaseHTTPMiddleware):
    """Require a trusted Origin for cookie-authenticated API mutations."""
    _safe_paths = {'/api/v1/auth/login', '/api/v1/auth/first-administrator',
                   '/api/v1/auth/password-reset', '/api/v1/auth/password-reset/confirm'}

    async def dispatch(self, request, call_next):
        if (request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}
                and request.url.path.startswith('/api/')
                and request.url.path not in self._safe_paths
                and request.cookies.get('cmmi_session')):
            origin = request.headers.get('origin')
            if not origin or origin.rstrip('/') not in get_settings().trusted_origins():
                return JSONResponse({'detail': 'Untrusted request origin'}, status_code=403)
        return await call_next(request)

class GuiAuthenticationMiddleware(BaseHTTPMiddleware):
    """Protect NiceGUI pages while leaving API authentication to FastAPI dependencies."""
    async def dispatch(self, request, call_next):
        path = request.url.path
        public = (
            path == '/login'
            or path.startswith('/api/')
            or path.startswith('/_nicegui/')
            # NiceGUI mounts its Socket.IO service here. It must remain
            # reachable before login so the public login page can hydrate.
            or path.startswith('/_nicegui_ws/')
            or path in {'/favicon.ico', '/healthz'}
        )
        if not public:
            from app.db.database import SessionLocal
            from app.services.auth.service import get_session_user
            with SessionLocal() as db:
                if not get_session_user(db, request.cookies.get('cmmi_session')):
                    return RedirectResponse('/login', status_code=303)
                # A hidden sidebar entry must never be treated as access
                # control.  Resolve the URL through the single screen registry
                # and enforce its Read grant before the NiceGUI page executes.
                from app.core.screen_registry import has_screen_permission, landing_url_for_user, screen_for_url
                user = get_session_user(db, request.cookies.get('cmmi_session'))
                screen = screen_for_url(path)
                if screen and not has_screen_permission(db, user, screen.screen_id):
                    return RedirectResponse(landing_url_for_user(db, user), status_code=303)
        return await call_next(request)
