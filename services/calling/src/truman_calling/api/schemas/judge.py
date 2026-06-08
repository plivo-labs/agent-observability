from __future__ import annotations

from pydantic import BaseModel


class JudgeCriterion(BaseModel):
    key: str
    question: str = ""
    weight: float = 1.0


class JudgeRequest(BaseModel):
    transcript: str
    criteria: list[JudgeCriterion]
