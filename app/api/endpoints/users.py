from pydantic import BaseModel, EmailStr, Field
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.api.deps import current_user, require_screen
from app.core.audit_log import log_action
from app.core.security import hash_password
from app.db.database import get_db
from app.db.models import Role, User
router=APIRouter(prefix='/users',tags=['users'])
class UserIn(BaseModel): email: EmailStr; display_name: str = Field(min_length=2,max_length=160); password: str = Field(min_length=12); roles: list[str]
def user_view(account: User) -> dict:
    return {'id':account.id, 'email':account.email, 'display_name':account.display_name, 'is_active':account.is_active, 'roles':[role.name for role in account.roles], 'created_at':account.created_at}
@router.get('')
def list_users(db: Session=Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('user_administration'))): return [user_view(account) for account in db.scalars(select(User).order_by(User.email)).all()]
@router.post('')
def create_user(payload: UserIn, db: Session=Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('user_administration', 'write'))):
    if db.scalar(select(User).where(User.email==payload.email.lower())): raise HTTPException(409,'Email already exists')
    roles=db.scalars(select(Role).where(Role.name.in_(payload.roles))).all()
    if len(roles)!=len(set(payload.roles)): raise HTTPException(422,'Unknown role')
    account=User(email=payload.email.lower(),display_name=payload.display_name,password_hash=hash_password(payload.password),roles=roles); db.add(account); db.flush(); log_action(db,'user_created',user_id=user.id,entity_type='user',entity_id=str(account.id)); db.commit(); db.refresh(account); return user_view(account)
