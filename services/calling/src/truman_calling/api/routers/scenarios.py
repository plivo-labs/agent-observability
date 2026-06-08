from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.routers._crud import CrudService
from truman_calling.api.schemas.auto_gen import AutoGenRequest, AutoGenResponse
from truman_calling.api.schemas.scenarios import ScenarioCreate, ScenarioRead, ScenarioRevisionRead, ScenarioUpdate
from truman_calling.api.services.auto_gen import generate_scenarios
from truman_calling.core.models import Scenario, ScenarioRevision

router = APIRouter(prefix="/v1/scenarios", tags=["scenarios"])
svc = CrudService(Scenario)

REVISION_FIELDS = (
    "name",
    "agent_id",
    "persona_id",
    "rubric_id",
    "profile_id",
    "expected_outcomes",
    "opener_instructions",
    "language",
    "tags",
    "max_call_duration_seconds",
    "allow_dtmf",
    "allow_sms",
    "allow_end_call",
)

FIELD_LABELS = {
    "agent_id": "agent",
    "persona_id": "persona",
    "rubric_id": "metric set",
    "profile_id": "profile",
    "expected_outcomes": "expected outcomes",
    "opener_instructions": "opener",
    "max_call_duration_seconds": "max duration",
    "allow_dtmf": "DTMF",
    "allow_sms": "SMS",
    "allow_end_call": "end call",
}


def _json_value(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def _scenario_snapshot(scenario: Scenario) -> dict[str, Any]:
    return {field: _json_value(getattr(scenario, field)) for field in REVISION_FIELDS}


def _changed_fields(before: dict[str, Any], payload: BaseModel) -> list[str]:
    data = payload.model_dump(exclude_unset=True)
    return [
        field
        for field, value in data.items()
        if field in REVISION_FIELDS and _json_value(before[field]) != _json_value(value)
    ]


def _change_summary(changed_fields: list[str], *, created: bool = False) -> str:
    if created:
        return "Created scenario"
    labels = [FIELD_LABELS.get(field, field.replace("_", " ")) for field in changed_fields]
    if len(labels) <= 3:
        return f"Updated {', '.join(labels)}"
    return f"Updated {', '.join(labels[:3])} +{len(labels) - 3} more"


async def _next_revision_version(session: AsyncSession, scenario_id: uuid.UUID) -> int:
    result = await session.execute(
        select(func.max(ScenarioRevision.version)).where(ScenarioRevision.scenario_id == scenario_id)
    )
    return (result.scalar_one_or_none() or 0) + 1


async def _add_revision(
    session: AsyncSession,
    scenario: Scenario,
    changed_fields: list[str],
    *,
    created: bool = False,
    change_summary: str | None = None,
) -> None:
    session.add(
        ScenarioRevision(
            org_id=scenario.org_id,
            scenario_id=scenario.id,
            version=await _next_revision_version(session, scenario.id),
            change_summary=change_summary or _change_summary(changed_fields, created=created),
            changed_fields=changed_fields,
            snapshot=_scenario_snapshot(scenario),
        )
    )


@router.get("", response_model=list[ScenarioRead])
async def list_scenarios(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    agent_id: uuid.UUID | None = None,
):
    query = select(Scenario).where(Scenario.org_id == org_id)
    if agent_id:
        query = query.where(Scenario.agent_id == agent_id)
    result = await session.execute(query.order_by(Scenario.name))
    return list(result.scalars().all())


@router.post("", response_model=ScenarioRead, status_code=status.HTTP_201_CREATED)
async def create_scenario(
    payload: ScenarioCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    scenario = Scenario(org_id=org_id, **payload.model_dump())
    session.add(scenario)
    await session.flush()
    await _add_revision(session, scenario, ["created"], created=True)
    await session.commit()
    await session.refresh(scenario)
    return scenario


@router.get("/{scenario_id}", response_model=ScenarioRead)
async def get_scenario(
    scenario_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.get(session, org_id, scenario_id)


@router.patch("/{scenario_id}", response_model=ScenarioRead)
async def update_scenario(
    scenario_id: uuid.UUID,
    payload: ScenarioUpdate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    scenario = await svc.get(session, org_id, scenario_id)
    before = _scenario_snapshot(scenario)
    changed_fields = _changed_fields(before, payload)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(scenario, key, value)
    if changed_fields:
        await session.flush()
        await _add_revision(session, scenario, changed_fields)
    await session.commit()
    await session.refresh(scenario)
    return scenario


@router.get("/{scenario_id}/revisions", response_model=list[ScenarioRevisionRead])
async def list_scenario_revisions(
    scenario_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    await svc.get(session, org_id, scenario_id)
    result = await session.execute(
        select(ScenarioRevision)
        .where(
            ScenarioRevision.org_id == org_id,
            ScenarioRevision.scenario_id == scenario_id,
        )
        .order_by(ScenarioRevision.version.desc())
    )
    return list(result.scalars().all())


@router.post("/{scenario_id}/revisions/{revision_id}/restore", response_model=ScenarioRead)
async def restore_scenario_revision(
    scenario_id: uuid.UUID,
    revision_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    scenario = await svc.get(session, org_id, scenario_id)
    result = await session.execute(
        select(ScenarioRevision).where(
            ScenarioRevision.id == revision_id,
            ScenarioRevision.org_id == org_id,
            ScenarioRevision.scenario_id == scenario_id,
        )
    )
    revision = result.scalar_one_or_none()
    if revision is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "revision not found")

    restore_payload = ScenarioUpdate.model_validate(
        {field: revision.snapshot[field] for field in REVISION_FIELDS if field in revision.snapshot}
    )
    before = _scenario_snapshot(scenario)
    changed_fields = _changed_fields(before, restore_payload)
    if not changed_fields:
        return scenario

    for key, value in restore_payload.model_dump(exclude_unset=True).items():
        setattr(scenario, key, value)
    await session.flush()
    await _add_revision(
        session,
        scenario,
        changed_fields,
        change_summary=f"Restored version {revision.version}",
    )
    await session.commit()
    await session.refresh(scenario)
    return scenario


@router.delete("/{scenario_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scenario(
    scenario_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    await svc.delete(session, org_id, scenario_id)


@router.post("/auto-generate", response_model=AutoGenResponse)
async def auto_generate_scenarios(
    payload: AutoGenRequest,
    org_id: uuid.UUID = Depends(require_auth),
):
    try:
        candidates = await generate_scenarios(payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return AutoGenResponse(candidates=candidates)
