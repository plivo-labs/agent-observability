from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from truman_calling.api.schemas.common import StampedRead


class ProfileCreate(BaseModel):
    name: str
    variables: dict[str, Any] = Field(default_factory=dict)


class ProfileUpdate(BaseModel):
    name: str | None = None
    variables: dict[str, Any] | None = None


class ProfileRead(StampedRead):
    name: str
    variables: dict[str, Any]
