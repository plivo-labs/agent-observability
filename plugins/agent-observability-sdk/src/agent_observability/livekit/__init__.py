"""LiveKit-native helpers for agent-observability.

This submodule exists for workers that drive LiveKit Agents directly
(``@server.rtc_session(...)`` etc.) rather than via agent-transport's
``AudioStreamServer`` / ``AgentServer`` wrappers. agent-transport already
emits the observability tags and runs the configured judges; raw-LiveKit
users had to hand-roll the same wiring in every worker, and we kept
seeing the same shape get re-implemented (and subtly wrong — most often
a missing ``agent_id:<uuid>`` tag, which is now mandatory).

Three helpers, three problems:

* :func:`init_observability` — bootstrap the current session. Resolves
  the upload URL (raising if unset) and emits the tag bundle the
  server's ingest path expects (``agent_id:<value>``, optional
  ``account_id:``, ``agent_name:``, ``transport:`` + a wrapper
  ``agent.session`` metadata blob). One call replaces ~20 lines of
  hand-rolled ``tagger.add(...)`` plumbing.
* :func:`run_judges_on_report` — wrap the ``JudgeGroup`` setup,
  exception handling, structured logging, and ``llm.aclose()`` cleanup
  for the common case of running judges against ``ctx.make_session_report()``.
* :func:`ensure_observability_url` — soft-contract URL resolver that
  logs at INFO when set and WARN when not, and mirrors the
  ``AGENT_OBSERVABILITY_URL`` fallback into ``LIVEKIT_OBSERVABILITY_URL``.
  :func:`init_observability` builds on it but escalates to
  ``RuntimeError`` when missing; pull this one in directly when you need
  the non-fatal flavour (tests, local-only workers, opt-in
  observability). For the value without the env mutation or logging, use
  the pure :func:`resolve_observability_url`.

Import surface::

    from agent_observability.livekit import (
        Goal,
        init_observability,
        add_goal_tags,
        run_judges_on_report,
        ensure_observability_url,
        resolve_observability_url,
    )
"""

from __future__ import annotations

from agent_observability.livekit.env import (
    ensure_observability_url,
    resolve_observability_url,
)
from agent_observability.livekit.evaluation import run_judges_on_report
from agent_observability.livekit.goals import Goal
from agent_observability.livekit.tags import add_goal_tags, init_observability

__all__ = [
    "Goal",
    "ensure_observability_url",
    "add_goal_tags",
    "init_observability",
    "resolve_observability_url",
    "run_judges_on_report",
]
