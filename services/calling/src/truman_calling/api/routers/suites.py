from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.schemas.suites import SuiteCreate, SuiteRead, SuiteReadDetail
from truman_calling.core.models import Agent, Run, Scenario, Suite
from truman_calling.core.queue import PLACE_CALL_STREAM, publish

router = APIRouter(prefix="/v1/suites", tags=["suites"])


@router.get("", response_model=list[SuiteRead])
async def list_suites(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    limit: int = Query(50, ge=1, le=200),
):
    result = await session.execute(
        select(Suite)
        .where(Suite.org_id == org_id)
        .order_by(Suite.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


@router.get("/{suite_id}", response_model=SuiteReadDetail)
async def get_suite(
    suite_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    suite = (
        await session.execute(
            select(Suite).where(Suite.id == suite_id, Suite.org_id == org_id)
        )
    ).scalar_one_or_none()
    if suite is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "suite not found")

    runs = (
        await session.execute(
            select(Run)
            .where(Run.suite_id == suite_id, Run.org_id == org_id)
            .order_by(Run.created_at.asc())
        )
    ).scalars().all()

    detail = SuiteReadDetail.model_validate(suite)
    detail.runs = [r for r in runs]
    return detail


@router.post("", response_model=SuiteReadDetail, status_code=status.HTTP_201_CREATED)
async def create_suite(
    payload: SuiteCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    # Verify agent exists in org.
    agent = (
        await session.execute(
            select(Agent).where(Agent.id == payload.agent_id, Agent.org_id == org_id)
        )
    ).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")

    # Load all requested scenarios; validate they belong to this org and the
    # given agent. (Scenarios are agent-scoped since the prior migration.)
    scenarios = (
        await session.execute(
            select(Scenario).where(
                Scenario.id.in_(payload.scenario_ids), Scenario.org_id == org_id
            )
        )
    ).scalars().all()
    found_ids = {s.id for s in scenarios}
    missing = [sid for sid in payload.scenario_ids if sid not in found_ids]
    if missing:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"scenarios not found: {missing}",
        )
    wrong_agent = [s.id for s in scenarios if s.agent_id != agent.id]
    if wrong_agent:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"scenarios target a different agent: {wrong_agent}",
        )

    suite = Suite(
        org_id=org_id,
        name=payload.name or f"{agent.name} · {len(scenarios)} scenarios",
        status="running",
    )
    session.add(suite)
    await session.flush()  # populate suite.id without committing

    runs: list[Run] = []
    for sc in scenarios:
        run = Run(
            org_id=org_id,
            agent_id=agent.id,
            scenario_id=sc.id,
            suite_id=suite.id,
            status="queued",
        )
        session.add(run)
        runs.append(run)
    await session.commit()
    for r in runs:
        await session.refresh(r)
        await publish(PLACE_CALL_STREAM, {"run_id": str(r.id)})
    await session.refresh(suite)

    detail = SuiteReadDetail.model_validate(suite)
    detail.runs = runs
    return detail
