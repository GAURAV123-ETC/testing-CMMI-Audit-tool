import httpx
from app.core.config import get_settings
async def verify_turnstile(token: str | None, remote_ip: str | None) -> bool:
    settings=get_settings()
    if not settings.turnstile_enabled: return True
    if not token or not settings.turnstile_secret_key: return False
    async with httpx.AsyncClient(timeout=5) as client:
        response=await client.post('https://challenges.cloudflare.com/turnstile/v0/siteverify',data={'secret':settings.turnstile_secret_key,'response':token,'remoteip':remote_ip or ''})
    return bool(response.is_success and response.json().get('success'))
