from __future__ import annotations

import hmac
import uuid

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from truman_calling.core.settings import settings

DEFAULT_ORG_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")

_security = HTTPBearer(auto_error=True)


async def require_auth(
    creds: HTTPAuthorizationCredentials = Depends(_security),
) -> uuid.UUID:
    if not settings.truman_api_token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="TRUMAN_API_TOKEN not configured",
        )
    if not hmac.compare_digest(creds.credentials, settings.truman_api_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid token",
        )
    return DEFAULT_ORG_ID
