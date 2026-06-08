"""Live takeover ('Step on stage') control endpoints.

The dashboard hits these to mute the persona and bridge the operator's mic
audio into the live call. Mic audio flows over a binary WebSocket — see
api/ws.py for that side.
"""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from redis.asyncio import Redis

from truman_calling.api.deps import require_auth
from truman_calling.core.settings import settings

log = logging.getLogger("api.takeover")

router = APIRouter(prefix="/v1/runs", tags=["takeover"])


def _control_channel(run_id: uuid.UUID) -> str:
    return f"truman:takeover:{run_id}"


async def _publish_control(run_id: uuid.UUID, payload: dict) -> None:
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    try:
        await redis.publish(_control_channel(run_id), json.dumps(payload))
    finally:
        await redis.aclose()


@router.post("/{run_id}/takeover/start", status_code=status.HTTP_202_ACCEPTED)
async def takeover_start(
    run_id: uuid.UUID,
    _: uuid.UUID = Depends(require_auth),
) -> dict[str, str]:
    if not settings.truman_api_token:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "auth not configured")
    await _publish_control(run_id, {"type": "takeover_start"})
    log.info("takeover_start published for run %s", run_id)
    return {"run_id": str(run_id), "state": "active"}


@router.post("/{run_id}/takeover/stop", status_code=status.HTTP_202_ACCEPTED)
async def takeover_stop(
    run_id: uuid.UUID,
    _: uuid.UUID = Depends(require_auth),
) -> dict[str, str]:
    await _publish_control(run_id, {"type": "takeover_stop"})
    log.info("takeover_stop published for run %s", run_id)
    return {"run_id": str(run_id), "state": "idle"}


@router.post("/{run_id}/end-call", status_code=status.HTTP_202_ACCEPTED)
async def end_call(
    run_id: uuid.UUID,
    _: uuid.UUID = Depends(require_auth),
) -> dict[str, str]:
    await _publish_control(run_id, {"type": "end_call"})
    log.info("end_call published for run %s", run_id)
    return {"run_id": str(run_id), "state": "ending"}
