"""scenario revision history

Revision ID: e0d4b2f7a963
Revises: c8f2a14e7d62
Create Date: 2026-05-23 05:56:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "e0d4b2f7a963"
down_revision: Union[str, Sequence[str], None] = "c8f2a14e7d62"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(sa.text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))

    op.create_table(
        "scenario_revisions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("scenario_id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("change_summary", sa.String(length=256), nullable=False),
        sa.Column("changed_fields", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"], name=op.f("fk_scenario_revisions_org_id_orgs"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenarios.id"], name=op.f("fk_scenario_revisions_scenario_id_scenarios"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scenario_revisions")),
        sa.UniqueConstraint("scenario_id", "version", name="uq_scenario_revisions_scenario_version"),
    )
    op.create_index(
        "ix_scenario_revisions_scenario_id",
        "scenario_revisions",
        ["scenario_id"],
        unique=False,
    )

    op.execute(
        sa.text(
            """
            INSERT INTO scenario_revisions (
                id,
                org_id,
                scenario_id,
                version,
                change_summary,
                changed_fields,
                snapshot
            )
            SELECT
                gen_random_uuid(),
                s.org_id,
                s.id,
                1,
                'Initial snapshot',
                '["created"]'::jsonb,
                jsonb_build_object(
                    'name', s.name,
                    'agent_id', s.agent_id::text,
                    'persona_id', s.persona_id::text,
                    'rubric_id', s.rubric_id::text,
                    'profile_id', s.profile_id::text,
                    'expected_outcomes', s.expected_outcomes,
                    'opener_instructions', s.opener_instructions,
                    'language', s.language,
                    'tags', COALESCE(s.tags, '[]'::jsonb),
                    'max_call_duration_seconds', s.max_call_duration_seconds,
                    'allow_dtmf', s.allow_dtmf,
                    'allow_sms', s.allow_sms,
                    'allow_end_call', s.allow_end_call
                )
            FROM scenarios s
            """
        )
    )


def downgrade() -> None:
    op.drop_index("ix_scenario_revisions_scenario_id", table_name="scenario_revisions")
    op.drop_table("scenario_revisions")
