from fastapi import APIRouter
from app.api.endpoints import auth, audits, reports, users, integrations, roles
router = APIRouter(prefix='/api/v1')
router.include_router(auth.router); router.include_router(audits.router); router.include_router(reports.router)
router.include_router(users.router); router.include_router(integrations.router)
router.include_router(roles.router)
