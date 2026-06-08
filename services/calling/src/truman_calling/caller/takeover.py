"""Live takeover bridge — "Step on stage".

Per-run state that lets a dashboard user mute the persona's TTS output and
inject their own microphone audio into the leg going to the agent under test.

Wire format on Redis pubsub:

  truman:takeover:{run_id}        control (JSON) — start / stop
  truman:takeover_audio:{run_id}  binary 16-bit LE PCM @ 8 kHz (raw, no tag)

During an active takeover:
  - persona TTS frames coming through audio_tap are dropped (the listener
    does not get a mic loopback; the dashboard mic meter already shows local
    level)
  - mic frames arriving on truman:takeover_audio:{run_id} are pushed straight
    into the inner AudioStreamAudioSource so the callee hears them
"""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from livekit import rtc
from redis.asyncio import Redis

from truman_calling.caller.config import AUDIO_SAMPLE_RATE
from truman_calling.core.queue import publish_event
from truman_calling.core.settings import settings

log = logging.getLogger("caller.takeover")


def _control_channel(run_id: str) -> str:
    return f"truman:takeover:{run_id}"


def _audio_channel(run_id: str) -> str:
    return f"truman:takeover_audio:{run_id}"


# 20 ms of PCM16 mono @ 8 kHz = 160 samples = 320 bytes.
FRAME_BYTES = (AUDIO_SAMPLE_RATE // 50) * 2
MIN_TRANSCRIBE_BYTES = FRAME_BYTES * 25
DIRECTOR_SILENCE_TRANSCRIBE_SEC = 0.8
PERSONA_SUPPRESSION_GRACE_SEC = 1.5

DirectorTranscriptCallback = Callable[[str, float, float], Awaitable[None]]
EndCallCallback = Callable[[], Awaitable[None]]


@dataclass
class TakeoverBridge:
    run_id: str
    inner_audio_source: Any  # AudioStreamAudioSource — has capture_frame(rtc.AudioFrame)
    orig_capture_frame: Callable[[rtc.AudioFrame], Awaitable[None]]
    on_interrupt: Callable[[], Awaitable[None]] | None = None
    on_end_call: EndCallCallback | None = None
    on_director_transcript: DirectorTranscriptCallback | None = None
    session_started_at: float | None = None
    active: bool = False
    _tasks: list[asyncio.Task] = field(default_factory=list)
    _audio_buf: bytearray = field(default_factory=bytearray)
    _segment_pcm: bytearray = field(default_factory=bytearray)
    _segment_started_at: float | None = None
    _segment_silence_task: asyncio.Task | None = None
    _segment_index: int = 0
    _persona_suppressed_until: float = 0.0
    _closed: bool = False
    _injected_frames: int = 0

    def suppresses_persona(self) -> bool:
        return self.active or time.monotonic() < self._persona_suppressed_until

    async def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._run_control_listener()))
        self._tasks.append(asyncio.create_task(self._run_audio_listener()))
        log.info("takeover bridge started for run %s", self.run_id)

    async def close(self) -> None:
        if self.active:
            await self._handle_stop()
        self._closed = True
        self._cancel_segment_silence_timer()
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()

    async def _run_control_listener(self) -> None:
        redis = Redis.from_url(settings.redis_url, decode_responses=True)
        pubsub = redis.pubsub()
        channel = _control_channel(self.run_id)
        try:
            await pubsub.subscribe(channel)
            while not self._closed:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=30.0)
                if msg is None:
                    continue
                try:
                    payload = json.loads(msg["data"]) if isinstance(msg["data"], str) else {}
                except Exception:
                    continue
                kind = payload.get("type")
                if kind == "takeover_start":
                    await self._handle_start()
                elif kind == "takeover_stop":
                    await self._handle_stop()
                elif kind == "end_call":
                    await self._handle_end_call()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("takeover control listener crashed for run %s", self.run_id)
        finally:
            try:
                await pubsub.unsubscribe(channel)
                await pubsub.close()
                await redis.aclose()
            except Exception:
                pass

    async def _run_audio_listener(self) -> None:
        redis = Redis.from_url(settings.redis_url, decode_responses=False)
        pubsub = redis.pubsub()
        channel = _audio_channel(self.run_id).encode()
        try:
            await pubsub.subscribe(channel)
            while not self._closed:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=30.0)
                if msg is None:
                    continue
                data = msg.get("data")
                if not data:
                    continue
                if not self.active:
                    continue
                self._audio_buf.extend(data)
                while len(self._audio_buf) >= FRAME_BYTES:
                    chunk = bytes(self._audio_buf[:FRAME_BYTES])
                    del self._audio_buf[:FRAME_BYTES]
                    await self._inject_frame(chunk)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("takeover audio listener crashed for run %s", self.run_id)
        finally:
            try:
                await pubsub.unsubscribe(channel)
                await pubsub.close()
                await redis.aclose()
            except Exception:
                pass

    async def _inject_frame(self, pcm: bytes) -> None:
        try:
            samples = len(pcm) // 2
            frame = rtc.AudioFrame(
                pcm,
                sample_rate=AUDIO_SAMPLE_RATE,
                num_channels=1,
                samples_per_channel=samples,
            )
            await self.orig_capture_frame(frame)
            if not self._segment_pcm:
                self._segment_started_at = time.monotonic()
            self._segment_pcm.extend(pcm)
            self._schedule_segment_silence_timer()
            self._injected_frames += 1
            if self._injected_frames == 1 or self._injected_frames % 50 == 0:
                log.info(
                    "takeover injected %d frames for run %s",
                    self._injected_frames,
                    self.run_id,
                )
        except Exception:
            log.exception("takeover inject failed for run %s", self.run_id)

    async def _handle_start(self) -> None:
        if self.active:
            return
        self.active = True
        self._injected_frames = 0
        self._audio_buf.clear()
        self._segment_pcm.clear()
        self._segment_started_at = None
        self._cancel_segment_silence_timer()
        self._persona_suppressed_until = 0.0
        try:
            # Cut off any in-flight persona speech immediately.
            if hasattr(self.inner_audio_source, "clear_queue"):
                self.inner_audio_source.clear_queue()
        except Exception:
            log.warning("clear_queue on takeover start failed", exc_info=True)
        if self.on_interrupt is not None:
            try:
                await self.on_interrupt()
            except Exception:
                log.warning("on_interrupt callback failed", exc_info=True)
        log.info("takeover ACTIVE for run %s", self.run_id)
        try:
            await publish_event(
                self.run_id,
                {"type": "takeover", "state": "active"},
            )
        except Exception:
            pass

    async def _handle_stop(self) -> None:
        if not self.active:
            return
        self.active = False
        segment_ended_at = time.monotonic()
        self._persona_suppressed_until = segment_ended_at + PERSONA_SUPPRESSION_GRACE_SEC
        self._audio_buf.clear()
        await self._finalize_director_segment(segment_ended_at, reason="handoff")
        log.info(
            "takeover ENDED for run %s after %d injected frames",
            self.run_id,
            self._injected_frames,
        )
        try:
            await publish_event(
                self.run_id,
                {"type": "takeover", "state": "idle"},
            )
        except Exception:
            pass

    def _cancel_segment_silence_timer(self) -> None:
        task = self._segment_silence_task
        if task is None:
            return
        self._segment_silence_task = None
        if task.done() or task is asyncio.current_task():
            return
        task.cancel()

    def _schedule_segment_silence_timer(self) -> None:
        self._cancel_segment_silence_timer()
        self._segment_silence_task = asyncio.create_task(self._flush_segment_after_silence())

    async def _flush_segment_after_silence(self) -> None:
        try:
            await asyncio.sleep(DIRECTOR_SILENCE_TRANSCRIBE_SEC)
            await self._finalize_director_segment(time.monotonic(), reason="silence")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("takeover silence transcript flush failed for run %s", self.run_id)

    async def _finalize_director_segment(self, ended_at: float, *, reason: str) -> None:
        self._cancel_segment_silence_timer()
        segment_pcm = bytes(self._segment_pcm)
        segment_started_at = self._segment_started_at
        self._segment_pcm.clear()
        self._segment_started_at = None

        if len(segment_pcm) < MIN_TRANSCRIBE_BYTES:
            return

        self._segment_index += 1
        log.info(
            "takeover director segment %d closed by %s for run %s (%d bytes)",
            self._segment_index,
            reason,
            self.run_id,
            len(segment_pcm),
        )
        asyncio.create_task(
            self._transcribe_director_segment(
                segment_pcm,
                segment_started_at or ended_at,
                ended_at,
                self._segment_index,
            )
        )

    async def _handle_end_call(self) -> None:
        if self.active:
            await self._handle_stop()
        try:
            if hasattr(self.inner_audio_source, "clear_queue"):
                self.inner_audio_source.clear_queue()
        except Exception:
            log.warning("clear_queue on end call failed", exc_info=True)
        if self.on_end_call is not None:
            await self.on_end_call()
        log.info("end call requested for run %s", self.run_id)
        try:
            await publish_event(
                self.run_id,
                {"type": "status", "status": "ending"},
            )
        except Exception:
            pass

    async def _transcribe_director_segment(
        self,
        pcm: bytes,
        started_at: float,
        ended_at: float,
        segment_index: int,
    ) -> None:
        if self.on_director_transcript is None:
            return

        wav_path = _write_pcm_wav(self.run_id, segment_index, pcm)
        try:
            from truman_calling.caller.eval import transcribe_with_deepgram

            response = await transcribe_with_deepgram(wav_path)
            text = _extract_transcript_text(response)
            if not text:
                log.info(
                    "takeover transcript empty for run %s segment %d",
                    self.run_id,
                    segment_index,
                )
                return
            base = self.session_started_at
            start_ts = started_at - base if base is not None else 0.0
            end_ts = ended_at - base if base is not None else start_ts
            await self.on_director_transcript(text, start_ts, end_ts)
            log.info(
                "takeover transcript captured for run %s segment %d: %s",
                self.run_id,
                segment_index,
                text[:120],
            )
        except Exception:
            log.exception(
                "takeover transcript failed for run %s segment %d",
                self.run_id,
                segment_index,
            )
        finally:
            try:
                wav_path.unlink(missing_ok=True)
            except Exception:
                pass


def _write_pcm_wav(run_id: str, segment_index: int, pcm: bytes) -> Path:
    with tempfile.NamedTemporaryFile(
        prefix=f"truman-takeover-{run_id}-{segment_index}-",
        suffix=".wav",
        delete=False,
    ) as f:
        path = Path(f.name)

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(AUDIO_SAMPLE_RATE)
        wav.writeframes(pcm)
    return path


def _extract_transcript_text(response: dict[str, Any]) -> str:
    utterances = response.get("results", {}).get("utterances") or []
    texts = [
        str(utt.get("transcript") or "").strip()
        for utt in utterances
        if str(utt.get("transcript") or "").strip()
    ]
    if texts:
        return " ".join(texts).strip()

    channels = response.get("results", {}).get("channels") or []
    if not channels:
        return ""
    alternatives = channels[0].get("alternatives") or []
    if not alternatives:
        return ""
    return str(alternatives[0].get("transcript") or "").strip()


_bridges: dict[str, TakeoverBridge] = {}


def register(bridge: TakeoverBridge) -> None:
    _bridges[bridge.run_id] = bridge


def get(run_id: str) -> TakeoverBridge | None:
    return _bridges.get(run_id)


def unregister(run_id: str) -> None:
    _bridges.pop(run_id, None)
