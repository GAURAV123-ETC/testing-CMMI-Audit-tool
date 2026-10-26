"""Central policy for access to the intentionally shared audit workspace."""
from sqlalchemy.orm import Session

from app.core.screen_registry import has_screen_permission
from app.db.models import User

# This is a deliberate product policy, not an accidental lack of tenancy. See
# docs/security.md before changing it: tenant isolation needs new data models
# and cannot safely be inferred from provenance fields such as owner_id.
WORKSPACE_ACCESS_POLICY = 'shared_internal_workspace_v1'


def authorize_workspace_access(db: Session, user: User, screen_id: str,
                               action: str = 'read') -> bool:
    """Authorize a workspace operation for every resource visible to a screen."""
    return has_screen_permission(db, user, screen_id, action)
