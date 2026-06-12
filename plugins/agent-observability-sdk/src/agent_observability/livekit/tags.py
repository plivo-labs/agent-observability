"""Per-session observability bootstrap for raw-LiveKit workers.

The agent-observability v2 server pulls ``agent_id`` (mandatory) and
``account_id`` (optional) out of the multipart session report by
scanning two locations:

1. The top-level ``raw_report.agent_id`` / ``raw_report.account_id``.
2. Each tag string in ``raw_report.tags[]`` looking for the prefix
   ``"agent_id:"`` / ``"account_id:"``.

LiveKit's tagger writes tag names verbatim into ``raw_report.tags``, so
emitting a tag named ``"agent_id:<uuid>"`` is the canonical way to
satisfy the server. agent-transport's own ``_ensure_transport_tags``
uses exactly this shape; :func:`init_observability` just exposes it as a
public API for workers that don't go through agent-transport, while also
fast-failing if the upload URL is unset.

The wrapper ``agent.session`` tag is added for raw_report fidelity — the
metadata dict carries the same fields semantically and is convenient for
the dashboard to inspect without parsing tag strings.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Sequence

from agent_observability.livekit.env import ensure_observability_url


def _normalize_goal(goal: str | tuple[str, str]) -> dict[str, str]:
    """Validate one goal and return ``{"name": ..., "description"?: ...}``
    (no ``description`` key for name-only goals).

    The server splits the ``goal:`` tag at the FIRST colon after the
    prefix, so the name is the goal's stable identity and must not
    contain colons; the description may.
    """
    if isinstance(goal, tuple):
        raw_name, raw_description = goal
    else:
        raw_name, raw_description = goal, ""
    name = raw_name.strip()
    if not name:
        raise ValueError("init_observability: goal name must be non-empty")
    if ":" in name:
        raise ValueError(
            f"init_observability: goal name {name!r} must not contain a colon — "
            "the server splits goal tags at the first colon, so a colon in the "
            "name would corrupt the goal's identity. Put colons in the "
            "description instead."
        )
    description = raw_description.strip()
    return {"name": name, "description": description} if description else {"name": name}


def _normalize_goals(goals: Sequence[str | tuple[str, str]]) -> list[dict[str, str]]:
    """Validate every goal, rejecting duplicate names: the server dedupes
    first-wins, so a duplicate here would silently drop a description —
    almost certainly a bug in the calling agent code."""
    normalized = [_normalize_goal(g) for g in goals]
    seen: set[str] = set()
    for goal in normalized:
        if goal["name"] in seen:
            raise ValueError(
                f"init_observability: duplicate goal name {goal['name']!r} — "
                "goal names are the goal's stable identity and must be unique "
                "per session."
            )
        seen.add(goal["name"])
    return normalized


def init_observability(
    tagger: Any,
    *,
    agent_id: str | None = None,
    agent_name: str | None = None,
    account_id: str | None = None,
    transport: str | None = None,
    goals: Sequence[str | tuple[str, str]] | None = None,
    extra_metadata: dict[str, Any] | None = None,
    logger: logging.Logger | None = None,
) -> str:
    """Bootstrap agent-observability for the current LiveKit session.

    Does two things, atomically, in this order:

    1. Resolves the upload URL via :func:`ensure_observability_url`. If
       neither ``LIVEKIT_OBSERVABILITY_URL`` nor ``AGENT_OBSERVABILITY_URL``
       is set, raises ``RuntimeError`` — there is no point continuing if
       the session report has nowhere to go.
    2. Emits the tag bundle the v2 server's ingest path expects:

       - ``agent_id:<value>`` (always)
       - ``account_id:<value>`` (when supplied)
       - ``agent_name:<value>`` (when supplied)
       - ``transport:<value>`` (when supplied)
       - ``goal:<name>:<description>`` per goal (when supplied; bare
         ``goal:<name>`` for name-only goals)
       - ``agent.session`` (wrapper with everything in metadata)

    :param tagger: A LiveKit tagger. Anything with an
        ``add(name, metadata=...)`` method works — typically
        ``ctx.tagger`` inside a ``@server.rtc_session(...)`` entrypoint
        or ``on_session_end``.
    :param agent_id: Stable opaque agent identifier. Falls back to
        ``AGENT_OBSERVABILITY_AGENT_ID`` when omitted. Required by this
        helper: the server accepts uploads without an ``agent_id`` (it
        nulls the column and waits for an OTLP tag to backfill), but
        without this helper emitting the tag the backfill never lands
        and the session stays unparented on the dashboard.
    :param agent_name: Human-readable label. Optional.
    :param account_id: Tenant / customer identifier for multi-tenant
        dashboards. Optional.
    :param transport: Short label like ``"text"``, ``"audio"``, ``"sip"``.
        Optional.
    :param goals: Conversation goals the server's goal analyzer judges
        after each session. Each entry is ``(name, description)`` or a
        bare ``name`` string. The name is the goal's stable, filterable
        identity — it must not contain colons; the description (what the
        LLM judge evaluates) may. Optional.
    :param extra_metadata: Extra key/value pairs to ride along on the
        wrapper ``agent.session`` tag's metadata. No atomic tags are
        derived from these — they only land in the raw_report for
        inspection.
    :param logger: Override the module logger for the URL info / warn
        line. Defaults to ``agent_observability.livekit``.
    :return: The resolved ``agent_id``.
    :raises RuntimeError: When neither ``LIVEKIT_OBSERVABILITY_URL`` nor
        ``AGENT_OBSERVABILITY_URL`` is set. Call
        :func:`ensure_observability_url` directly if you need a softer
        contract.
    :raises ValueError: When ``agent_id`` cannot be resolved (neither
        passed in nor in env).
    """
    if ensure_observability_url(logger=logger) is None:
        raise RuntimeError(
            "init_observability: no upload target. Set "
            "LIVEKIT_OBSERVABILITY_URL (or AGENT_OBSERVABILITY_URL) "
            "before initializing. Use ensure_observability_url() directly "
            "if you want a non-fatal warn-only contract."
        )

    resolved_agent_id = agent_id or os.environ.get("AGENT_OBSERVABILITY_AGENT_ID")
    if not resolved_agent_id:
        raise ValueError(
            "init_observability: agent_id is required. Pass "
            "agent_id='<uuid>' or set AGENT_OBSERVABILITY_AGENT_ID. "
            "The server accepts uploads without one, but the session "
            "will sit unparented on the dashboard with no agent_id "
            "backfill ever arriving."
        )

    # Validate goals up front so a bad name fails before any tag lands.
    normalized_goals = _normalize_goals(goals) if goals else []

    metadata: dict[str, Any] = {"agent_id": resolved_agent_id}
    if agent_name:
        metadata["agent_name"] = agent_name
    if account_id:
        metadata["account_id"] = account_id
    if transport:
        metadata["transport"] = transport
    if normalized_goals:
        metadata["goals"] = normalized_goals
    if extra_metadata:
        metadata.update(extra_metadata)

    # Wrapper tag — carries everything in metadata for raw_report fidelity.
    tagger.add("agent.session", metadata=metadata)

    # Atomic tags — what the server's extractors actually pattern-match on.
    tagger.add(
        f"agent_id:{resolved_agent_id}",
        metadata={"agent_id": resolved_agent_id},
    )
    if account_id:
        tagger.add(
            f"account_id:{account_id}",
            metadata={"account_id": account_id},
        )
    if agent_name:
        tagger.add(
            f"agent_name:{agent_name}",
            metadata={"agent_name": agent_name},
        )
    if transport:
        tagger.add(
            f"transport:{transport}",
            metadata={"transport": transport},
        )
    for goal in normalized_goals:
        description = goal.get("description")
        tagger.add(
            f"goal:{goal['name']}:{description}" if description else f"goal:{goal['name']}",
            metadata=dict(goal),
        )

    return resolved_agent_id
