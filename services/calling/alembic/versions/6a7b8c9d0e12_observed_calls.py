"""observed calls

Revision ID: 6a7b8c9d0e12
Revises: 4b8c1d9e2f34
Create Date: 2026-05-23 07:22:44.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "6a7b8c9d0e12"
down_revision: Union[str, Sequence[str], None] = "4b8c1d9e2f34"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "observed_calls",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("agent_id", sa.UUID(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("external_call_id", sa.String(length=256), nullable=False),
        sa.Column("voice_recording_url", sa.Text(), nullable=True),
        sa.Column("transcript_type", sa.String(length=32), nullable=False),
        sa.Column("transcript_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("transcript_text", sa.Text(), nullable=True),
        sa.Column("call_ended_reason", sa.String(length=256), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], name=op.f("fk_observed_calls_agent_id_agents"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"], name=op.f("fk_observed_calls_org_id_orgs"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_observed_calls")),
        sa.UniqueConstraint("org_id", "provider", "external_call_id", name="uq_observed_calls_org_provider_external"),
    )
    op.create_index("ix_observed_calls_org_id", "observed_calls", ["org_id"], unique=False)
    op.create_index("ix_observed_calls_agent_id", "observed_calls", ["agent_id"], unique=False)
    op.create_index("ix_observed_calls_created_at", "observed_calls", ["created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_observed_calls_created_at", table_name="observed_calls")
    op.drop_index("ix_observed_calls_agent_id", table_name="observed_calls")
    op.drop_index("ix_observed_calls_org_id", table_name="observed_calls")
    op.drop_table("observed_calls")
