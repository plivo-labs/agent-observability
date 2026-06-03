from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
from pathlib import Path

import aiohttp
from openai import AsyncAzureOpenAI

from truman_calling.caller.config import settings
from truman_calling.caller.rubrics import mamaearth_v1 as rubric
from truman_calling.core.livekit_judge import judge_transcript_text

# Truman transcript roles are inverted vs. the judge's default: the synthetic
# caller/persona speaks as "assistant" (it's the LiveKit agent); the agent-under-test
# (callee) is "user". Tell the judge which labels are the caller so it labels the
# agent-under-test as "assistant" (matching criterion phrasing).
_TRUMAN_CALLER_LABELS = {"assistant", "persona", "caller", "director", "speaker_1"}


def _criteria_from_bundled() -> list[dict]:
    return [{"key": k, "question": q} for k, q in rubric.CRITERIA]

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger("spike.eval")


def _deepgram_batch_url() -> str:
    """Convert the configured DEEPGRAM_BASE_URL (which may be wss://.../v1/listen) to https.
    Self-hosted Deepgram serves both protocols on the same host."""
    url = settings.deepgram_base_url
    if url.startswith("wss://"):
        url = "https://" + url[len("wss://") :]
    elif url.startswith("ws://"):
        url = "http://" + url[len("ws://") :]
    if "/v1/listen" not in url:
        url = url.rstrip("/") + "/v1/listen"
    return url


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()) or "unknown"


async def download_recording(record_url: str, dest: Path) -> Path:
    auth = aiohttp.BasicAuth(settings.plivo_auth_id, settings.plivo_auth_token)
    async with aiohttp.ClientSession(auth=auth) as session:
        async with session.get(record_url) as resp:
            resp.raise_for_status()
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("wb") as f:
                async for chunk in resp.content.iter_chunked(65536):
                    f.write(chunk)
    log.info("recording saved: %s (%d bytes)", dest, dest.stat().st_size)
    return dest


_CONTENT_TYPE_BY_EXT = {
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
}


async def transcribe_with_deepgram(audio_path: Path) -> dict:
    url = _deepgram_batch_url()
    params = {
        "model": settings.deepgram_model,
        "punctuate": "true",
        "language": "en",
    }
    content_type = _CONTENT_TYPE_BY_EXT.get(audio_path.suffix.lower(), "application/octet-stream")
    headers = {"Content-Type": content_type}
    if settings.deepgram_api_key and settings.deepgram_api_key != "self-hosted":
        headers["Authorization"] = f"Token {settings.deepgram_api_key}"

    log.info("transcribing %s via %s", audio_path.name, url)
    timeout = aiohttp.ClientTimeout(total=180)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        with audio_path.open("rb") as f:
            body = f.read()
        async with session.post(url, params=params, headers=headers, data=body) as resp:
            text = await resp.text()
            resp.raise_for_status()
            return json.loads(text)


def diarized_transcript_text(dg_response: dict) -> str:
    utterances = (
        dg_response.get("results", {})
        .get("utterances")
        or []
    )
    if utterances:
        lines = []
        for utt in utterances:
            speaker = utt.get("speaker", "?")
            transcript = (utt.get("transcript") or "").strip()
            if transcript:
                lines.append(f"speaker_{speaker}: {transcript}")
        if lines:
            return "\n".join(lines)

    channels = dg_response.get("results", {}).get("channels", [])
    if channels:
        alt = channels[0].get("alternatives", [{}])[0]
        return (alt.get("transcript") or "").strip()
    return ""


def director_transcript_lines(live_transcript_path: Path) -> list[str]:
    if not live_transcript_path.exists():
        return []
    rows: list[str] = []
    for line in live_transcript_path.read_text().splitlines():
        raw = line.strip()
        if not raw.startswith("{"):
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if item.get("role") != "director":
            continue
        text = str(item.get("text") or "").strip()
        if text:
            rows.append(f"director: {text}")
    return rows


