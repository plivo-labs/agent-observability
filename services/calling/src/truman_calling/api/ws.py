"""WebSocket endpoint that bridges Redis pubsub (caller's live events) to clients.

Authentication: client connects with `?token=<TRUMAN_API_TOKEN>` because browser
WebSocket APIs can't set Authorization headers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from redis.asyncio import Redis

from truman_calling.core.queue import run_event_channel
from truman_calling.core.settings import settings

log = logging.getLogger("api.ws")

router = APIRouter(prefix="/v1/runs", tags=["runs"])


@router.websocket("/{run_id}/stream")
async def run_stream(
    websocket: WebSocket,
    run_id: uuid.UUID,
    token: str = Query(..., description="TRUMAN_API_TOKEN — query string auth"),
) -> None:
    if not settings.truman_api_token or token != settings.truman_api_token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    pubsub = redis.pubsub()
    channel = run_event_channel(str(run_id))
    await pubsub.subscribe(channel)
    log.info("ws client subscribed: run=%s", run_id)

    try:
        await websocket.send_text(
            json.dumps({"type": "subscribed", "run_id": str(run_id)})
        )
        while True:
            msg_task = asyncio.create_task(pubsub.get_message(ignore_subscribe_messages=True, timeout=30.0))
            ping_task = asyncio.create_task(websocket.receive_text())
            done, pending = await asyncio.wait(
                {msg_task, ping_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()

            if ping_task in done:
                try:
                    ping_task.result()
                except WebSocketDisconnect:
                    log.info("ws client disconnected: run=%s", run_id)
                    return

            if msg_task in done:
                msg = msg_task.result()
                if msg is None:
                    continue
                data = msg.get("data")
                if data:
                    try:
                        payload = json.loads(data) if isinstance(data, str) else data
                    except json.JSONDecodeError:
                        payload = {"raw": data}
                    await websocket.send_text(json.dumps(payload))
    except WebSocketDisconnect:
        log.info("ws client disconnected: run=%s", run_id)
    finally:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.close()
            await redis.aclose()
        except Exception:
            pass


@router.websocket("/{run_id}/audio")
async def run_audio(
    websocket: WebSocket,
    run_id: uuid.UUID,
    token: str = Query(..., description="TRUMAN_API_TOKEN"),
) -> None:
    """Forwards binary audio frames (1-byte direction tag + 16-bit PCM 8 kHz)
    from Redis pubsub channel truman:audio:{run_id} to a single WS client."""
    if not settings.truman_api_token or token != settings.truman_api_token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    redis = Redis.from_url(settings.redis_url, decode_responses=False)
    pubsub = redis.pubsub()
    channel = f"truman:audio:{run_id}"
    await pubsub.subscribe(channel)
    log.info("audio ws client subscribed: run=%s", run_id)

    try:
        while True:
            msg_task = asyncio.create_task(
                pubsub.get_message(ignore_subscribe_messages=True, timeout=30.0)
            )
            ping_task = asyncio.create_task(websocket.receive_bytes())
            done, pending = await asyncio.wait(
                {msg_task, ping_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()

            if ping_task in done:
                try:
                    ping_task.result()
                except WebSocketDisconnect:
                    log.info("audio ws client disconnected: run=%s", run_id)
                    return

            if msg_task in done:
                msg = msg_task.result()
                if msg is None:
                    continue
                data = msg.get("data")
                if data:
                    await websocket.send_bytes(data)
    except WebSocketDisconnect:
        log.info("audio ws client disconnected: run=%s", run_id)
    finally:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.close()
            await redis.aclose()
        except Exception:
            pass


@router.websocket("/{run_id}/takeover/audio")
async def takeover_audio(
    websocket: WebSocket,
    run_id: uuid.UUID,
    token: str = Query(..., description="TRUMAN_API_TOKEN"),
) -> None:
    """Receives raw 16-bit LE PCM @ 8 kHz mic audio from a single browser
    client and republishes it on truman:takeover_audio:{run_id} for the
    caller bridge to inject into the live call."""
    if not settings.truman_api_token or token != settings.truman_api_token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    redis = Redis.from_url(settings.redis_url, decode_responses=False)
    channel = f"truman:takeover_audio:{run_id}"
    log.info("takeover mic ws connected: run=%s", run_id)

    try:
        while True:
            data = await websocket.receive_bytes()
            if not data:
                continue
            await redis.publish(channel, data)
    except WebSocketDisconnect:
        log.info("takeover mic ws disconnected: run=%s", run_id)
    finally:
        try:
            await redis.aclose()
        except Exception:
            pass
