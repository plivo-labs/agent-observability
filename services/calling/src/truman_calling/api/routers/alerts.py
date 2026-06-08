from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.routers.calls import _read_call
from truman_calling.api.schemas.alerts import AlertReviewRead, AlertRuleCreate, AlertRuleRead, AlertRuleUpdate
from truman_calling.core.models import Agent, AlertRule, ObservedCall

router = APIRouter(prefix="/v1/alerts", tags=["alerts"])


@router.get("", response_model=list[AlertRuleRead])
async def list_alerts(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    limit: int = Query(100, ge=1, le=200),
):
    result = await session.execute(
        select(AlertRule)
        .where(AlertRule.org_id == org_id)
        .order_by(AlertRule.created_at.desc())
        .limit(limit)
    )
    rules = list(result.scalars().all())
    calls = await _recent_calls(session, org_id)
    return [_read_rule(rule, _matching_calls(rule, calls)) for rule in rules]


@router.post("", response_model=AlertRuleRead, status_code=status.HTTP_201_CREATED)
async def create_alert(
    payload: AlertRuleCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    await _ensure_agent(session, org_id, payload.agent_id)
    rule = AlertRule(org_id=org_id, **payload.model_dump())
    _normalize_rule(rule)
    _validate_rule(rule)
    session.add(rule)
    await session.commit()
    await session.refresh(rule)
    calls = await _recent_calls(session, org_id)
    return _read_rule(rule, _matching_calls(rule, calls))


@router.patch("/{alert_id}", response_model=AlertRuleRead)
async def update_alert(
    alert_id: uuid.UUID,
    payload: AlertRuleUpdate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    rule = await _get_rule(session, org_id, alert_id)
    data = payload.model_dump(exclude_unset=True)
    if "agent_id" in data:
        await _ensure_agent(session, org_id, data["agent_id"])
    for key, value in data.items():
        setattr(rule, key, value)
    _normalize_rule(rule)
    _validate_rule(rule)
    await session.commit()
    await session.refresh(rule)
    calls = await _recent_calls(session, org_id)
    return _read_rule(rule, _matching_calls(rule, calls))


@router.get("/{alert_id}/review", response_model=AlertReviewRead)
async def review_alert(
    alert_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    rule = await _get_rule(session, org_id, alert_id)
    calls = _matching_calls(rule, await _recent_calls(session, org_id))
    return AlertReviewRead(alert=_read_rule(rule, calls), calls=[_read_call(call) for call in calls])


@router.delete("/{alert_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_alert(
    alert_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    rule = await _get_rule(session, org_id, alert_id)
    await session.delete(rule)
    await session.commit()


async def _get_rule(session: AsyncSession, org_id: uuid.UUID, alert_id: uuid.UUID) -> AlertRule:
    result = await session.execute(
        select(AlertRule).where(AlertRule.id == alert_id, AlertRule.org_id == org_id)
    )
    rule = result.scalar_one_or_none()
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "alert not found")
    return rule


async def _ensure_agent(
    session: AsyncSession,
    org_id: uuid.UUID,
    agent_id: uuid.UUID | None,
) -> None:
    if agent_id is None:
        return
    result = await session.execute(select(Agent.id).where(Agent.id == agent_id, Agent.org_id == org_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")


async def _recent_calls(session: AsyncSession, org_id: uuid.UUID) -> list[ObservedCall]:
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    result = await session.execute(
        select(ObservedCall)
        .where(ObservedCall.org_id == org_id, ObservedCall.created_at >= since)
        .order_by(ObservedCall.created_at.desc())
    )
    return list(result.scalars().all())


def _normalize_rule(rule: AlertRule) -> None:
    rule.metric_key = rule.metric_key.strip().lower()
    rule.operator = rule.operator.strip().lower()
    rule.provider = rule.provider.strip().lower() if rule.provider else None
    rule.match_value = rule.match_value.strip() if rule.match_value else None
    rule.alert_type = rule.alert_type.strip().lower()
    rule.alert_direction = rule.alert_direction.strip().lower()
    rule.slack_channel = rule.slack_channel.strip() if rule.slack_channel else None


def _validate_rule(rule: AlertRule) -> None:
    if rule.metric_key == "duration_seconds":
        if rule.threshold_value is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "duration alerts require threshold")
        if rule.operator not in {"gte", "lte", "equals"}:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid duration operator")
    elif not rule.match_value:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "match value required")


def _matching_calls(rule: AlertRule, calls: list[ObservedCall]) -> list[ObservedCall]:
    if not rule.is_enabled:
        return []
    matches = [call for call in calls if _scope_matches(rule, call) and _condition_matches(rule, call)]
    return sorted(matches, key=lambda call: call.created_at, reverse=True)


def _scope_matches(rule: AlertRule, call: ObservedCall) -> bool:
    if rule.agent_id and call.agent_id != rule.agent_id:
        return False
    if rule.provider and call.provider != rule.provider:
        return False
    return True


def _condition_matches(rule: AlertRule, call: ObservedCall) -> bool:
    if rule.metric_key == "duration_seconds":
        return _number_matches(call.duration_seconds, rule.operator, rule.threshold_value)
    value = _metric_value(rule.metric_key, call)
    if value is None:
        return False
    needle = (rule.match_value or "").lower()
    haystack = value.lower()
    if rule.operator == "equals":
        return haystack == needle
    if rule.operator == "contains":
        return needle in haystack
    return False


def _metric_value(metric_key: str, call: ObservedCall) -> str | None:
    if metric_key == "ended_reason":
        return call.call_ended_reason
    if metric_key == "transcript_contains":
        return call.transcript_text
    if metric_key == "status":
        return call.status
    if metric_key == "provider":
        return call.provider
    return None


def _number_matches(value: int | None, operator: str, threshold: float | None) -> bool:
    if value is None or threshold is None:
        return False
    if operator == "gte":
        return value >= threshold
    if operator == "lte":
        return value <= threshold
    if operator == "equals":
        return value == threshold
    return False


def _read_rule(rule: AlertRule, matches: list[ObservedCall]) -> AlertRuleRead:
    latest = matches[0] if matches else None
    return AlertRuleRead(
        id=rule.id,
        name=rule.name,
        metric_key=rule.metric_key,
        operator=rule.operator,
        match_value=rule.match_value,
        threshold_value=rule.threshold_value,
        agent_id=rule.agent_id,
        provider=rule.provider,
        alert_type=rule.alert_type,
        alert_direction=rule.alert_direction,
        slack_channel=rule.slack_channel,
        is_enabled=rule.is_enabled,
        last_24h_count=len(matches),
        latest_call_id=latest.id if latest else None,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )
