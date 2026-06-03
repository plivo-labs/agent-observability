"""Observability URL env resolution + soft validation."""

from __future__ import annotations

import logging
import os

_LOGGER = logging.getLogger("agent_observability.livekit")


def resolve_observability_url() -> str | None:
    """Resolve the observability upload URL — pure, no side effects.

    Returns ``LIVEKIT_OBSERVABILITY_URL`` if set, otherwise the
    ``AGENT_OBSERVABILITY_URL`` fallback (the var name agent-transport
    uses), otherwise ``None``. Reads ``os.environ`` but never mutates it
    and never logs.

    Use this when you just want the value. Use
    :func:`ensure_observability_url` when you also need the fallback
    mirrored into ``LIVEKIT_OBSERVABILITY_URL`` for LiveKit's upload code.

    :return: The resolved URL, or ``None`` if neither env var was set.
    """
    return os.environ.get("LIVEKIT_OBSERVABILITY_URL") or os.environ.get(
        "AGENT_OBSERVABILITY_URL"
    )


def ensure_observability_url(
    *,
    logger: logging.Logger | None = None,
) -> str | None:
    """Resolve the observability upload URL **and mirror the fallback**.

    Resolves the URL via :func:`resolve_observability_url`
    (``LIVEKIT_OBSERVABILITY_URL`` first, then the
    ``AGENT_OBSERVABILITY_URL`` fallback agent-transport uses).

    Side effects:

    - **Mutates ``os.environ``**: when the value came from the
      ``AGENT_OBSERVABILITY_URL`` fallback, it is mirrored into
      ``LIVEKIT_OBSERVABILITY_URL`` so LiveKit's upload code picks it up
      on its next read. Call :func:`resolve_observability_url` instead if
      you want the value without touching the environment.
    - Logs ``INFO`` with the resolved URL when present.
    - Logs ``WARNING`` when the URL is unset (session report upload will
      no-op).

    :param logger: Override the module logger.
    :return: The resolved URL, or ``None`` if neither env var was set.
    """
    log = logger or _LOGGER

    url = resolve_observability_url()
    if url and not os.environ.get("LIVEKIT_OBSERVABILITY_URL"):
        # Value came from the AGENT_OBSERVABILITY_URL fallback — mirror it.
        os.environ["LIVEKIT_OBSERVABILITY_URL"] = url

    if url:
        log.info("agent-observability upload target: %s", url)
    else:
        log.warning(
            "neither LIVEKIT_OBSERVABILITY_URL nor AGENT_OBSERVABILITY_URL "
            "is set; session report upload will be skipped"
        )
    return url
