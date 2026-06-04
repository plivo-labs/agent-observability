"""Cost computation for a single Truman run.

Prices are configurable per-provider and per-model. Defaults reflect public
pricing as of mid-2026; tweak via environment / settings if a deployment runs
on different deals.

Costs are computed in **cents** as integers so we can sum them without
floating-point drift, then divided by 100 only at display time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# ──────────────────────────────────────────────────────────────────────────
# Defaults (cents). Override per-provider / per-model in PRICES below.
# ──────────────────────────────────────────────────────────────────────────

# LLM — cents per 1k tokens. gpt-4.1-mini default; fallback for unknown models.
LLM_DEFAULT_INPUT_CENTS_PER_1K = 0.04   # $0.40 / 1M
LLM_DEFAULT_OUTPUT_CENTS_PER_1K = 0.16  # $1.60 / 1M

# TTS — cents per 1k characters. ElevenLabs Creator tier turbo v2.5.
TTS_DEFAULT_CENTS_PER_1K_CHARS = 30.0   # $0.30 / 1k chars (≈ Creator tier)

# STT — cents per audio-minute. Deepgram nova-3 streaming cloud reference.
# Self-hosted is effectively $0; this is the "what it'd cost on cloud" figure.
STT_DEFAULT_CENTS_PER_MIN = 0.58        # $0.0058 / min

# Plivo PSTN — cents per minute, US destinations.
PLIVO_DEFAULT_CENTS_PER_MIN = 1.15      # $0.0115 / min (BillRate we observed)


# Per-model overrides keyed by lowercase model name.
LLM_PRICES: dict[str, tuple[float, float]] = {
    "gpt-4.1-mini": (LLM_DEFAULT_INPUT_CENTS_PER_1K, LLM_DEFAULT_OUTPUT_CENTS_PER_1K),
    "gpt-4o-mini": (0.015, 0.06),       # $0.15 / $0.60
    "gpt-4o": (0.25, 1.0),              # $2.50 / $10
    "gpt-4.1": (0.2, 0.8),              # $2.00 / $8.00
}

TTS_PRICES: dict[str, float] = {
    "eleven_turbo_v2_5": 30.0,
    "eleven_multilingual_v2": 30.0,
}

STT_PRICES: dict[str, float] = {
    "nova-3": STT_DEFAULT_CENTS_PER_MIN,
    "nova-2": STT_DEFAULT_CENTS_PER_MIN,
}


@dataclass
class CostBreakdown:
    llm: dict[str, Any]
    tts: dict[str, Any]
    stt: dict[str, Any]
    plivo: dict[str, Any]
    total_cents: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "llm": self.llm,
            "tts": self.tts,
            "stt": self.stt,
            "plivo": self.plivo,
            "total_cents": self.total_cents,
        }


def compute_cost(
    *,
    agent_session_usage: Any,
    plivo_seconds: float | None,
) -> CostBreakdown:
    """Turn LiveKit's AgentSessionUsage (+ Plivo call duration) into a breakdown.

    AgentSessionUsage.model_usage is a list of mixed `LLMModelUsage` /
    `TTSModelUsage` / `STTModelUsage` records. We pattern-match on attributes
    rather than `isinstance` so we don't need to import LiveKit types here.
    """
    llm = {"input_tokens": 0, "output_tokens": 0, "model": None, "cents": 0.0}
    tts = {"chars": 0, "audio_seconds": 0.0, "model": None, "cents": 0.0}
    stt = {"audio_seconds": 0.0, "model": None, "cents": 0.0}

    for entry in getattr(agent_session_usage, "model_usage", []) or []:
        kind = getattr(entry, "type", "") or ""
        model = (getattr(entry, "model", "") or "").lower()
        if kind == "llm_usage":
            inp = int(getattr(entry, "input_tokens", 0) or 0)
            out = int(getattr(entry, "output_tokens", 0) or 0)
            in_rate, out_rate = LLM_PRICES.get(
                model, (LLM_DEFAULT_INPUT_CENTS_PER_1K, LLM_DEFAULT_OUTPUT_CENTS_PER_1K)
            )
            llm["input_tokens"] += inp
            llm["output_tokens"] += out
            llm["model"] = llm["model"] or model
            llm["cents"] += inp / 1000 * in_rate + out / 1000 * out_rate
        elif kind == "tts_usage":
            chars = int(getattr(entry, "characters_count", 0) or 0)
            audio = float(getattr(entry, "audio_duration", 0.0) or 0.0)
            rate = TTS_PRICES.get(model, TTS_DEFAULT_CENTS_PER_1K_CHARS)
            tts["chars"] += chars
            tts["audio_seconds"] += audio
            tts["model"] = tts["model"] or model
            tts["cents"] += chars / 1000 * rate
        elif kind == "stt_usage":
            audio = float(getattr(entry, "audio_duration", 0.0) or 0.0)
            rate = STT_PRICES.get(model, STT_DEFAULT_CENTS_PER_MIN)
            stt["audio_seconds"] += audio
            stt["model"] = stt["model"] or model
            stt["cents"] += audio / 60 * rate

    plivo = {
        "seconds": float(plivo_seconds or 0.0),
        "cents": (float(plivo_seconds or 0.0) / 60) * PLIVO_DEFAULT_CENTS_PER_MIN,
    }

    total = llm["cents"] + tts["cents"] + stt["cents"] + plivo["cents"]
    # store cents as float for sub-cent precision; total rounded
    return CostBreakdown(
        llm=_round(llm),
        tts=_round(tts),
        stt=_round(stt),
        plivo=_round(plivo),
        total_cents=int(round(total)),
    )


def _round(d: dict[str, Any]) -> dict[str, Any]:
    out = dict(d)
    if "cents" in out and isinstance(out["cents"], (int, float)):
        out["cents"] = round(float(out["cents"]), 4)
    return out
