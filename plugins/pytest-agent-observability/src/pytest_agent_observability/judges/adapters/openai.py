"""OpenAI-compatible LLM adapter using httpx (already a project dependency)."""

from __future__ import annotations

from typing import Any

import httpx

from ..types import LLMClient


def openai_adapter(
    api_key: str,
    model: str = "gpt-4o-mini",
    base_url: str | None = None,
) -> LLMClient:
    """Return an LLMClient that calls the OpenAI chat completions endpoint.

    Uses httpx (already a pytest-agent-observability dependency).
    Sets temperature=0 and response_format=json_object for deterministic JSON output.
    """
    url = (base_url or "https://api.openai.com").rstrip("/") + "/v1/chat/completions"

    class _OpenAIClient:
        def evaluate(self, prompt: str) -> str:
            payload: dict[str, Any] = {
                "model": model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "user", "content": prompt}],
            }
            resp = httpx.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                timeout=60.0,
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    return _OpenAIClient()
