from pydantic import BaseModel, EmailStr, Field
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.api.deps import current_user, require_screen
from app.db.database import get_db
from app.db.models import User
from app.services.user_administration import (create_user as create_managed_user,
                                              delete_user as delete_managed_user,
                                              set_user_active,
                                              update_user as update_managed_user)
router=APIRouter(prefix='/users',tags=['users'])
class UserIn(BaseModel):
    email: EmailStr
    display_name: str = Field(min_length=2, max_length=160)
    password: str = Field(min_length=12)
    role: str
class UserUpdateIn(BaseModel):
    email: EmailStr
    display_name: str = Field(min_length=2, max_length=160)
    role: str
    password: str | None = Field(default=None, min_length=12)
class UserStatusIn(BaseModel):
    is_active: bool
def user_view(account: User) -> dict:
    return {'id':account.id, 'email':account.email, 'display_name':account.display_name, 'is_active':account.is_active, 'roles':[role.name for role in account.roles], 'created_at':account.created_at}
@router.get('')
def list_users(db: Session=Depends(get_db), user=Depends(current_user),
               screen_user=Depends(require_screen('user_administration'))): return [user_view(account) for account in db.scalars(select(User).order_by(User.email)).all()]
@router.post('')
def create_user(payload: UserIn, db: Session=Depends(get_db), user=Depends(current_user),
                screen_user=Depends(require_screen('user_administration', 'write'))):
    try:
        account = create_managed_user(
            db, actor_id=user.id, email=str(payload.email), display_name=payload.display_name,
            password=payload.password, role_name=payload.role,
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'This email is already registered.') from exc
    db.refresh(account)
    return user_view(account)


@router.put('/{user_id}')
def update_user(user_id: int, payload: UserUpdateIn, db: Session = Depends(get_db),
                user=Depends(current_user),
                screen_user=Depends(require_screen('user_administration', 'write'))):
    try:
        account = update_managed_user(
            db, actor_id=user.id, user_id=user_id, email=str(payload.email),
            display_name=payload.display_name, role_name=payload.role, password=payload.password,
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'This email is already registered.') from exc
    db.refresh(account)
    return user_view(account)


@router.put('/{user_id}/status')
def update_user_status(user_id: int, payload: UserStatusIn, db: Session = Depends(get_db),
                       user=Depends(current_user),
                       screen_user=Depends(require_screen('user_administration', 'write'))):
    try:
        account = set_user_active(db, actor_id=user.id, user_id=user_id, is_active=payload.is_active)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    db.refresh(account)
    return user_view(account)


@router.delete('/{user_id}', status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db), user=Depends(current_user),
                screen_user=Depends(require_screen('user_administration', 'write'))):
    try:
        delete_managed_user(db, actor_id=user.id, user_id=user_id)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
