from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

from aiohttp import web as aiohttp_web
from agent_transport.audio_stream.livekit import (
    AudioStreamServer,
    JobContext,
    JobProcess,
)
from livekit.agents import (
    AgentSession,
    InterruptionOptions,
    TurnHandlingOptions,
)
from livekit.plugins import silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from truman_calling.caller import takeover as takeover_mod
from truman_calling.caller.config import AUDIO_SAMPLE_RATE, settings
from truman_calling.caller.persona_agent import PersonaAgent
from truman_calling.caller.personas.priya_order_status import (
    LANGUAGE as SPIKE_PERSONA_LANGUAGE,
    OPENER_INSTRUCTIONS as SPIKE_OPENER,
    PERSONA_PROMPT as SPIKE_PROMPT,
)
from truman_calling.caller.audio_tap import attach as attach_audio_tap
from truman_calling.caller.plugins import build_llm, build_stt, build_tts
from truman_calling.caller.run_orchestrator import (
    LoadedRun,
    load_run,
    mark_run_status,
    merge_run_usage,
    render_template,
)
from truman_calling.core.queue import publish_event

os.environ.setdefault("PORT", str(settings.http_port))
os.environ.setdefault("AUDIO_STREAM_ADDR", f"{settings.http_host}:{settings.audio_stream_port}")

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger("truman.caller")

MAX_CALL_DURATION_SEC = 180.0
SILENCE_HANGUP_DELAY_SEC = 20.0


class TrumanServer(AudioStreamServer):
    def _build_http_app(self):
        app = super()._build_http_app()
        app.add_routes(
            [
                aiohttp_web.post("/answer", handle_answer),
                aiohttp_web.get("/answer", handle_answer),
                aiohttp_web.post("/recording-callback", handle_recording_callback),
                aiohttp_web.post("/record-ack", handle_record_ack),
                aiohttp_web.post("/hangup", handle_hangup),
            ]
        )
        return app


server = TrumanServer(listen_addr=f"{settings.http_host}:{settings.audio_stream_port}")


@server.setup()
def prewarm(proc: JobProcess) -> None:
    log.info("prewarm: loading silero VAD + multilingual turn detector")
    proc.userdata["vad"] = silero.VAD.load(sample_rate=AUDIO_SAMPLE_RATE)
    proc.userdata["turn_detector"] = MultilingualModel()

    try:
        from truman_calling.caller.worker import start_in_background

        proc.userdata["worker_task"] = start_in_background()
        log.info("worker consumer task started")
    except Exception:
        log.exception("worker startup failed — API-triggered runs will not fire")

    log.info("prewarm done")


