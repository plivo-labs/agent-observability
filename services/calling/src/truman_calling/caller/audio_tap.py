"""Mid-call audio tap + takeover bridge attachment point.

Hooks agent-transport's AudioStreamInput + AudioStreamOutput to fork every
audio frame to a per-run Redis pubsub channel. The API tier subscribes and
forwards bytes to the dashboard over WebSocket.

Frame format on the wire:
  byte 0          direction tag (0x01 = persona / TTS out, 0x02 = callee / STT in)
  bytes 1..       raw 16-bit little-endian PCM mono at 8 kHz (one frame = 20 ms = 320 bytes)

Channel: truman:audio:{run_id}

The same hook also creates a TakeoverBridge for the run — when an operator
"steps on stage" we drop persona TTS frames here and inject mic frames
directly into the inner audio source.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any

from redis.asyncio import Redis

from truman_calling.caller import takeover as takeover_mod
from truman_calling.core.settings import settings

log = logging.getLogger("caller.audio_tap")

PERSONA_TAG = b"\x01"
CALLEE_TAG = b"\x02"

_redis: Redis | None = None
_redis_lock = asyncio.Lock()


async def _get_redis() -> Redis:
    global _redis
    if _redis is None:
        async with _redis_lock:
            if _redis is None:
                _redis = Redis.from_url(settings.redis_url, decode_responses=False)
    return _redis


def _channel(run_id: str) -> str:
    return f"truman:audio:{run_id}"


async def _publish(run_id: str, tag: bytes, pcm: bytes) -> None:
    try:
        r = await _get_redis()
        await r.publish(_channel(run_id), tag + pcm)
    except Exception:
        log.debug("audio publish dropped", exc_info=True)


def attach(
    ctx: Any,
    run_id: str,
    *,
    on_director_transcript: takeover_mod.DirectorTranscriptCallback | None = None,
    session_started_at: float | None = None,
) -> None:
    """Monkey-patch the session's audio I/O to fork frames to Redis pubsub and
    register a TakeoverBridge for live-takeover injection.

    Safe to call at most once per session. If anything below raises, the
    session keeps working — we just lose live audio for that run.
    """
    try:
        audio_in = ctx.session.input.audio
        audio_out_outer = ctx.session.output.audio
    except Exception:
        log.warning("audio tap failed: session.input/output.audio not available")
        return

    inner = _find_inner_audio_source(audio_out_outer)
    if inner is None:
        log.warning(
            "audio tap failed: could not locate inner audio source by walking"
            " next_in_chain on %s",
            type(audio_out_outer).__name__,
        )
        return

    _hook_input(audio_in, run_id)
    orig_capture = _hook_inner_source(inner, run_id)

    async def _interrupt_session() -> None:
        try:
            sess = ctx.session
            if hasattr(sess, "interrupt"):
                if hasattr(sess, "clear_user_turn"):
                    maybe_clear = sess.clear_user_turn()
                    if inspect.isawaitable(maybe_clear):
                        await maybe_clear
                try:
                    maybe = sess.interrupt(force=True)
                except TypeError:
                    maybe = sess.interrupt()
                if inspect.isawaitable(maybe):
                    await maybe
        except Exception:
            log.warning("session interrupt failed during takeover start", exc_info=True)

    async def _end_call() -> None:
        try:
            await ctx.session.aclose()
        except Exception:
            log.warning("session close failed during end-call request", exc_info=True)

    bridge = takeover_mod.TakeoverBridge(
        run_id=run_id,
        inner_audio_source=inner,
        orig_capture_frame=orig_capture,
        on_interrupt=_interrupt_session,
        on_end_call=_end_call,
        on_director_transcript=on_director_transcript,
        session_started_at=session_started_at,
    )
    takeover_mod.register(bridge)
    asyncio.create_task(bridge.start())

    def _cleanup() -> None:
        takeover_mod.unregister(run_id)
        asyncio.create_task(bridge.close())

    try:
        ctx.add_shutdown_callback(lambda: _cleanup())
    except Exception:
        log.debug("could not register takeover shutdown callback", exc_info=True)

    log.info(
        "audio tap attached for run %s (inner tap=%s)",
        run_id,
        type(inner).__name__,
    )


def _find_inner_audio_source(audio_out: Any, max_depth: int = 8) -> Any | None:
    """LiveKit Agents wraps our AudioStreamOutput in _SyncedAudioOutput (and
    sometimes other middleware) via next_in_chain. Walk down to find the
    object that owns `_audio_source` (the Rust-paced sink)."""
    cur = audio_out
    for _ in range(max_depth):
        if cur is None:
            return None
        src = getattr(cur, "_audio_source", None)
        if src is not None:
            return src
        nxt = getattr(cur, "next_in_chain", None)
        if nxt is None or nxt is cur:
            return None
        cur = nxt
    return None


def _hook_input(audio_in: Any, run_id: str) -> None:
    """Tap the inbound Chan. AudioStreamInput pushes every received frame via
    `_data_ch.send(frame)` — wrap that and publish frame.data before forwarding."""
    chan = audio_in._data_ch
    orig_send = chan.send
    logged_first = [False]
    logged_suppressed = [False]

    async def tapped_send(value: Any) -> None:
        try:
            data = getattr(value, "data", None)
            if data:
                if not logged_first[0]:
                    log.info(
                        "input first frame: sr=%s ch=%s samples=%s bytes=%s",
                        getattr(value, "sample_rate", "?"),
                        getattr(value, "num_channels", "?"),
                        getattr(value, "samples_per_channel", "?"),
                        len(bytes(data)),
                    )
                    logged_first[0] = True
                asyncio.create_task(_publish(run_id, CALLEE_TAG, bytes(data)))
        except Exception:
            log.debug("input tap publish failed", exc_info=True)

        bridge = takeover_mod.get(run_id)
        if bridge is not None and bridge.active:
            if not logged_suppressed[0]:
                log.info("simulator input paused during takeover for run %s", run_id)
                logged_suppressed[0] = True
            return

        return await orig_send(value)

    chan.send = tapped_send


def _hook_inner_source(inner: Any, run_id: str):
    """Tap the realtime-paced inner audio source. The outer AudioOutput in
    LiveKit Agents receives TTS chunks faster than realtime (TTS plugins
    burst-emit ~seconds of audio in ms); the inner AudioStreamAudioSource is
    backpressured by Rust to Plivo's wire rate.

    Returns the *original* capture_frame so the takeover bridge can call it
    directly (bypassing the dropping logic) when injecting mic audio.
    """
    orig_capture = inner.capture_frame
    logged_first = [False]

    async def tapped_capture(frame: Any) -> None:
        # During live takeover, drop persona TTS so the callee only hears the
        # human operator. The bridge injects its own frames through
        # `orig_capture` directly.
        bridge = takeover_mod.get(run_id)
        if bridge is not None and bridge.suppresses_persona():
            return

        try:
            data = getattr(frame, "data", None)
            if data:
                if not logged_first[0]:
                    log.info(
                        "output first frame: sr=%s ch=%s samples=%s bytes=%s",
                        getattr(frame, "sample_rate", "?"),
                        getattr(frame, "num_channels", "?"),
                        getattr(frame, "samples_per_channel", "?"),
                        len(bytes(data)),
                    )
                    logged_first[0] = True
                asyncio.create_task(_publish(run_id, PERSONA_TAG, bytes(data)))
        except Exception:
            log.debug("output tap publish failed", exc_info=True)
        return await orig_capture(frame)

    inner.capture_frame = tapped_capture
    return orig_capture
