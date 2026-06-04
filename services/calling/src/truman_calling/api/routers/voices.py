"""ElevenLabs voice library proxy.

The frontend voice library is a thin presentation layer over ElevenLabs' own
catalog — we never persist voices in our DB. This router forwards the
listing request to ElevenLabs with the org's API key (server-side, so the
secret never reaches the browser), and reshapes the response to what the UI
needs.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from truman_calling.api.deps import require_auth
from truman_calling.core.settings import settings

router = APIRouter(prefix="/v1/voices", tags=["voices"])

# ElevenLabs residency stacks (in.residency.elevenlabs.io, etc.) reject keys
# issued for them when called against the global endpoint and vice-versa.
# We derive the REST host from the configured WSS base so the listing call
# stays on the right stack.
_VOICES_PATH = "/voices"
_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0)


def _voices_url() -> str:
    return settings.elevenlabs_rest_base_url.rstrip("/") + _VOICES_PATH


def _shape_voice(raw: dict[str, Any]) -> dict[str, Any]:
    labels = raw.get("labels") or {}
    return {
        "voice_id": raw.get("voice_id"),
        "name": raw.get("name") or "Untitled voice",
        "category": raw.get("category") or "premade",
        "description": raw.get("description") or "",
        "preview_url": raw.get("preview_url"),
        "labels": {
            "accent": labels.get("accent"),
            "age": labels.get("age"),
            "gender": labels.get("gender"),
            "use_case": labels.get("use_case") or labels.get("use case"),
            "description": labels.get("description") or labels.get("descriptive"),
            "language": labels.get("language"),
        },
        "is_default": (
            bool(settings.elevenlabs_voice_id)
            and raw.get("voice_id") == settings.elevenlabs_voice_id
        ),
    }


@router.get("", response_model=list[dict])
async def list_voices(
    _org_id: uuid.UUID = Depends(require_auth),
) -> list[dict]:
    if not settings.elevenlabs_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ELEVENLABS_API_KEY not configured",
        )
    headers = {"xi-api-key": settings.elevenlabs_api_key, "accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(_voices_url(), headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"ElevenLabs request failed: {e}",
        ) from e

    if resp.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"ElevenLabs returned {resp.status_code}: {resp.text[:200]}",
        )

    payload = resp.json()
    voices = payload.get("voices") or []
    return [_shape_voice(v) for v in voices]


@router.get("/default")
async def get_default_voice(
    _org_id: uuid.UUID = Depends(require_auth),
) -> dict[str, str | None]:
    """The voice the caller defaults to when none is specified on a persona."""
    return {
        "voice_id": settings.elevenlabs_voice_id or None,
        "model_id": settings.elevenlabs_model_id or None,
    }
