from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from truman_calling.api.schemas.calls import ObservedCallRead

AlertMetric = Literal["ended_reason", "transcript_contains", "duration_seconds", "status", "provider"]
AlertOperator = Literal["equals", "contains", "gte", "lte"]


class AlertRuleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    metric_key: AlertMetric
    operator: AlertOperator
    match_value: str | None = Field(default=None, max_length=256)
    threshold_value: float | None = None
    agent_id: UUID | None = None
    provider: str | None = Field(default=None, max_length=64)
    alert_type: str = Field(default="threshold", min_length=1, max_length=64)
    alert_direction: str = Field(default="increase", min_length=1, max_length=32)
    slack_channel: str | None = Field(default=None, max_length=128)
    is_enabled: bool = True

    @model_validator(mode="after")
    def validate_condition(self) -> "AlertRuleCreate":
        if self.metric_key == "duration_seconds":
            if self.threshold_value is None:
                raise ValueError("duration alerts require threshold_value")
            if self.operator not in {"gte", "lte", "equals"}:
                raise ValueError("duration alerts require gte, lte, or equals")
        elif not self.match_value:
            raise ValueError("this alert metric requires match_value")
        return self


class AlertRuleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    metric_key: AlertMetric | None = None
    operator: AlertOperator | None = None
    match_value: str | None = Field(default=None, max_length=256)
    threshold_value: float | None = None
    agent_id: UUID | None = None
    provider: str | None = Field(default=None, max_length=64)
    alert_type: str | None = Field(default=None, min_length=1, max_length=64)
    alert_direction: str | None = Field(default=None, min_length=1, max_length=32)
    slack_channel: str | None = Field(default=None, max_length=128)
    is_enabled: bool | None = None


class AlertRuleRead(BaseModel):
    id: UUID
    name: str
    metric_key: str
    operator: str
    match_value: str | None
    threshold_value: float | None
    agent_id: UUID | None
    provider: str | None
    alert_type: str
    alert_direction: str
    slack_channel: str | None
    is_enabled: bool
    last_24h_count: int
    latest_call_id: UUID | None
    created_at: datetime
    updated_at: datetime


class AlertReviewRead(BaseModel):
    alert: AlertRuleRead
    calls: list[ObservedCallRead]
