"""Streams the caller-side OGG/Opus recording for a run to the dashboard.

The recorder writes a stereo OGG (agent on left, callee on right) at
/tmp/agent-sessions/recording_{session_id}.ogg from the moment the WebSocket
connects. We tail-stream it: serve what's on disk, then keep the response
open while the file is still being written, sending each new flush as a
chunked HTTP body. The browser's <audio> element decodes Opus natively.

Auth via ?token=... since browsers can't set Authorization on <audio src>.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.core.models import Run
from truman_calling.core.settings import settings

log = logging.getLogger("api.audio")

router = APIRouter(prefix="/v1/runs", tags=["runs"])

RECORDING_DIR = Path("/tmp/agent-sessions")
CHUNK = 32 * 1024
POLL_INTERVAL = 0.15
TAIL_IDLE_TIMEOUT = 30.0  # stop tailing after this much silence on disk


def _auth(token: str) -> None:
    if not settings.truman_api_token or token != settings.truman_api_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")


@router.get("/{run_id}/audio.ogg")
async def run_audio_ogg(
    run_id: uuid.UUID,
    token: str = Query(..., description="TRUMAN_API_TOKEN"),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    _auth(token)

    run = (
        await session.execute(select(Run).where(Run.id == run_id))
    ).scalar_one_or_none()
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")

    usage = run.usage or {}
    session_id = usage.get("session_id")
    if not session_id:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "no recording yet — session not started (or pre-DB-tracking run)",
        )

    path = RECORDING_DIR / f"recording_{session_id}.ogg"
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"file not on disk: {path.name}")

    terminal = run.status in {"done", "failed"}

    async def stream():
        last_size = 0
        idle = 0.0
        try:
            with path.open("rb") as f:
                while True:
                    data = f.read(CHUNK)
                    if data:
                        last_size += len(data)
                        idle = 0.0
                        yield data
                        continue

                    # No new bytes right now. If the run is already terminal,
                    # we've sent everything written before close — exit.
                    if terminal:
                        return

                    await asyncio.sleep(POLL_INTERVAL)
                    idle += POLL_INTERVAL

                    # Re-check the run status periodically to detect terminal
                    # transitions while we're tailing.
                    if idle >= 2.0:
                        idle_check = (
                            await session.execute(
                                select(Run.status).where(Run.id == run_id)
                            )
                        ).scalar_one()
                        if idle_check in {"done", "failed"}:
                            # Drain any final bytes the recorder wrote between
                            # the last read and the status flip, then stop.
                            tail = f.read()
                            if tail:
                                yield tail
                            return
                        idle = 0.0

                    if last_size == 0 and idle > TAIL_IDLE_TIMEOUT:
                        return  # never got any bytes
        except Exception:
            log.exception("audio stream errored mid-flight")
            return

    return StreamingResponse(
        stream(),
        media_type="audio/ogg",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "X-Accel-Buffering": "no",
        },
    )
