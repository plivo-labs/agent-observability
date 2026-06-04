from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.routers._crud import CrudService
from truman_calling.api.schemas.personas import PersonaCreate, PersonaRead, PersonaUpdate
from truman_calling.core.models import Persona

router = APIRouter(prefix="/v1/personas", tags=["personas"])
svc = CrudService(Persona)


@router.get("", response_model=list[PersonaRead])
async def list_personas(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.list(session, org_id)


@router.post("", response_model=PersonaRead, status_code=status.HTTP_201_CREATED)
async def create_persona(
    payload: PersonaCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.create(session, org_id, payload)


@router.get("/{persona_id}", response_model=PersonaRead)
async def get_persona(
    persona_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.get(session, org_id, persona_id)


@router.patch("/{persona_id}", response_model=PersonaRead)
async def update_persona(
    persona_id: uuid.UUID,
    payload: PersonaUpdate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return await svc.update(session, org_id, persona_id, payload)


@router.delete("/{persona_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_persona(
    persona_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    await svc.delete(session, org_id, persona_id)
