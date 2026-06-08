"""alert rules

Revision ID: b2d4e6f8a901
Revises: 6a7b8c9d0e12
Create Date: 2026-05-23 07:32:46.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2d4e6f8a901"
down_revision: Union[str, Sequence[str], None] = "6a7b8c9d0e12"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "alert_rules",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("agent_id", sa.UUID(), nullable=True),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("metric_key", sa.String(length=64), nullable=False),
        sa.Column("operator", sa.String(length=32), nullable=False),
        sa.Column("match_value", sa.String(length=256), nullable=True),
        sa.Column("threshold_value", sa.Float(), nullable=True),
        sa.Column("provider", sa.String(length=64), nullable=True),
        sa.Column("alert_type", sa.String(length=64), nullable=False, server_default="threshold"),
        sa.Column("alert_direction", sa.String(length=32), nullable=False, server_default="increase"),
        sa.Column("slack_channel", sa.String(length=128), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], name=op.f("fk_alert_rules_agent_id_agents"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"], name=op.f("fk_alert_rules_org_id_orgs"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alert_rules")),
    )
    op.create_index("ix_alert_rules_org_id", "alert_rules", ["org_id"], unique=False)
    op.create_index("ix_alert_rules_agent_id", "alert_rules", ["agent_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_alert_rules_agent_id", table_name="alert_rules")
    op.drop_index("ix_alert_rules_org_id", table_name="alert_rules")
    op.drop_table("alert_rules")
