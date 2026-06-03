from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from math import ceil
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.schemas.runs import RunAnalyticsRead, RunCreate, RunFailureHotspotRead, RunRead, RunTrendBucketRead
from truman_calling.core.models import Run, Scenario
from truman_calling.core.queue import PLACE_CALL_STREAM, publish

router = APIRouter(prefix="/v1/runs", tags=["runs"])


@router.get("", response_model=list[RunRead])
async def list_runs(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    limit: int = Query(50, ge=1, le=500),
    verdict: str | None = Query(None, description="pass | fail"),
    agent_id: uuid.UUID | None = Query(None),
    scenario_id: uuid.UUID | None = Query(None),
    run_status: str | None = Query(None, alias="status"),
):
    query = select(Run).where(Run.org_id == org_id)
    if verdict:
        query = query.where(Run.verdict == verdict)
    if agent_id:
        query = query.where(Run.agent_id == agent_id)
    if scenario_id:
        query = query.where(Run.scenario_id == scenario_id)
    if run_status:
        query = query.where(Run.status == run_status)
    query = query.order_by(Run.created_at.desc()).limit(limit)
    result = await session.execute(query)
    return list(result.scalars().all())


@router.get("/analytics", response_model=RunAnalyticsRead)
async def get_run_analytics(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    days: int = Query(14, ge=1, le=90),
    agent_id: uuid.UUID | None = Query(None),
    scenario_id: uuid.UUID | None = Query(None),
):
    end_day = datetime.now(timezone.utc).date()
    start_day = end_day - timedelta(days=days - 1)
    start_at = datetime.combine(start_day, time.min, tzinfo=timezone.utc)
    query = select(Run).where(Run.org_id == org_id, Run.created_at >= start_at)
    if agent_id:
        query = query.where(Run.agent_id == agent_id)
    if scenario_id:
        query = query.where(Run.scenario_id == scenario_id)
    result = await session.execute(query.order_by(Run.created_at.asc()))
    runs = list(result.scalars().all())
    return _build_analytics(runs, days, start_day)


@router.get("/{run_id}", response_model=RunRead)
async def get_run(
    run_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Run).where(Run.id == run_id, Run.org_id == org_id)
    )
    obj = result.scalar_one_or_none()
    if obj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    return obj


@router.post("", response_model=RunRead, status_code=status.HTTP_201_CREATED)
async def create_run(
    payload: RunCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    sc_result = await session.execute(
        select(Scenario).where(
            Scenario.id == payload.scenario_id, Scenario.org_id == org_id
        )
    )
    scenario = sc_result.scalar_one_or_none()
    if scenario is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "scenario not found")

    run = Run(
        org_id=org_id,
        agent_id=scenario.agent_id,
        scenario_id=scenario.id,
        status="queued",
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    await publish(PLACE_CALL_STREAM, {"run_id": str(run.id)})
    return run


def _build_analytics(runs: list[Run], days: int, start_day) -> RunAnalyticsRead:
    passes = sum(1 for run in runs if run.verdict == "pass")
    failures = sum(1 for run in runs if run.verdict == "fail")
    pending = len(runs) - passes - failures
    finished = passes + failures
    durations = [_duration_seconds(run) for run in runs]
    durations = [seconds for seconds in durations if seconds > 0]
    return RunAnalyticsRead(
        generated_at=datetime.now(timezone.utc),
        days=days,
        run_count=len(runs),
        pass_count=passes,
        fail_count=failures,
        pending_count=pending,
        pass_rate=round((passes / finished) * 100) if finished else None,
        avg_duration_seconds=round(sum(durations) / len(durations)) if durations else None,
        p95_duration_seconds=_percentile(durations, 0.95),
        trend=_trend_buckets(runs, days, start_day),
        top_failures=_failure_hotspots(runs),
    )


def _trend_buckets(runs: list[Run], days: int, start_day) -> list[RunTrendBucketRead]:
    runs_by_day = {start_day + timedelta(days=offset): [] for offset in range(days)}
    for run in runs:
        runs_by_day.setdefault(run.created_at.date(), []).append(run)
    buckets = []
    for day in sorted(runs_by_day):
        day_runs = runs_by_day[day]
        passes = sum(1 for run in day_runs if run.verdict == "pass")
        failures = sum(1 for run in day_runs if run.verdict == "fail")
        pending = len(day_runs) - passes - failures
        finished = passes + failures
        durations = [_duration_seconds(run) for run in day_runs]
        durations = [seconds for seconds in durations if seconds > 0]
        buckets.append(
            RunTrendBucketRead(
                date=day.isoformat(),
                run_count=len(day_runs),
                pass_count=passes,
                fail_count=failures,
                pending_count=pending,
                pass_rate=round((passes / finished) * 100) if finished else None,
                avg_duration_seconds=round(sum(durations) / len(durations)) if durations else None,
            )
        )
    return buckets


def _failure_hotspots(runs: list[Run]) -> list[RunFailureHotspotRead]:
    hotspots: dict[uuid.UUID, RunFailureHotspotRead] = {}
    for run in sorted(runs, key=lambda item: item.created_at):
        if run.verdict != "fail" and run.status != "failed":
            continue
        current = hotspots.get(run.scenario_id)
        hotspots[run.scenario_id] = RunFailureHotspotRead(
            scenario_id=run.scenario_id,
            latest_run_id=run.id,
            fail_count=(current.fail_count if current else 0) + 1,
            latest_reason=_failure_reason(run),
        )
    return sorted(hotspots.values(), key=lambda item: item.fail_count, reverse=True)[:5]


def _duration_seconds(run: Run) -> int:
    if not run.started_at or not run.ended_at:
        return 0
    return max(0, round((run.ended_at - run.started_at).total_seconds()))


def _percentile(values: list[int], percentile: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, ceil(len(ordered) * percentile) - 1)
    return ordered[index]


def _failure_reason(run: Run) -> str:
    if run.error:
        return run.error
    if run.judge_result and run.judge_result.get("notes"):
        return str(run.judge_result["notes"])
    if run.judge_result:
        for criterion in run.judge_result.get("criteria", []):
            if criterion.get("pass") is False and criterion.get("justification"):
                return str(criterion["justification"])
    return "No failure note."
