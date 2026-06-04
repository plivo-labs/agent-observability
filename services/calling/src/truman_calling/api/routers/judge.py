"""POST /v1/judge — score a transcript against ad-hoc criteria using LiveKit's
eval judges (`livekit.agents.evals`). Same request/response contract as before
(`{transcript, criteria}` → `{criteria, overall, notes}`); the engine behind it
is now LiveKit's judges via `core.livekit_judge`. Used by AO's Simulate and by
the caller's post-call eval.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from truman_calling.api.deps import require_auth
from truman_calling.api.schemas.judge import JudgeRequest
from truman_calling.core.livekit_judge import judge_transcript_text

router = APIRouter(prefix="/v1/judge", tags=["judge"])


@router.post("")
async def judge(payload: JudgeRequest, _org: uuid.UUID = Depends(require_auth)) -> dict:
    if not payload.criteria:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "at least one criterion is required")
    criteria = [{"key": c.key, "question": c.question, "weight": c.weight} for c in payload.criteria]
    try:
        return await judge_transcript_text(payload.transcript, criteria)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"judge failed: {e}") from e
