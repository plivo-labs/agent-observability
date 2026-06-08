from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from truman_calling.core.models import Base, created_at_col, updated_at_col, uuid_pk


class EvaluationSchedule(Base):
    __tablename__ = "evaluation_schedules"

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    cron_expression: Mapped[str] = mapped_column(String(128), nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="UTC")
    scenario_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    personality_override_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    execution_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="voice")
    run_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    run_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()


_ = Any