def timeline_sorted_live_transcript(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""

    parsed: list[tuple[int, dict]] = []
    for index, line in enumerate(lines):
        if not line.startswith("{"):
            return text.strip()
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return text.strip()
        parsed.append((index, payload))

    def key(item: tuple[int, dict]) -> tuple[float, int]:
        index, payload = item
        timestamp = payload.get("start_ts", payload.get("ts"))
        if isinstance(timestamp, (int, float)):
            return (float(timestamp), index)
        return (float("inf"), index)

    return "\n".join(
        json.dumps(payload, ensure_ascii=False) for _, payload in sorted(parsed, key=key)
    )


async def judge_transcript(transcript: str, *, rubric_module=None) -> dict:
    rm = rubric_module or rubric
    client = AsyncAzureOpenAI(
        azure_endpoint=settings.azure_openai_endpoint,
        api_key=settings.azure_openai_api_key,
        api_version=settings.azure_openai_api_version,
    )
    user_prompt = rm.render_judge_user_prompt(transcript)
    log.info(
        "calling judge: deployment=%s transcript_chars=%d",
        settings.azure_openai_judge_deployment,
        len(transcript),
    )
    resp = await client.chat.completions.create(
        model=settings.azure_openai_judge_deployment,
        messages=[
            {"role": "system", "content": rm.JUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
    )
    content = resp.choices[0].message.content or "{}"
    return json.loads(content)


async def process_recording_callback(payload: dict) -> None:
    record_url = payload.get("RecordUrl") or payload.get("RecordingFile") or payload.get("RecordFile")
    call_uuid = payload.get("CallUUID") or payload.get("CallSid") or "unknown"
    run_id_raw = payload.get("run_id")
    try:
        await _run_eval_pipeline(record_url, call_uuid, run_id_raw)
    except Exception as e:
        log.exception("eval pipeline crashed: %s", e)
        if run_id_raw:
            await _persist_run_artifacts(
                run_id_raw,
                recording_url=None,
                transcript_text=None,
                judge_result=None,
                status="failed",
                verdict=None,
                error=f"eval crashed: {e}",
            )


async def _run_eval_pipeline(
    record_url: str | None, call_uuid: str, run_id_raw: str | None
) -> None:
    slug = run_id_raw or _slug(call_uuid)
    wav_path = settings.recordings_dir / f"{slug}.wav"
    transcript_json_path = settings.transcripts_dir / f"{slug}.json"
    transcript_txt_path = settings.transcripts_dir / f"{slug}.txt"
    live_transcript_path = settings.transcripts_dir / f"{slug}.live.txt"
    eval_path = settings.evals_dir / f"{slug}.json"

    log.info("processing call %s (run=%s): %s", call_uuid, run_id_raw or "—", record_url)
    if run_id_raw:
        try:
            import uuid as _uuid

            from truman_calling.caller.run_orchestrator import mark_run_status

            await mark_run_status(_uuid.UUID(run_id_raw), "evaluating")
        except Exception:
            log.exception("failed to mark evaluating")

    transcript = ""
    recording_path: Path | None = None
    transcript_source = "none"

    # Path 1: try Plivo cloud recording → batch transcribe
    if record_url:
        try:
            await download_recording(record_url, wav_path)
            recording_path = wav_path
            dg = await transcribe_with_deepgram(wav_path)
            transcript_json_path.write_text(json.dumps(dg, indent=2))
            transcript = diarized_transcript_text(dg)
            if transcript:
                director_lines = director_transcript_lines(live_transcript_path)
                if director_lines:
                    transcript = "\n".join([transcript.rstrip(), *director_lines])
                transcript_txt_path.write_text(transcript)
                transcript_source = "plivo+deepgram"
        except Exception as e:
            log.warning("plivo recording / batch transcribe failed: %s — falling back to live transcript", e)

    # Path 2 (fallback): use the live transcript captured via STT events
    if not transcript and live_transcript_path.exists():
        live_text = live_transcript_path.read_text().strip()
        if live_text:
            transcript = timeline_sorted_live_transcript(live_text)
            transcript_txt_path.write_text(transcript)
            transcript_source = "live"

    log.info(
        "transcript ready (source=%s, %d chars)", transcript_source, len(transcript)
    )

    if not transcript:
        log.warning("no transcript available — marking failed")
        if run_id_raw:
            await _persist_run_artifacts(
                run_id_raw,
                recording_url=str(recording_path) if recording_path else None,
                transcript_text=None,
                judge_result=None,
                status="failed",
                verdict=None,
                error="no transcript (Plivo recording unavailable + no live transcript)",
            )
        return

    criteria, rubric_name = await _resolve_rubric_for_run(run_id_raw)
    result = await judge_transcript_text(transcript, criteria, caller_labels=_TRUMAN_CALLER_LABELS)

    verdict = result.get("overall") if isinstance(result, dict) else None
    if run_id_raw:
        await _persist_run_artifacts(
            run_id_raw,
            recording_url=str(recording_path) if recording_path else None,
            transcript_text=transcript,
            judge_result=result,
            status="done",
            verdict=verdict,
        )

    result_record = {
        "call_uuid": call_uuid,
        "run_id": run_id_raw,
        "rubric": rubric_name,
        "transcript_source": transcript_source,
        "transcript_path": str(transcript_txt_path),
        "wav_path": str(recording_path) if recording_path else None,
        "result": result,
    }
    eval_path.write_text(json.dumps(result_record, indent=2))
    log.info("eval saved: %s", eval_path)
    print(json.dumps(result_record, indent=2))


async def _resolve_rubric_for_run(run_id_raw: str | None) -> tuple[list[dict], str]:
    """Return (criteria, rubric_name). Criteria come from the run's DB rubric when
    available, else the bundled spike rubric. Each criterion is {key, question}."""
    if run_id_raw:
        try:
            import uuid as _uuid

            from truman_calling.caller.run_orchestrator import load_run

            loaded = await load_run(_uuid.UUID(run_id_raw))
            crit = [
                {"key": str(c.get("key") or c.get("name") or f"c{i}"), "question": str(c.get("question") or "")}
                for i, c in enumerate(loaded.rubric.criteria)
            ]
            if crit:
                return crit, loaded.rubric.name
        except Exception:
            log.exception("falling back to bundled spike rubric")
    return _criteria_from_bundled(), rubric.NAME


async def _persist_run_artifacts(
    run_id_raw: str,
    *,
    recording_url: str | None,
    transcript_text: str | None,
    judge_result: dict | None,
    status: str,
    verdict: str | None,
    error: str | None = None,
) -> None:
    import uuid as _uuid

    from truman_calling.caller.run_orchestrator import update_run

    try:
        await update_run(
            _uuid.UUID(run_id_raw),
            status=status,
            verdict=verdict,
            recording_url=recording_url,
            transcript_text=transcript_text,
            judge_result=judge_result,
            error=error,
        )
    except Exception:
        log.exception("failed to persist run artifacts")


async def run_from_local_wav(wav_path: Path) -> None:
    call_uuid = wav_path.stem
    dg = await transcribe_with_deepgram(wav_path)
    transcript_json_path = settings.transcripts_dir / f"{call_uuid}.json"
    transcript_txt_path = settings.transcripts_dir / f"{call_uuid}.txt"
    transcript_json_path.write_text(json.dumps(dg, indent=2))
    transcript = diarized_transcript_text(dg)
    transcript_txt_path.write_text(transcript)
    log.info("transcript: %d chars", len(transcript))
    if not transcript:
        log.warning("empty transcript — judge skipped")
        return
    result = await judge_transcript_text(transcript, _criteria_from_bundled(), caller_labels=_TRUMAN_CALLER_LABELS)
    eval_path = settings.evals_dir / f"{call_uuid}.json"
    eval_path.write_text(json.dumps({
        "call_uuid": call_uuid,
        "rubric": rubric.NAME,
        "transcript_path": str(transcript_txt_path),
        "wav_path": str(wav_path),
        "result": result,
    }, indent=2))
    print(json.dumps(result, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Manually transcribe + judge a WAV file.")
    parser.add_argument("wav", help="Path to a recorded WAV file")
    args = parser.parse_args()
    wav = Path(args.wav).expanduser().resolve()
    if not wav.exists():
        print(f"file not found: {wav}", file=sys.stderr)
        return 1
    asyncio.run(run_from_local_wav(wav))
    return 0


if __name__ == "__main__":
    sys.exit(main())
