from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.routers._crud import CrudService
from truman_calling.api.schemas.agents import AgentCreate, AgentRead, AgentUpdate
from truman_calling.core.models import (
    AlertRule,
    Agent,
    EvaluationSchedule,
    ObservedCall,
    Run,
    Scenario,
    Suite,
)

router = APIRouter(prefix="/v1/agents", tags=["agents"])
svc = CrudService(Agent)


@router.get("", response_model=list[AgentRead])
async def list_agents(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.list(session, org_id)


@router.post("", response_model=AgentRead, status_code=status.HTTP_201_CREATED)
async def create_agent(
    payload: AgentCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.create(session, org_id, payload)


@router.get("/{agent_id}", response_model=AgentRead)
async def get_agent(
    agent_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.get(session, org_id, agent_id)


@router.patch("/{agent_id}", response_model=AgentRead)
async def update_agent(
    agent_id: uuid.UUID,
    payload: AgentUpdate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.update(session, org_id, agent_id, payload)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(
    agent_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    agent = await svc.get(session, org_id, agent_id)

    scenario_ids = list(
        (
            await session.execute(
                select(Scenario.id).where(
                    Scenario.org_id == org_id,
                    Scenario.agent_id == agent_id,
                )
            )
        ).scalars()
    )
    run_filter = Run.agent_id == agent_id
    if scenario_ids:
        run_filter = run_filter | Run.scenario_id.in_(scenario_ids)

    suite_ids = list(
        dict.fromkeys(
            (
                await session.execute(
                    select(Run.suite_id).where(
                        Run.org_id == org_id,
                        run_filter,
                        Run.suite_id.is_not(None),
                    )
                )
            ).scalars()
        )
    )

    await session.execute(
        delete(EvaluationSchedule).where(
            EvaluationSchedule.org_id == org_id,
            EvaluationSchedule.agent_id == agent_id,
        )
    )
    await session.execute(
        delete(ObservedCall).where(
            ObservedCall.org_id == org_id,
            ObservedCall.agent_id == agent_id,
        )
    )
    await session.execute(
        delete(AlertRule).where(AlertRule.org_id == org_id, AlertRule.agent_id == agent_id)
    )
    await session.execute(delete(Run).where(Run.org_id == org_id, run_filter))
    if scenario_ids:
        await session.execute(
            delete(Scenario).where(
                Scenario.org_id == org_id,
                Scenario.id.in_(scenario_ids),
            )
        )

    await session.delete(agent)
    await session.flush()

    for suite_id in suite_ids:
        remaining = await session.scalar(
            select(func.count()).select_from(Run).where(
                Run.org_id == org_id,
                Run.suite_id == suite_id,
            )
        )
        if not remaining:
            await session.execute(delete(Suite).where(Suite.org_id == org_id, Suite.id == suite_id))

    await session.commit()
