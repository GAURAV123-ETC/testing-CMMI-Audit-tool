from pydantic import BaseModel, EmailStr, Field
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.core.audit_log import log_action
from app.core.config import get_settings
from app.services.integrations.turnstile import verify_turnstile
from app.db.database import get_db
from app.services.auth.service import authenticate, create_session, request_reset, reset_password, revoke_session
from app.services.auth.mailer import send_reset_email
from app.core.screen_registry import landing_url_for_user

router = APIRouter(prefix='/auth', tags=['authentication'])
limiter = Limiter(key_func=get_remote_address)
class LoginIn(BaseModel): email: EmailStr; password: str = Field(min_length=12, max_length=256); turnstile_token: str | None = None
class ResetRequest(BaseModel): email: EmailStr
class ResetConfirm(BaseModel): token: str; password: str = Field(min_length=12, max_length=256)

@router.post('/login')
@limiter.limit('10/minute')
async def login(request: Request, payload: LoginIn, response: Response, db: Session = Depends(get_db)):
    if get_settings().turnstile_enabled and not await verify_turnstile(payload.turnstile_token, request.client.host if request.client else None):
        raise HTTPException(400, 'Turnstile verification failed')
    user = authenticate(db, payload.email, payload.password)
    if not user:
        log_action(db, 'login_failed', detail=payload.email.lower()); db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Invalid credentials or locked account')
    token = create_session(db, user); log_action(db, 'login', user_id=user.id); db.commit()
    response.set_cookie('cmmi_session', token, httponly=True,
                        secure=get_settings().environment.lower() == 'production',
                        samesite='lax', max_age=get_settings().session_seconds)
    return {'id': user.id, 'email': user.email, 'roles': [r.name for r in user.roles], 'landing_url': landing_url_for_user(db, user)}

@router.post('/logout')
def logout(response: Response, request: Request, db: Session = Depends(get_db)):
    revoke_session(db, request.cookies.get('cmmi_session')); response.delete_cookie('cmmi_session'); return {'ok': True}

@router.post('/password-reset')
@limiter.limit('3/hour')
def password_reset_request(request: Request, payload: ResetRequest, db: Session = Depends(get_db)):
    token = request_reset(db, payload.email)
    if token:
        try: send_reset_email(payload.email, token)
        except Exception: log_action(db, 'password_reset_delivery_failed', detail=payload.email.lower())
    log_action(db, 'password_reset_requested', detail=payload.email.lower()); db.commit()
    # Never disclose whether the account exists or whether an email provider is configured.
    return {'ok': True}

@router.post('/password-reset/confirm')
def password_reset_confirm(payload: ResetConfirm, db: Session = Depends(get_db)):
    if not reset_password(db, payload.token, payload.password): raise HTTPException(400, 'Invalid or expired reset token')
    return {'ok': True}
