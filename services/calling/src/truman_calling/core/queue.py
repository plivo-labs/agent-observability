"""Lightweight Redis Streams helpers — single stream per task type."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from redis.asyncio import Redis

from truman_calling.core.settings import settings

PLACE_CALL_STREAM = "truman:place_call"
PLACE_CALL_GROUP = "callers"


async def get_redis() -> Redis:
    return Redis.from_url(settings.redis_url, decode_responses=True)


async def publish(stream: str, payload: dict[str, Any]) -> str:
    redis = await get_redis()
    try:
        msg_id: str = await redis.xadd(stream, {"data": json.dumps(payload)})
        return msg_id
    finally:
        await redis.aclose()


async def ensure_group(redis: Redis, stream: str, group: str) -> None:
    try:
        await redis.xgroup_create(stream, group, id="0", mkstream=True)
    except Exception as exc:  # BUSYGROUP if already exists
        if "BUSYGROUP" not in str(exc):
            raise


async def consume(
    stream: str,
    group: str,
    consumer: str,
    *,
    block_ms: int = 5000,
    count: int = 1,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Yield (message_id, payload_dict) tuples. Caller must `ack` each id."""
    redis = await get_redis()
    await ensure_group(redis, stream, group)
    try:
        while True:
            resp = await redis.xreadgroup(
                groupname=group,
                consumername=consumer,
                streams={stream: ">"},
                count=count,
                block=block_ms,
            )
            if not resp:
                continue
            for _, entries in resp:
                for msg_id, fields in entries:
                    payload = json.loads(fields["data"])
                    yield msg_id, payload
    finally:
        await redis.aclose()


async def ack(stream: str, group: str, msg_id: str) -> None:
    redis = await get_redis()
    try:
        await redis.xack(stream, group, msg_id)
    finally:
        await redis.aclose()


def run_event_channel(run_id: str) -> str:
    """Pub/Sub channel name for live updates of a single run."""
    return f"truman:run:{run_id}"


async def publish_event(run_id: str, event: dict[str, Any]) -> None:
    redis = await get_redis()
    try:
        await redis.publish(run_event_channel(run_id), json.dumps(event))
    finally:
        await redis.aclose()
