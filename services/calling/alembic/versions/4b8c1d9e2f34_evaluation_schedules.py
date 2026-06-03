"""evaluation schedules

Revision ID: 4b8c1d9e2f34
Revises: e0d4b2f7a963
Create Date: 2026-05-23 07:08:25.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "4b8c1d9e2f34"
down_revision: Union[str, Sequence[str], None] = "e0d4b2f7a963"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "evaluation_schedules",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("agent_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("cron_expression", sa.String(length=128), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("scenario_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "personality_override_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("execution_mode", sa.String(length=16), nullable=False, server_default="voice"),
        sa.Column("run_limit", sa.Integer(), nullable=True),
        sa.Column("run_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], name=op.f("fk_evaluation_schedules_agent_id_agents"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"], name=op.f("fk_evaluation_schedules_org_id_orgs"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_evaluation_schedules")),
    )
    op.create_index(
        "ix_evaluation_schedules_org_id",
        "evaluation_schedules",
        ["org_id"],
        unique=False,
    )
    op.create_index(
        "ix_evaluation_schedules_next_run_at",
        "evaluation_schedules",
        ["next_run_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_evaluation_schedules_next_run_at", table_name="evaluation_schedules")
    op.drop_index("ix_evaluation_schedules_org_id", table_name="evaluation_schedules")
    op.drop_table("evaluation_schedules")
