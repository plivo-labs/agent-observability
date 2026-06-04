from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from truman_calling.core.models import Base, created_at_col, updated_at_col, uuid_pk


class Persona(Base):
    __tablename__ = "personas"

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    voice_id: Mapped[str] = mapped_column(String(128), nullable=False)
    language: Mapped[str] = mapped_column(String(16), nullable=False, default="en")
    gender: Mapped[str] = mapped_column(String(64), nullable=False, default="unspecified")
    speaking_speed: Mapped[str] = mapped_column(String(32), nullable=False, default="normal")
    interruption_level: Mapped[str] = mapped_column(String(32), nullable=False, default="medium")
    background_noise: Mapped[str] = mapped_column(String(32), nullable=False, default="none")
    accent: Mapped[str] = mapped_column(String(64), nullable=False, default="neutral")
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_bundled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()
