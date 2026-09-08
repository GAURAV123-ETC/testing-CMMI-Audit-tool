from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, require_screen
from app.core.screen_registry import create_disabled_screen_mappings, set_role_screen_permission
from app.db.database import get_db
from app.db.models import MapRoleScreen, MdScreen, Role

router = APIRouter(prefix='/roles', tags=['roles'])


class RoleIn(BaseModel):
    name: str = Field(min_length=2, max_length=64)
    description: str = Field(default='', max_length=255)


class ScreenPermissionIn(BaseModel):
    can_read: bool
    can_write: bool


def _view(role: Role, db: Session) -> dict:
    mappings = db.scalars(
        select(MapRoleScreen)
        .join(MdScreen, MdScreen.screen_id == MapRoleScreen.screen_id)
        .where(MapRoleScreen.role_id == role.id, MdScreen.is_active.is_(True))
    ).all()
    return {
        'id': role.id,
        'name': role.name,
        'description': role.description,
        'screens': [
            {'screen_id': item.screen_id, 'can_read': item.can_read, 'can_write': item.can_write}
            for item in sorted(mappings, key=lambda item: item.screen_id)
        ],
    }


@router.get('')
def list_roles(db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('user_administration'))):
    return [_view(role, db) for role in db.scalars(select(Role).order_by(Role.name)).all()]


@router.post('', status_code=201)
def create_role(payload: RoleIn, db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('user_administration', 'write'))):
    name = payload.name.strip()
    if db.scalar(select(Role).where(Role.name == name)):
        raise HTTPException(409, 'Role already exists')
    role = Role(name=name, description=payload.description.strip())
    db.add(role)
    db.flush()
    create_disabled_screen_mappings(db, role)
    db.commit()
    db.refresh(role)
    return _view(role, db)


@router.put('/{role_id}/screens/{screen_id}')
def set_screen_permission(role_id: int, screen_id: str, payload: ScreenPermissionIn,
                          db: Session = Depends(get_db), user=Depends(current_user), screen_user=Depends(require_screen('user_administration', 'write'))):
    if not db.get(Role, role_id) or not db.get(MdScreen, screen_id):
        raise HTTPException(404, 'Role or screen not found')
    try:
        mapping = set_role_screen_permission(db, role_id, screen_id, payload.can_read, payload.can_write)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    db.commit()
    db.refresh(mapping)
    return {'role_id': mapping.role_id, 'screen_id': mapping.screen_id, 'can_read': mapping.can_read, 'can_write': mapping.can_write}
