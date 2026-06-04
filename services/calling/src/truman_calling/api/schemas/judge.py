from __future__ import annotations

from pydantic import BaseModel, field_validator

_VALID_SCOPES = {"flow", "agent", "task", "node"}


class JudgeCriterion(BaseModel):
    key: str
    question: str = ""
    weight: float = 1.0


class JudgeRequest(BaseModel):
    transcript: str
    criteria: list[JudgeCriterion]
    # Leveled-judge scopes. Default ["flow"] => byte-identical to the pre-leveled
    # contract (no `scopes` block in the response).
    scopes: list[str] = ["flow"]

    @field_validator("scopes")
    @classmethod
    def _validate_scopes(cls, v: list[str]) -> list[str]:
        if not v:
            return ["flow"]
        bad = [s for s in v if s not in _VALID_SCOPES]
        if bad:
            raise ValueError(f"invalid scopes {bad}; allowed: {sorted(_VALID_SCOPES)}")
        return v
