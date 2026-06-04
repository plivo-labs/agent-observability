"""Loads Run + Scenario + Persona/Profile/Rubric/Agent from DB and exposes
helper functions for the caller server + worker to operate on a Run."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select, update

from truman_calling.caller.db import session_scope
from truman_calling.core.models import Agent, Persona, Profile, Rubric, Run, Scenario


@dataclass
class LoadedRun:
    run: Run
    agent: Agent
    scenario: Scenario
    persona: Persona
    rubric: Rubric
    profile: Profile | None


async def load_run(run_id: uuid.UUID) -> LoadedRun:
    async with session_scope() as s:
        run = (await s.execute(select(Run).where(Run.id == run_id))).scalar_one()
        scenario = (
            await s.execute(select(Scenario).where(Scenario.id == run.scenario_id))
        ).scalar_one()
        persona = (
            await s.execute(select(Persona).where(Persona.id == scenario.persona_id))
        ).scalar_one()
        rubric = (
            await s.execute(select(Rubric).where(Rubric.id == scenario.rubric_id))
        ).scalar_one()
        agent = (await s.execute(select(Agent).where(Agent.id == run.agent_id))).scalar_one()
        profile: Profile | None = None
        if scenario.profile_id:
            profile = (
                await s.execute(select(Profile).where(Profile.id == scenario.profile_id))
            ).scalar_one_or_none()
    return LoadedRun(run=run, agent=agent, scenario=scenario, persona=persona, rubric=rubric, profile=profile)


_PLACEHOLDER = re.compile(r"\{([a-zA-Z0-9_]+)\}")


def render_template(template: str, variables: dict[str, Any]) -> str:
    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        return str(variables.get(key, m.group(0)))

    return _PLACEHOLDER.sub(repl, template)


async def update_run(run_id: uuid.UUID, **fields: Any) -> None:
    async with session_scope() as s:
        await s.execute(update(Run).where(Run.id == run_id).values(**fields))
        await s.commit()


async def merge_run_usage(run_id: uuid.UUID, patch: dict[str, Any]) -> None:
    """Shallow-merge `patch` into the JSONB `usage` column."""
    async with session_scope() as s:
        row = (await s.execute(select(Run).where(Run.id == run_id))).scalar_one()
        merged = dict(row.usage or {})
        merged.update(patch)
        await s.execute(update(Run).where(Run.id == run_id).values(usage=merged))
        await s.commit()


async def mark_run_status(
    run_id: uuid.UUID,
    status: str,
    *,
    started_at: bool = False,
    ended_at: bool = False,
    **extra: Any,
) -> None:
    values: dict[str, Any] = {"status": status, **extra}
    if started_at:
        values["started_at"] = datetime.utcnow()
    if ended_at:
        values["ended_at"] = datetime.utcnow()
    await update_run(run_id, **values)