@server.audio_stream_session()
async def persona_session(ctx: JobContext) -> None:
    extra = dict(getattr(ctx, "extra_headers", {}))
    call_uuid = getattr(ctx, "plivo_call_uuid", "?")
    log.info(
        "session opened: call_uuid=%s stream_id=%s extra_headers=%s",
        call_uuid,
        getattr(ctx, "stream_id", "?"),
        extra,
    )

    run_id_raw = extra.get("X-PH-run_id") or extra.get("run_id")
    loaded: LoadedRun | None = None
    persona_prompt = SPIKE_PROMPT
    opener_instructions = SPIKE_OPENER
    persona_language = SPIKE_PERSONA_LANGUAGE
    voice_id = settings.elevenlabs_voice_id

    if run_id_raw:
        try:
            run_id = uuid.UUID(run_id_raw)
            loaded = await load_run(run_id)
            vars_map = dict(loaded.profile.variables) if loaded.profile else {}
            persona_prompt = render_template(loaded.persona.prompt, vars_map)
            opener_instructions = render_template(loaded.scenario.opener_instructions, vars_map)
            persona_language = loaded.persona.language
            voice_id = loaded.persona.voice_id
            await mark_run_status(
                run_id, "live", plivo_call_uuid=call_uuid if call_uuid != "?" else None
            )
            log.info(
                "run loaded from db: run_id=%s persona=%s scenario=%s",
                run_id,
                loaded.persona.name,
                loaded.scenario.name,
            )
        except Exception:
            log.exception("failed to load run %s; falling back to spike persona", run_id_raw)
            loaded = None

    agent = PersonaAgent(
        persona_prompt=persona_prompt,
        opener_instructions=opener_instructions,
        stt=build_stt(language=persona_language),
        llm=build_llm(),
        tts=build_tts(language=persona_language, voice_id_override=voice_id),
    )

    ctx.session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        turn_handling=TurnHandlingOptions(
            turn_detection=ctx.proc.userdata["turn_detector"],
            interruption=InterruptionOptions(enabled=True, mode="vad"),
        ),
        user_away_timeout=SILENCE_HANGUP_DELAY_SEC,
    )

    transcript_key = (
        str(loaded.run.id) if loaded else (call_uuid if call_uuid != "?" else getattr(ctx, "stream_id", "unknown"))
    )
    transcript_path = settings.transcripts_dir / f"{transcript_key}.live.txt"
    transcript_path.write_text("")
    turns: list[str] = []
    session_start = time.monotonic()

    def _flush_transcript() -> None:
        transcript_path.write_text("\n".join(_timeline_sorted_turns(turns)) + "\n")

    def _takeover_suppresses_persona() -> bool:
        if not loaded:
            return False
        bridge = takeover_mod.get(str(loaded.run.id))
        return bridge is not None and bridge.suppresses_persona()

    async def _on_director_transcript(text: str, start_ts: float, end_ts: float) -> None:
        ts = round(end_ts, 2)
        line = json.dumps(
            {
                "role": "director",
                "text": text,
                "ts": ts,
                "start_ts": round(start_ts, 2),
                "source": "takeover",
            },
            ensure_ascii=False,
        )
        turns.append(line)
        log.info("turn[director @ %.2fs] %s", ts, text[:120])
        _flush_transcript()
        if loaded:
            await publish_event(
                str(loaded.run.id),
                {
                    "type": "turn",
                    "role": "director",
                    "text": text,
                    "ts": ts,
                    "start_ts": round(start_ts, 2),
                    "source": "takeover",
                },
            )

    @ctx.session.on("conversation_item_added")
    def _on_item(ev: Any) -> None:
        try:
            item = getattr(ev, "item", ev)
            role = getattr(item, "role", "?")
            content = getattr(item, "content", "") or getattr(item, "text_content", "")
            if isinstance(content, (list, tuple)):
                content = " ".join(str(c) for c in content)
            text = str(content).strip()
            if not text:
                return
            if loaded and role == "assistant" and _takeover_suppresses_persona():
                log.info(
                    "suppressed simulator assistant transcript during takeover for run %s",
                    loaded.run.id,
                )
                return
            ts = round(time.monotonic() - session_start, 2)
            # JSON-lines persistence so the UI can render real timestamps later.
            # Each line is independently parseable; legacy "role: text" lines are
            # still accepted by the frontend fallback parser.
            line = json.dumps({"role": role, "text": text, "ts": ts}, ensure_ascii=False)
            turns.append(line)
            log.info("turn[%s @ %.2fs] %s", role, ts, text[:120])
            _flush_transcript()
            if loaded:
                asyncio.create_task(
                    publish_event(
                        str(loaded.run.id),
                        # final=True → the committed turn; the UI replaces any live
                        # partial bubble of the same role with this finalized text.
                        {"type": "turn", "role": role, "text": text, "ts": ts, "final": True},
                    )
                )
        except Exception:
            log.exception("transcript hook failed")

    @ctx.session.on("user_input_transcribed")
    def _on_user_interim(ev: Any) -> None:
        # Stream the agent-under-test's (remote callee, role="user") speech LIVE.
        # conversation_item_added only fires once a turn is finalized, so without
        # this the agent's reply never appears while it is still speaking — only
        # the persona/caller (local agent, role="assistant") shows promptly. We
        # publish interim frames only (final=False); the committed turn still
        # arrives via conversation_item_added above (final=True), which the UI
        # uses to replace the partial. Interim text is NOT persisted to the
        # transcript file, so the stored transcript + post-call eval stay clean.
        try:
            if getattr(ev, "is_final", False):
                return  # committed turn comes via conversation_item_added
            text = str(getattr(ev, "transcript", "") or "").strip()
            if not text or not loaded:
                return
            ts = round(time.monotonic() - session_start, 2)
            asyncio.create_task(
                publish_event(
                    str(loaded.run.id),
                    {"type": "turn", "role": "user", "text": text, "ts": ts, "final": False},
                )
            )
        except Exception:
            log.exception("interim transcript hook failed")

    hangup_task: asyncio.Task | None = None

    async def _hangup_after(delay: float, reason: str) -> None:
        try:
            await asyncio.sleep(delay)
            if _takeover_suppresses_persona():
                log.info(
                    "hangup skipped while takeover controls run %s",
                    loaded.run.id if loaded else "?",
                )
                return
            log.info("hangup: %s (after %.1fs)", reason, delay)
            await ctx.session.aclose()
        except asyncio.CancelledError:
            pass

    @ctx.session.on("user_state_changed")
    def _on_user_state(ev: Any) -> None:
        nonlocal hangup_task
        new_state = getattr(ev, "new_state", "?")
        log.info("user_state_changed: %s", new_state)
        if new_state == "away" and (hangup_task is None or hangup_task.done()):
            if _takeover_suppresses_persona():
                log.info(
                    "user away ignored while takeover controls run %s",
                    loaded.run.id if loaded else "?",
                )
                return
            hangup_task = asyncio.create_task(
                _hangup_after(0.0, "callee silent past user_away_timeout"),
            )

    max_call_duration = (
        loaded.scenario.max_call_duration_seconds
        if loaded and loaded.scenario.max_call_duration_seconds > 0
        else MAX_CALL_DURATION_SEC
    )
    max_duration_task = asyncio.create_task(
        _hangup_after(max_call_duration, "max call duration"),
    )
    ctx.add_shutdown_callback(lambda: max_duration_task.cancel())

    if loaded:
        session_started_at = time.monotonic()

        async def _persist_usage_on_close() -> None:
            from truman_calling.core.pricing import compute_cost

            try:
                usage = getattr(ctx.session, "usage", None)
                plivo_seconds = time.monotonic() - session_started_at
                breakdown = compute_cost(
                    agent_session_usage=usage, plivo_seconds=plivo_seconds
                )
                payload = breakdown.to_dict()
                payload["session_id"] = getattr(ctx, "session_id", None)
                # Ride the caller agent's LiveKit conversation (with inline per-turn
                # metrics: llm_node_ttft / tts_node_ttfb / transcription_delay /
                # end_of_turn_delay / e2e_latency + interrupted) into runs.usage so
                # AO can build a Monitor session for this call. Same JSONB merge as
                # cost → one write, no extra column, no race with a second callback.
                try:
                    items = [it.model_dump(mode="json") for it in ctx.session.history.items]
                    payload["chat_history"] = [
                        {
                            "id": it.get("id"),
                            "type": it.get("type", "message"),
                            "role": it.get("role"),
                            "content": it.get("content"),
                            "interrupted": bool(it.get("interrupted")),
                            "transcript_confidence": it.get("transcript_confidence"),
                            "metrics": it.get("metrics"),
                        }
                        for it in items
                        if it.get("type", "message") == "message"
                    ]
                    # Token counts (not on ChatMessage.metrics) are omitted for now;
                    # the latency metrics all ride on chat_history above.
                    payload["session_metrics"] = {"per_turn": [], "usage": []}
                except Exception:
                    log.exception("failed to build session chat_history for run %s", loaded.run.id)
                await merge_run_usage(loaded.run.id, payload)
                log.info(
                    "usage persisted for run %s: total=%d cents (llm=%.2f tts=%.2f stt=%.2f plivo=%.2f)",
                    loaded.run.id,
                    breakdown.total_cents,
                    breakdown.llm["cents"],
                    breakdown.tts["cents"],
                    breakdown.stt["cents"],
                    breakdown.plivo["cents"],
                )
            except Exception:
                log.exception("failed to persist run usage on close")

        ctx.add_shutdown_callback(_persist_usage_on_close)

    if loaded:
        try:
            session_id = getattr(ctx, "session_id", None)
            if session_id:
                await merge_run_usage(loaded.run.id, {"session_id": session_id})
                log.info(
                    "stored session_id=%s for run %s (ogg path /tmp/agent-sessions/recording_%s.ogg)",
                    session_id,
                    loaded.run.id,
                    session_id,
                )
        except Exception:
            log.exception("failed to store session_id on run")

    log.info("starting session with PersonaAgent")
    await ctx.session.start(room=ctx.room, agent=agent)
    log.info("session.start returned (session running in background)")

    if loaded:
        try:
            attach_audio_tap(
                ctx,
                str(loaded.run.id),
                on_director_transcript=_on_director_transcript,
                session_started_at=session_start,
            )
        except Exception:
            log.exception("audio tap setup failed (live audio will be unavailable)")


