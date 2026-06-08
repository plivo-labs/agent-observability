from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from truman_calling.core.models import Base, created_at_col, uuid_pk


class Scenario(Base):
    __tablename__ = "scenarios"

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="RESTRICT"), nullable=False
    )
    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="RESTRICT"), nullable=False
    )
    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    rubric_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rubrics.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    expected_outcomes: Mapped[str | None] = mapped_column(Text, nullable=True)
    opener_instructions: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(String(16), nullable=False, default="en")
    tags: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    max_call_duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=600)
    allow_dtmf: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    allow_sms: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    allow_end_call: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class ScenarioRevision(Base):
    __tablename__ = "scenario_revisions"
    __table_args__ = (
        UniqueConstraint("scenario_id", "version", name="uq_scenario_revisions_scenario_version"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE"), nullable=False
    )
    scenario_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scenarios.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    change_summary: Mapped[str] = mapped_column(String(256), nullable=False)
    changed_fields: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
