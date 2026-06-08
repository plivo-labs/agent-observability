from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from truman_calling.api.schemas.runs import RunRead


class ResultCreate(BaseModel):
    name: str | None = None
    scenario_ids: list[UUID] = Field(min_length=1, max_length=50)


class ResultRerunCreate(BaseModel):
    name: str | None = None
    mode: Literal["failed", "all"] = "failed"


class ResultRead(BaseModel):
    id: UUID
    name: str | None
    status: str
    created_at: datetime
    run_count: int
    scenario_count: int
    agent_count: int
    pass_count: int
    fail_count: int
    pending_count: int
    score: int | None
    avg_duration_seconds: int | None
    scenario_ids: list[UUID]
    agent_ids: list[UUID]
    latest_error: str | None


class ResultDetailRead(ResultRead):
    runs: list[RunRead]


class ResultCompareRunRead(BaseModel):
    scenario_id: UUID
    agent_id: UUID
    baseline_run_id: UUID | None
    current_run_id: UUID | None
    baseline_status: str | None
    current_status: str | None
    baseline_verdict: str | None
    current_verdict: str | None
    outcome: Literal["fixed", "regressed", "unchanged_pass", "unchanged_fail", "new", "removed", "pending"]
    note: str | None


class ResultCompareRead(BaseModel):
    result_id: UUID
    baseline_id: UUID
    result_name: str | None
    baseline_name: str | None
    result_score: int | None
    baseline_score: int | None
    score_delta: int | None
    fixed_count: int
    regressed_count: int
    unchanged_pass_count: int
    unchanged_fail_count: int
    new_count: int
    removed_count: int
    pending_count: int
    rows: list[ResultCompareRunRead]


class ResultReportRead(BaseModel):
    id: UUID
    name: str | None
    generated_at: datetime
    status: str
    score: int | None
    headline: str
    summary: str
    failure_summary: str | None
    recommended_actions: list[str]
    run_count: int
    pass_count: int
    fail_count: int
    pending_count: int
