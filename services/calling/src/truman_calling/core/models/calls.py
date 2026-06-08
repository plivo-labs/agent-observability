from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from truman_calling.core.models import Base, created_at_col, updated_at_col, uuid_pk


class ObservedCall(Base):
    __tablename__ = "observed_calls"
    __table_args__ = (
        UniqueConstraint(
            "org_id",
            "provider",
            "external_call_id",
            name="uq_observed_calls_org_provider_external",
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="RESTRICT"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False, default="custom")
    external_call_id: Mapped[str] = mapped_column(String(256), nullable=False)
    voice_recording_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_type: Mapped[str] = mapped_column(String(32), nullable=False, default="custom")
    transcript_json: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)
    transcript_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    call_ended_reason: Mapped[str | None] = mapped_column(String(256), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="ingested")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    call_metadata: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()
