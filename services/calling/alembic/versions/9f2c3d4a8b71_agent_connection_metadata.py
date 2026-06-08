"""agent connection metadata

Revision ID: 9f2c3d4a8b71
Revises: 5037a5b41402
Create Date: 2026-05-23 04:55:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9f2c3d4a8b71"
down_revision: Union[str, Sequence[str], None] = "5037a5b41402"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column("provider", sa.String(length=64), server_default="custom", nullable=False),
    )
    op.add_column(
        "agents",
        sa.Column(
            "connection_type",
            sa.String(length=64),
            server_default="telephony_inbound",
            nullable=False,
        ),
    )
    op.add_column(
        "agents",
        sa.Column("language", sa.String(length=16), server_default="en", nullable=False),
    )
    op.add_column(
        "agents",
        sa.Column("external_assistant_id", sa.String(length=256), nullable=True),
    )
    op.add_column(
        "agents",
        sa.Column(
            "post_conversation_metadata",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )

    op.alter_column("agents", "provider", server_default=None)
    op.alter_column("agents", "connection_type", server_default=None)
    op.alter_column("agents", "language", server_default=None)
    op.alter_column("agents", "post_conversation_metadata", server_default=None)


def downgrade() -> None:
    op.drop_column("agents", "post_conversation_metadata")
    op.drop_column("agents", "external_assistant_id")
    op.drop_column("agents", "language")
    op.drop_column("agents", "connection_type")
    op.drop_column("agents", "provider")
