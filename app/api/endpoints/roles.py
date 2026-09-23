from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import current_user, require_screen
from app.core.audit_log import log_action
from app.core.screen_registry import create_disabled_screen_mappings
from app.db.database import get_db
from app.db.models import Role
from app.services.role_administration import replace_screen_permissions, role_view

router = APIRouter(prefix='/roles', tags=['roles'])


class RoleIn(BaseModel):
    name: str = Field(min_length=2, max_length=64)
    description: str = Field(default='', max_length=255)


class ScreenPermissionIn(BaseModel):
    screen_id: str = Field(min_length=1, max_length=64)
    can_read: bool
    can_write: bool


class RolePermissionsIn(BaseModel):
    default_screen_id: str | None = Field(default=None, max_length=64)
    screens: list[ScreenPermissionIn]


def _role_or_404(db: Session, role_id: int) -> Role:
    role = db.get(Role, role_id)
    if not role:
        raise HTTPException(404, 'Role not found')
    return role


def _clean_name(value: str) -> str:
    name = value.strip()
    if not 2 <= len(name) <= 64:
        raise HTTPException(422, 'Role name must contain 2 to 64 non-space characters')
    return name


@router.get('')
def list_roles(db: Session = Depends(get_db), user=Depends(current_user),
               screen_user=Depends(require_screen('role_administration'))):
    return [role_view(db, role) for role in db.scalars(select(Role).where(Role.is_active.is_(True)).order_by(Role.name)).all()]


@router.get('/{role_id}')
def get_role(role_id: int, db: Session = Depends(get_db), user=Depends(current_user),
             screen_user=Depends(require_screen('role_administration'))):
    return role_view(db, _role_or_404(db, role_id))


@router.post('', status_code=201)
def create_role(payload: RoleIn, db: Session = Depends(get_db), user=Depends(current_user),
                screen_user=Depends(require_screen('role_administration', 'write'))):
    name = _clean_name(payload.name)
    if db.scalar(select(Role).where(func.lower(Role.name) == name.casefold())):
        raise HTTPException(409, 'Role already exists')
    role = Role(name=name, description=payload.description.strip())
    try:
        db.add(role)
        db.flush()
        create_disabled_screen_mappings(db, role)
        log_action(db, 'role_created', user_id=user.id, entity_type='role', entity_id=str(role.id), detail=role.name)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'Role already exists') from exc
    db.refresh(role)
    return role_view(db, role)


@router.put('/{role_id}')
def update_role(role_id: int, payload: RoleIn, db: Session = Depends(get_db), user=Depends(current_user),
                screen_user=Depends(require_screen('role_administration', 'write'))):
    role = _role_or_404(db, role_id)
    name = _clean_name(payload.name)
    duplicate = db.scalar(select(Role.id).where(func.lower(Role.name) == name.casefold(), Role.id != role.id))
    if duplicate:
        raise HTTPException(409, 'Role already exists')
    try:
        role.name = name
        role.description = payload.description.strip()
        log_action(db, 'role_updated', user_id=user.id, entity_type='role', entity_id=str(role.id), detail=role.name)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'Role already exists') from exc
    db.refresh(role)
    return role_view(db, role)


@router.put('/{role_id}/screen-permissions')
def replace_role_permissions(role_id: int, payload: RolePermissionsIn,
                             db: Session = Depends(get_db), user=Depends(current_user),
                             screen_user=Depends(require_screen('role_administration', 'write'))):
    role = _role_or_404(db, role_id)
    try:
        replace_screen_permissions(
            db, role, [entry.model_dump() for entry in payload.screens], payload.default_screen_id,
        )
        log_action(db, 'role_screen_permissions_updated', user_id=user.id,
                   entity_type='role', entity_id=str(role.id), detail=f'screens={len(payload.screens)}')
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'Role permissions could not be saved because the role or a screen changed.') from exc
    db.refresh(role)
    return role_view(db, role)
