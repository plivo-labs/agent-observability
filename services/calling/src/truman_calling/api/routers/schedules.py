from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.routers.results import _summarize_result
from truman_calling.api.schemas.results import ResultDetailRead
from truman_calling.api.schemas.schedules import (
    EvaluationScheduleCreate,
    EvaluationScheduleRead,
    EvaluationScheduleUpdate,
)
from truman_calling.core.models import Agent, EvaluationSchedule, Persona, Run, Scenario, Suite
from truman_calling.core.queue import PLACE_CALL_STREAM, publish

router = APIRouter(prefix="/v1/schedules", tags=["schedules"])


@router.get("", response_model=list[EvaluationScheduleRead])
async def list_schedules(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(EvaluationSchedule)
        .where(EvaluationSchedule.org_id == org_id)
        .order_by(EvaluationSchedule.created_at.desc())
    )
    return list(result.scalars().all())


@router.post("", response_model=EvaluationScheduleRead, status_code=status.HTTP_201_CREATED)
async def create_schedule(
    payload: EvaluationScheduleCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    scenario_ids = _unique_ids(payload.scenario_ids)
    persona_ids = _unique_ids(payload.personality_override_ids)
    await _validate_schedule_refs(session, org_id, payload.agent_id, scenario_ids, persona_ids)
    cron_expression = _normalize_cron(payload.cron_expression)
    next_run_at = (
        _next_cron_run(cron_expression, payload.timezone) if payload.is_enabled else None
    )

    schedule = EvaluationSchedule(
        org_id=org_id,
        name=payload.name.strip(),
        agent_id=payload.agent_id,
        scenario_ids=[str(scenario_id) for scenario_id in scenario_ids],
        cron_expression=cron_expression,
        timezone=payload.timezone,
        personality_override_ids=[str(persona_id) for persona_id in persona_ids],
        execution_mode=payload.execution_mode,
        run_limit=payload.run_limit,
        is_enabled=payload.is_enabled,
        next_run_at=next_run_at,
    )
    session.add(schedule)
    await session.commit()
    await session.refresh(schedule)
    return schedule


@router.patch("/{schedule_id}", response_model=EvaluationScheduleRead)
async def update_schedule(
    schedule_id: uuid.UUID,
    payload: EvaluationScheduleUpdate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    schedule = await _get_schedule(session, org_id, schedule_id)
    data = payload.model_dump(exclude_unset=True)

    agent_id = data.get("agent_id", schedule.agent_id)
    scenario_ids = _unique_ids(data.get("scenario_ids", _schedule_scenario_ids(schedule)))
    persona_ids = _unique_ids(
        data.get("personality_override_ids", _schedule_personality_ids(schedule))
    )
    if {"agent_id", "scenario_ids", "personality_override_ids"} & set(data):
        await _validate_schedule_refs(session, org_id, agent_id, scenario_ids, persona_ids)

    if "name" in data and data["name"] is not None:
        schedule.name = data["name"].strip()
    if "agent_id" in data:
        schedule.agent_id = agent_id
    if "scenario_ids" in data:
        schedule.scenario_ids = [str(scenario_id) for scenario_id in scenario_ids]
    if "personality_override_ids" in data:
        schedule.personality_override_ids = [str(persona_id) for persona_id in persona_ids]
    if "cron_expression" in data and data["cron_expression"] is not None:
        schedule.cron_expression = _normalize_cron(data["cron_expression"])
    if "timezone" in data and data["timezone"] is not None:
        schedule.timezone = data["timezone"]
    if "execution_mode" in data and data["execution_mode"] is not None:
        schedule.execution_mode = data["execution_mode"]
    if "run_limit" in data:
        schedule.run_limit = data["run_limit"]
    if "is_enabled" in data and data["is_enabled"] is not None:
        schedule.is_enabled = data["is_enabled"]

    schedule.next_run_at = _schedule_next_run(schedule)
    await session.commit()
    await session.refresh(schedule)
    return schedule


@router.post("/{schedule_id}/run", response_model=ResultDetailRead, status_code=status.HTTP_201_CREATED)
async def run_schedule_now(
    schedule_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    schedule = await _get_schedule(session, org_id, schedule_id)
    if schedule.run_limit is not None and schedule.run_count >= schedule.run_limit:
        raise HTTPException(status.HTTP_409_CONFLICT, "schedule run limit reached")

    scenarios = await _load_scenarios(session, org_id, _schedule_scenario_ids(schedule))
    if not scenarios:
        raise HTTPException(status.HTTP_409_CONFLICT, "schedule has no scenarios")

    suite = Suite(
        org_id=org_id,
        name=f"Scheduled: {schedule.name}",
        status="queued",
    )
    session.add(suite)
    await session.flush()

    runs = [
        Run(
            org_id=org_id,
            agent_id=schedule.agent_id,
            scenario_id=scenario.id,
            suite_id=suite.id,
            status="queued",
        )
        for scenario in scenarios
    ]
    session.add_all(runs)
    schedule.run_count += 1
    schedule.last_run_at = datetime.now(timezone.utc)
    schedule.next_run_at = _schedule_next_run(schedule)
    await session.commit()

    for run in runs:
        await publish(PLACE_CALL_STREAM, {"run_id": str(run.id)})

    return _summarize_result(suite, runs, include_runs=True)


@router.delete("/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(
    schedule_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    schedule = await _get_schedule(session, org_id, schedule_id)
    await session.delete(schedule)
    await session.commit()


async def _get_schedule(
    session: AsyncSession,
    org_id: uuid.UUID,
    schedule_id: uuid.UUID,
) -> EvaluationSchedule:
    result = await session.execute(
        select(EvaluationSchedule).where(
            EvaluationSchedule.id == schedule_id,
            EvaluationSchedule.org_id == org_id,
        )
    )
    schedule = result.scalar_one_or_none()
    if schedule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "schedule not found")
    return schedule


async def _validate_schedule_refs(
    session: AsyncSession,
    org_id: uuid.UUID,
    agent_id: uuid.UUID,
    scenario_ids: list[uuid.UUID],
    persona_ids: list[uuid.UUID],
) -> None:
    agent_result = await session.execute(
        select(Agent.id).where(Agent.id == agent_id, Agent.org_id == org_id)
    )
    if agent_result.scalar_one_or_none() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")

    await _load_scenarios(session, org_id, scenario_ids, strict=True)
    if persona_ids:
        persona_result = await session.execute(
            select(Persona.id).where(Persona.org_id == org_id, Persona.id.in_(persona_ids))
        )
        found = set(persona_result.scalars().all())
        missing = [persona_id for persona_id in persona_ids if persona_id not in found]
        if missing:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"persona not found: {missing[0]}")


async def _load_scenarios(
    session: AsyncSession,
    org_id: uuid.UUID,
    scenario_ids: list[uuid.UUID],
    *,
    strict: bool = False,
) -> list[Scenario]:
    result = await session.execute(
        select(Scenario).where(Scenario.org_id == org_id, Scenario.id.in_(scenario_ids))
    )
    scenarios = list(result.scalars().all())
    scenario_by_id = {scenario.id: scenario for scenario in scenarios}
    if strict:
        missing = [scenario_id for scenario_id in scenario_ids if scenario_id not in scenario_by_id]
        if missing:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"scenario not found: {missing[0]}")
    return [scenario_by_id[scenario_id] for scenario_id in scenario_ids if scenario_id in scenario_by_id]


def _unique_ids(values: list[uuid.UUID]) -> list[uuid.UUID]:
    return list(dict.fromkeys(values))


def _schedule_scenario_ids(schedule: EvaluationSchedule) -> list[uuid.UUID]:
    return [uuid.UUID(str(scenario_id)) for scenario_id in schedule.scenario_ids]


def _schedule_personality_ids(schedule: EvaluationSchedule) -> list[uuid.UUID]:
    return [uuid.UUID(str(persona_id)) for persona_id in schedule.personality_override_ids]


def _normalize_cron(expression: str) -> str:
    parts = expression.strip().split()
    if len(parts) != 5:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cron expression must have 5 fields")
    try:
        _parse_cron_parts(parts)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return " ".join(parts)


def _schedule_next_run(schedule: EvaluationSchedule) -> datetime | None:
    if not schedule.is_enabled:
        return None
    if schedule.run_limit is not None and schedule.run_count >= schedule.run_limit:
        return None
    return _next_cron_run(schedule.cron_expression, schedule.timezone)


def _next_cron_run(
    expression: str,
    timezone_name: str,
    *,
    now: datetime | None = None,
) -> datetime:
    try:
        zone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "unknown timezone") from exc

    fields = _parse_cron_parts(expression.split())
    current = (now or datetime.now(timezone.utc)).astimezone(zone)
    candidate = current.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(366 * 24 * 60):
        cron_dow = (candidate.weekday() + 1) % 7
        if (
            candidate.minute in fields[0]
            and candidate.hour in fields[1]
            and candidate.day in fields[2]
            and candidate.month in fields[3]
            and cron_dow in fields[4]
        ):
            return candidate.astimezone(timezone.utc)
        candidate += timedelta(minutes=1)
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cron expression has no yearly match")