async def handle_answer(request: aiohttp_web.Request) -> aiohttp_web.Response:
    public_ws = settings.public_ws_url
    cb_url = settings.public_recording_callback_url
    ack_url = f"{settings.public_base_url.rstrip('/')}/record-ack"
    run_id = request.query.get("run_id", "")

    extra_pairs = ["new_call=true"]
    if run_id:
        extra_pairs.append(f"run_id={run_id}")
        # forward run_id on the recording-callback so the eval pipeline can locate the run
        cb_url = f"{cb_url}?run_id={run_id}"
    extra_headers = ",".join(extra_pairs)

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f'<Stream bidirectional="true" keepCallAlive="true"'
        f' contentType="audio/x-l16;rate={AUDIO_SAMPLE_RATE}"'
        f' extraHeaders="{extra_headers}">{public_ws}</Stream>'
        f'<Record action="{ack_url}" callbackUrl="{cb_url}" callbackMethod="POST"'
        ' recordSession="true" fileFormat="wav" maxLength="600" redirect="false"/>'
        "</Response>"
    )
    log.info("answer XML served (peer=%s run_id=%s)", request.remote, run_id or "—")
    return aiohttp_web.Response(text=xml, content_type="application/xml")


async def handle_record_ack(request: aiohttp_web.Request) -> aiohttp_web.Response:
    log.info("record-ack hit (no-op)")
    return aiohttp_web.Response(
        text='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        content_type="application/xml",
    )


