"""Redis Streams consumer that triggers Plivo outbound calls for queued Runs."""

from __future__ import annotations

import asyncio
import logging
import socket
import uuid

import plivo

from truman_calling.caller.config import settings
from truman_calling.caller.run_orchestrator import load_run, mark_run_status
from truman_calling.core.queue import PLACE_CALL_GROUP, PLACE_CALL_STREAM, ack, consume

log = logging.getLogger("caller.worker")


def _consumer_name() -> str:
    return f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}"


async def _handle_job(payload: dict, plivo_client: plivo.RestClient) -> None:
    raw_run_id = payload.get("run_id")
    if not raw_run_id:
        log.warning("missing run_id in payload: %s", payload)
        return
    run_id = uuid.UUID(raw_run_id)

    try:
        loaded = await load_run(run_id)
    except Exception as e:
        log.exception("failed to load run %s: %s", run_id, e)
        await mark_run_status(run_id, "failed", error=f"load_run: {e}")
        return

    # Re-check status immediately before dialing: a run can be cancelled while it
    # sits in the queue, or the stream message can be re-delivered after a worker
    # crash once the call is already placed. Only "queued" runs should be dialed —
    # anything else means we'd double-dial or revive a cancelled run.
    if loaded.run.status != "queued":
        log.info(
            "skipping dial for run %s: status is %r, not 'queued'",
            run_id,
            loaded.run.status,
        )
        return

    target = loaded.agent.phone_number
    answer_url = f"{settings.public_answer_url}?run_id={run_id}"
    # Do not log the dialed phone number (target) in clear text — CodeQL flags
    # it as sensitive. run_id + answer_url are enough to trace a call.
    log.info("place_call: run_id=%s answer_url=%s", run_id, answer_url)

    try:
        resp = plivo_client.calls.create(
            from_=settings.plivo_from_number,
            to_=target,
            answer_url=answer_url,
            answer_method="POST",
            hangup_url=f"{settings.public_base_url.rstrip('/')}/hangup?run_id={run_id}",
            hangup_method="POST",
            caller_name="Truman",
        )
    except Exception as e:
        log.exception("plivo dial failed for run %s: %s", run_id, e)
        await mark_run_status(run_id, "failed", ended_at=True, error=f"plivo: {e}")
        return

    request_uuid = getattr(resp, "request_uuid", None) or (
        resp["request_uuid"] if "request_uuid" in resp else None
    )
    try:
        await mark_run_status(
            run_id, "dialing", started_at=True, plivo_call_uuid=request_uuid
        )
    except Exception:
        log.exception("failed to mark run dialing (call already placed)")
    log.info("plivo call queued: request_uuid=%s", request_uuid)


async def run_consumer_loop() -> None:
    log.info("worker starting, consuming from %s", PLACE_CALL_STREAM)
    plivo_client = plivo.RestClient(settings.plivo_auth_id, settings.plivo_auth_token)
    consumer = _consumer_name()
    async for msg_id, payload in consume(
        PLACE_CALL_STREAM, PLACE_CALL_GROUP, consumer
    ):
        try:
            await _handle_job(payload, plivo_client)
        except Exception as e:
            log.exception("unhandled error in worker: %s", e)
        finally:
            await ack(PLACE_CALL_STREAM, PLACE_CALL_GROUP, msg_id)


def start_in_background(loop: asyncio.AbstractEventLoop | None = None) -> asyncio.Task:
    loop = loop or asyncio.get_event_loop()
    return loop.create_task(run_consumer_loop(), name="truman-caller-worker")
