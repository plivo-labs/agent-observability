from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.routers._crud import CrudService
from truman_calling.api.schemas.rubrics import RubricCreate, RubricRead, RubricUpdate
from truman_calling.core.models import Rubric

router = APIRouter(prefix="/v1/rubrics", tags=["rubrics"])
svc = CrudService(Rubric)


@router.get("", response_model=list[RubricRead])
async def list_rubrics(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.list(session, org_id)


@router.post("", response_model=RubricRead, status_code=status.HTTP_201_CREATED)
async def create_rubric(
    payload: RubricCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    # criteria comes in as list[Criterion]; persist as list[dict]
    data = payload.model_dump()
    obj = Rubric(org_id=org_id, **data)
    session.add(obj)
    await session.commit()
    await session.refresh(obj)
    return obj


@router.get("/{rubric_id}", response_model=RubricRead)
async def get_rubric(
    rubric_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.get(session, org_id, rubric_id)


@router.patch("/{rubric_id}", response_model=RubricRead)
async def update_rubric(
    rubric_id: uuid.UUID,
    payload: RubricUpdate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.update(session, org_id, rubric_id, payload)


@router.delete("/{rubric_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rubric(
    rubric_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    await svc.delete(session, org_id, rubric_id)
