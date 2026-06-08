from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, MetaData, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(table_name)s_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def created_at_col() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


def updated_at_col() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


__all__ = [
    "Base",
    "uuid_pk",
    "created_at_col",
    "updated_at_col",
    "JSONB",
    "UUID",
    # entities below (imported for Alembic autogen discovery)
    "Org",
    "Agent",
    "Persona",
    "Profile",
    "Rubric",
    "Scenario",
    "ScenarioRevision",
    "EvaluationSchedule",
    "ObservedCall",
    "AlertRule",
    "Suite",
    "Run",
]

# Re-export entities so `from core.models import Base` finds them all.
from truman_calling.core.models.orgs import Org  # noqa: E402
from truman_calling.core.models.agents import Agent  # noqa: E402
from truman_calling.core.models.personas import Persona  # noqa: E402
from truman_calling.core.models.profiles import Profile  # noqa: E402
from truman_calling.core.models.rubrics import Rubric  # noqa: E402
from truman_calling.core.models.scenarios import Scenario, ScenarioRevision  # noqa: E402
from truman_calling.core.models.schedules import EvaluationSchedule  # noqa: E402
from truman_calling.core.models.calls import ObservedCall  # noqa: E402
from truman_calling.core.models.alerts import AlertRule  # noqa: E402
from truman_calling.core.models.suites import Suite  # noqa: E402
from truman_calling.core.models.runs import Run  # noqa: E402

_ = (
    Org,
    Agent,
    Persona,
    Profile,
    Rubric,
    Scenario,
    ScenarioRevision,
    EvaluationSchedule,
    ObservedCall,
    AlertRule,
    Suite,
    Run,
    Any,
)
