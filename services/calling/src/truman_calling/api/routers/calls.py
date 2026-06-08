from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.schemas.calls import ObservedCallIngest, ObservedCallRead, TranscriptSegment
from truman_calling.core.models import Agent, ObservedCall

router = APIRouter(prefix="/v1/calls", tags=["calls"])


@router.get("", response_model=list[ObservedCallRead])
async def list_calls(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    limit: int = Query(50, ge=1, le=200),
    agent_id: uuid.UUID | None = Query(None),
    provider: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
):
    query = select(ObservedCall).where(ObservedCall.org_id == org_id)
    if agent_id:
        query = query.where(ObservedCall.agent_id == agent_id)
    if provider:
        query = query.where(ObservedCall.provider == provider)
    if status_filter:
        query = query.where(ObservedCall.status == status_filter)
    result = await session.execute(query.order_by(ObservedCall.created_at.desc()).limit(limit))
    return [_read_call(call) for call in result.scalars().all()]


@router.post("/ingest", response_model=ObservedCallRead, status_code=status.HTTP_201_CREATED)
async def ingest_call(
    payload: ObservedCallIngest,
    response: Response,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    await _ensure_agent(session, org_id, payload.agent_id)
    provider = payload.provider.strip().lower()
    external_call_id = payload.external_call_id.strip()
    if not external_call_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "call id is required")

    existing = await session.execute(
        select(ObservedCall).where(
            ObservedCall.org_id == org_id,
            ObservedCall.provider == provider,
            ObservedCall.external_call_id == external_call_id,
        )
    )
    call = existing.scalar_one_or_none()
    if call is None:
        call = ObservedCall(
            org_id=org_id,
            agent_id=payload.agent_id,
            provider=provider,
            external_call_id=external_call_id,
        )
        session.add(call)
    else:
        response.status_code = status.HTTP_200_OK

    _apply_payload(call, payload)
    await session.commit()
    await session.refresh(call)
    return _read_call(call)


@router.get("/{call_id}", response_model=ObservedCallRead)
async def get_call(
    call_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    return _read_call(await _get_call(session, org_id, call_id))


@router.delete("/{call_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_call(
    call_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    call = await _get_call(session, org_id, call_id)
    await session.delete(call)
    await session.commit()


async def _ensure_agent(session: AsyncSession, org_id: uuid.UUID, agent_id: uuid.UUID) -> None:
    result = await session.execute(
        select(Agent.id).where(Agent.id == agent_id, Agent.org_id == org_id)
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")


async def _get_call(session: AsyncSession, org_id: uuid.UUID, call_id: uuid.UUID) -> ObservedCall:
    result = await session.execute(
        select(ObservedCall).where(ObservedCall.id == call_id, ObservedCall.org_id == org_id)
    )
    call = result.scalar_one_or_none()
    if call is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "call not found")
    return call


def _apply_payload(call: ObservedCall, payload: ObservedCallIngest) -> None:
    transcript_json = (
        [segment.model_dump() for segment in payload.transcript_json]
        if payload.transcript_json is not None
        else None
    )
    call.agent_id = payload.agent_id
    call.provider = payload.provider.strip().lower()
    call.external_call_id = payload.external_call_id.strip()
    call.voice_recording_url = payload.voice_recording_url
    call.transcript_type = payload.transcript_type.strip().lower()
    call.transcript_json = transcript_json
    call.transcript_text = payload.transcript_text or _transcript_text(payload.transcript_json)
    call.call_ended_reason = payload.call_ended_reason
    call.status = payload.status.strip().lower()
    call.started_at = payload.started_at
    call.ended_at = payload.ended_at
    call.duration_seconds = (
        payload.duration_seconds
        if payload.duration_seconds is not None
        else _duration_seconds(payload.started_at, payload.ended_at)
    )
    call.call_metadata = payload.metadata


def _read_call(call: ObservedCall) -> ObservedCallRead:
    return ObservedCallRead(
        id=call.id,
        agent_id=call.agent_id,
        provider=call.provider,
        external_call_id=call.external_call_id,
        voice_recording_url=call.voice_recording_url,
        transcript_type=call.transcript_type,
        transcript_json=call.transcript_json,
        transcript_text=call.transcript_text,
        call_ended_reason=call.call_ended_reason,
        status=call.status,
        started_at=call.started_at,
        ended_at=call.ended_at,
        duration_seconds=call.duration_seconds,
        metadata=call.call_metadata,
        created_at=call.created_at,
        updated_at=call.updated_at,
    )


def _transcript_text(segments: list[TranscriptSegment] | None) -> str | None:
    if not segments:
        return None
    rows = []
    for segment in segments:
        role = segment.role.strip().lower() or "unknown"
        rows.append(f"{role}: {segment.content.strip()}")
    return "\n".join(row for row in rows if row.strip())


def _duration_seconds(started_at: datetime | None, ended_at: datetime | None) -> int | None:
    if not started_at or not ended_at:
        return None
    return max(0, round((ended_at - started_at).total_seconds()))
