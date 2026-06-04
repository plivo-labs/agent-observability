"""persona behavior modifiers

Revision ID: 5ec9b7d2a481
Revises: 9f2c3d4a8b71
Create Date: 2026-05-23 05:24:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "5ec9b7d2a481"
down_revision: Union[str, Sequence[str], None] = "9f2c3d4a8b71"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "personas",
        sa.Column("gender", sa.String(length=64), server_default="unspecified", nullable=False),
    )
    op.add_column(
        "personas",
        sa.Column("speaking_speed", sa.String(length=32), server_default="normal", nullable=False),
    )
    op.add_column(
        "personas",
        sa.Column(
            "interruption_level",
            sa.String(length=32),
            server_default="medium",
            nullable=False,
        ),
    )
    op.add_column(
        "personas",
        sa.Column("background_noise", sa.String(length=32), server_default="none", nullable=False),
    )
    op.add_column(
        "personas",
        sa.Column("accent", sa.String(length=64), server_default="neutral", nullable=False),
    )
    op.add_column(
        "personas",
        sa.Column("is_enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )

    op.alter_column("personas", "gender", server_default=None)
    op.alter_column("personas", "speaking_speed", server_default=None)
    op.alter_column("personas", "interruption_level", server_default=None)
    op.alter_column("personas", "background_noise", server_default=None)
    op.alter_column("personas", "accent", server_default=None)
    op.alter_column("personas", "is_enabled", server_default=None)


def downgrade() -> None:
    op.drop_column("personas", "is_enabled")
    op.drop_column("personas", "accent")
    op.drop_column("personas", "background_noise")
    op.drop_column("personas", "interruption_level")
    op.drop_column("personas", "speaking_speed")
    op.drop_column("personas", "gender")
