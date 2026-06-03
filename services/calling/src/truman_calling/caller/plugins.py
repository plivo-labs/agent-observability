from __future__ import annotations

from livekit.plugins import deepgram, elevenlabs
from livekit.plugins import openai as lk_openai

from truman_calling.caller.config import AUDIO_SAMPLE_RATE, settings


def build_stt(*, language: str = "en") -> deepgram.STT:
    kwargs: dict = dict(
        model=settings.deepgram_model,
        language=language,
        sample_rate=AUDIO_SAMPLE_RATE,
        punctuate=True,
        smart_format=False,
        numerals=True,
        interim_results=True,
        endpointing_ms=100,
        vad_events=False,
        no_delay=True,
        filler_words=True,
    )
    if settings.deepgram_api_key:
        kwargs["api_key"] = settings.deepgram_api_key
    if settings.deepgram_base_url:
        kwargs["base_url"] = settings.deepgram_base_url
    return deepgram.STT(**kwargs)


def build_llm(*, deployment: str | None = None) -> lk_openai.LLM:
    return lk_openai.LLM.with_azure(
        model=deployment or settings.azure_openai_persona_deployment,
        azure_endpoint=settings.azure_openai_endpoint,
        api_key=settings.azure_openai_api_key,
        api_version=settings.azure_openai_api_version,
        temperature=0.6,
    )


def build_tts(*, language: str = "en", voice_id_override: str | None = None) -> elevenlabs.TTS:
    kwargs: dict = dict(
        model=settings.elevenlabs_model_id,
        voice_id=voice_id_override or settings.elevenlabs_voice_id,
        encoding=f"pcm_{AUDIO_SAMPLE_RATE}",
        auto_mode=True,
        apply_text_normalization="on",
        language=language,
    )
    if settings.elevenlabs_api_key:
        kwargs["api_key"] = settings.elevenlabs_api_key
    if settings.elevenlabs_base_url:
        kwargs["base_url"] = settings.elevenlabs_base_url
    return elevenlabs.TTS(**kwargs)
