"""Observability URL env resolution + soft validation."""

from __future__ import annotations

import logging
import os

_LOGGER = logging.getLogger("agent_observability.livekit")


def ensure_observability_url(
    *,
    logger: logging.Logger | None = None,
) -> str | None:
    """Resolve the observability upload URL the LiveKit SDK reads.

    Reads ``LIVEKIT_OBSERVABILITY_URL``. When unset, falls back to
    ``AGENT_OBSERVABILITY_URL`` (the var name agent-transport uses); the
    fallback value is mirrored back into ``LIVEKIT_OBSERVABILITY_URL`` so
    LiveKit's upload code picks it up on its next read.

    Side effects:

    - Logs ``INFO`` with the resolved URL when present.
    - Logs ``WARNING`` when the URL is unset (session report upload will
      no-op).

    :param logger: Override the module logger.
    :return: The resolved URL, or ``None`` if neither env var was set.
    """
    log = logger or _LOGGER

    url = os.environ.get("LIVEKIT_OBSERVABILITY_URL")
    if not url:
        fallback = os.environ.get("AGENT_OBSERVABILITY_URL")
        if fallback:
            os.environ["LIVEKIT_OBSERVABILITY_URL"] = fallback
            url = fallback

    if url:
        log.info("agent-observability upload target: %s", url)
    else:
        log.warning(
            "neither LIVEKIT_OBSERVABILITY_URL nor AGENT_OBSERVABILITY_URL "
            "is set; session report upload will be skipped"
        )
    return url