def _parse_cron_parts(parts: list[str]) -> tuple[set[int], set[int], set[int], set[int], set[int]]:
    if len(parts) != 5:
        raise ValueError("cron expression must have 5 fields")
    minute = _parse_cron_field(parts[0], 0, 59, "minute")
    hour = _parse_cron_field(parts[1], 0, 23, "hour")
    day = _parse_cron_field(parts[2], 1, 31, "day of month")
    month = _parse_cron_field(parts[3], 1, 12, "month")
    weekday = _parse_cron_field(parts[4], 0, 7, "day of week")
    if 7 in weekday:
        weekday = {0 if value == 7 else value for value in weekday}
    return minute, hour, day, month, weekday


def _parse_cron_field(raw: str, minimum: int, maximum: int, label: str) -> set[int]:
    values: set[int] = set()
    for part in raw.split(","):
        if not part:
            raise ValueError(f"empty {label} field")
        values.update(_parse_cron_part(part, minimum, maximum, label))
    return values


def _parse_cron_part(part: str, minimum: int, maximum: int, label: str) -> set[int]:
    base = part
    step = 1
    if "/" in part:
        base, step_raw = part.split("/", 1)
        if not step_raw.isdigit() or int(step_raw) <= 0:
            raise ValueError(f"invalid {label} step")
        step = int(step_raw)

    if base == "*":
        start, end = minimum, maximum
    elif "-" in base:
        start_raw, end_raw = base.split("-", 1)
        start, end = _cron_int(start_raw, label), _cron_int(end_raw, label)
    else:
        start = end = _cron_int(base, label)

    if start < minimum or end > maximum or start > end:
        raise ValueError(f"{label} field out of range")
    return set(range(start, end + 1, step))


def _cron_int(value: str, label: str) -> int:
    if not value.isdigit():
        raise ValueError(f"invalid {label} value")
    return int(value)