async def handle_hangup(request: aiohttp_web.Request) -> aiohttp_web.Response:
    data = await request.post()
    run_id = request.query.get("run_id")
    log.info(
        "hangup callback: run_id=%s call_uuid=%s duration=%s status=%s hangup_cause=%s",
        run_id,
        data.get("CallUUID"),
        data.get("Duration"),
        data.get("CallStatus"),
        data.get("HangupCause"),
    )
    if run_id:
        try:
            await mark_run_status(
                uuid.UUID(run_id),
                "recording",
                ended_at=True,
                plivo_call_uuid=data.get("CallUUID"),
            )
        except Exception:
            log.exception("failed to update run on hangup")

        # Schedule eval ~12s after hangup. If /recording-callback fires first
        # with a real RecordUrl, it'll progress the row to `evaluating` and
        # the deferred eval will see `done`/`evaluating` and bail.
        asyncio.create_task(_deferred_eval(run_id, call_uuid=data.get("CallUUID")))
    return aiohttp_web.Response(text="ok")


async def _deferred_eval(run_id: str, *, call_uuid: str | None) -> None:
    try:
        await asyncio.sleep(12.0)
        from truman_calling.caller.db import session_scope
        from truman_calling.caller.eval import process_recording_callback
        from sqlalchemy import select
        from truman_calling.core.models import Run as RunModel

        async with session_scope() as s:
            run = (
                await s.execute(
                    select(RunModel).where(RunModel.id == uuid.UUID(run_id))
                )
            ).scalar_one()
            current_status = run.status

        if current_status not in {"recording", "queued", "dialing", "live"}:
            log.info(
                "deferred eval skipped — run %s already %s", run_id, current_status
            )
            return

        log.info(
            "deferred eval firing for run %s (no /recording-callback within 12s)",
            run_id,
        )
        await process_recording_callback(
            {
                "CallUUID": call_uuid or "unknown",
                "run_id": run_id,
                # no RecordUrl → eval will fall back to the live transcript
            }
        )
    except Exception:
        log.exception("deferred eval failed for run %s", run_id)


async def handle_recording_callback(request: aiohttp_web.Request) -> aiohttp_web.Response:
    data = await request.post()
    payload = {k: v for k, v in data.items()}
    run_id = request.query.get("run_id")
    if run_id:
        payload["run_id"] = run_id
    log.info("recording-callback received: %s", payload)
    try:
        from truman_calling.caller.eval import process_recording_callback

        await process_recording_callback(payload)
    except Exception:
        log.exception("eval pipeline failed (continuing — callback ack'd)")
    return aiohttp_web.Response(text="ok")


def _timeline_sorted_turns(lines: list[str]) -> list[str]:
    indexed = list(enumerate(lines))

    def key(item: tuple[int, str]) -> tuple[int, float, int]:
        index, line = item
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return (1, 0.0, index)
        timestamp = payload.get("start_ts", payload.get("ts"))
        if isinstance(timestamp, (int, float)):
            return (0, float(timestamp), index)
        return (1, 0.0, index)

    return [line for _, line in sorted(indexed, key=key)]


if __name__ == "__main__":
    server.run()
