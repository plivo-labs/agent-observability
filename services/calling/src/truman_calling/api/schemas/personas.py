from __future__ import annotations

from pydantic import BaseModel

from truman_calling.api.schemas.common import StampedRead


class PersonaCreate(BaseModel):
    name: str
    prompt: str
    voice_id: str
    language: str = "en"
    gender: str = "unspecified"
    speaking_speed: str = "normal"
    interruption_level: str = "medium"
    background_noise: str = "none"
    accent: str = "neutral"
    is_enabled: bool = True


class PersonaUpdate(BaseModel):
    name: str | None = None
    prompt: str | None = None
    voice_id: str | None = None
    language: str | None = None
    gender: str | None = None
    speaking_speed: str | None = None
    interruption_level: str | None = None
    background_noise: str | None = None
    accent: str | None = None
    is_enabled: bool | None = None


class PersonaRead(StampedRead):
    name: str
    prompt: str
    voice_id: str
    language: str
    gender: str
    speaking_speed: str
    interruption_level: str
    background_noise: str
    accent: str
    is_enabled: bool
    is_bundled: bool
