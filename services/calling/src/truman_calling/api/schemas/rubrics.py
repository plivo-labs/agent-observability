from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from truman_calling.api.schemas.common import StampedRead


class Criterion(BaseModel):
    key: str
    question: str
    weight: float = 1.0


class RubricCreate(BaseModel):
    name: str
    criteria: list[Criterion]
    judge_model: str


class RubricUpdate(BaseModel):
    name: str | None = None
    criteria: list[Criterion] | None = None
    judge_model: str | None = None


class RubricRead(StampedRead):
    name: str
    criteria: list[dict[str, Any]]
    judge_model: str
    is_bundled: bool
