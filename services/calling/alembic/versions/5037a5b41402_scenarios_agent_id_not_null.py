"""scenarios.agent_id NOT NULL

Revision ID: 5037a5b41402
Revises: 71b483152209
Create Date: 2026-05-23 03:15:15.674134

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '5037a5b41402'
down_revision: Union[str, Sequence[str], None] = '71b483152209'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Backfill any null agent_id by picking the org's first agent (oldest).
    # If an org has scenarios but no agents, this row stays null and the
    # ALTER below will fail — caller must create an agent first.
    op.execute(
        sa.text(
            """
            UPDATE scenarios s
            SET agent_id = sub.first_agent_id
            FROM (
              SELECT DISTINCT ON (org_id) org_id, id AS first_agent_id
              FROM agents
              ORDER BY org_id, created_at ASC
            ) sub
            WHERE s.agent_id IS NULL AND s.org_id = sub.org_id
            """
        )
    )
    op.alter_column(
        "scenarios",
        "agent_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True),
        nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "scenarios",
        "agent_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True),
        nullable=True,
    )
