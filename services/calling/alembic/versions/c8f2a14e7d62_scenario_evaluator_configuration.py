"""scenario evaluator configuration

Revision ID: c8f2a14e7d62
Revises: 5ec9b7d2a481
Create Date: 2026-05-23 05:42:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "c8f2a14e7d62"
down_revision: Union[str, Sequence[str], None] = "5ec9b7d2a481"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scenarios",
        sa.Column(
            "tags",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "scenarios",
        sa.Column("max_call_duration_seconds", sa.Integer(), server_default="600", nullable=False),
    )
    op.add_column(
        "scenarios",
        sa.Column("allow_dtmf", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "scenarios",
        sa.Column("allow_sms", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "scenarios",
        sa.Column("allow_end_call", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )

    op.alter_column("scenarios", "tags", server_default=None)
    op.alter_column("scenarios", "max_call_duration_seconds", server_default=None)
    op.alter_column("scenarios", "allow_dtmf", server_default=None)
    op.alter_column("scenarios", "allow_sms", server_default=None)
    op.alter_column("scenarios", "allow_end_call", server_default=None)


def downgrade() -> None:
    op.drop_column("scenarios", "allow_end_call")
    op.drop_column("scenarios", "allow_sms")
    op.drop_column("scenarios", "allow_dtmf")
    op.drop_column("scenarios", "max_call_duration_seconds")
    op.drop_column("scenarios", "tags")
