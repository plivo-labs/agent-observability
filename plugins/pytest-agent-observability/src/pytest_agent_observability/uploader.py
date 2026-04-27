"""POST the eval payload to agent-observability with retries and local fallback."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import httpx


logger = logging.getLogger("pytest_agent_observability")


class UploadConfig:
    __slots__ = ("url", "basic_auth", "timeout_s", "max_retries")

    def __init__(
        self,
        *,
        url: str,
        basic_auth: Optional[tuple[str, str]] = None,
        timeout_s: float = 10.0,
        max_retries: int = 3,
    ) -> None:
        self.url = url.rstrip("/")
        self.basic_auth = basic_auth
        self.timeout_s = timeout_s
        self.max_retries = max_retries


def upload(payload: dict, config: UploadConfig, *, fallback_dir: Optional[Path] = None) -> bool:
    """POST the payload to `{url}/observability/evals/v0`.

    Returns True on success. On total failure (all retries exhausted), writes
    the payload to `fallback_dir/<run_id>.json` if provided and returns False.
    Never raises — the plugin must not break tests.
    """
    endpoint = f"{config.url}/observability/evals/v0"
    auth = config.basic_auth

    last_err: Optional[str] = None
    for attempt in range(1, config.max_retries + 1):
        try:
            with httpx.Client(timeout=config.timeout_s) as client:
                resp = client.post(
                    endpoint,
                    json=payload,
                    auth=auth,
                    headers={"Content-Type": "application/json"},
                )
            if 200 <= resp.status_code < 300:
                return True
            # 4xx is a permanent failure — don't retry.
            if 400 <= resp.status_code < 500:
                last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
                break
            last_err = f"HTTP {resp.status_code}"
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"

        if attempt < config.max_retries:
            time.sleep(min(2 ** (attempt - 1), 4))  # 1s, 2s, then 4s

    logger.warning(
        "agent-observability upload failed after %d attempts: %s",
        config.max_retries,
        last_err,
    )
    if fallback_dir is not None:
        _write_fallback(payload, fallback_dir)
    return False


def _write_fallback(payload: dict, fallback_dir: Path) -> None:
    try:
        fallback_dir.mkdir(parents=True, exist_ok=True)
        run_id = payload.get("run", {}).get("run_id", "unknown")
        path = fallback_dir / f"{run_id}.json"
        path.write_text(json.dumps(payload, indent=2))
        logger.warning("wrote eval payload to %s", path)
    except Exception as e:
        logger.error("failed to write fallback payload: %s", e)


def config_from_env() -> Optional[UploadConfig]:
    """Build an UploadConfig from env vars. Returns None if URL is missing.

    Reads `AGENT_OBSERVABILITY_TIMEOUT` (seconds) and
    `AGENT_OBSERVABILITY_MAX_RETRIES` alongside the required URL + optional
    basic-auth pair. Invalid numeric values fall back to the defaults.
    """
    url = os.getenv("AGENT_OBSERVABILITY_URL")
    if not url:
        return None
    user = os.getenv("AGENT_OBSERVABILITY_USER")
    pw = os.getenv("AGENT_OBSERVABILITY_PASS")
    auth: Optional[tuple[str, str]] = (user, pw) if user and pw else None
    return UploadConfig(
        url=url,
        basic_auth=auth,
        timeout_s=_env_float("AGENT_OBSERVABILITY_TIMEOUT", 10.0),
        max_retries=_env_int("AGENT_OBSERVABILITY_MAX_RETRIES", 3),
    )


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default
