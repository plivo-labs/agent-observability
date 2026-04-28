"""LLM-backed judges for pipecat-evals."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional

from .run_result import ChatMessage, JudgeResult


_DEFAULT_SYSTEM_PROMPT = (
    "You are an impartial evaluator for text-mode agent tests. "
    "Decide whether the assistant response satisfies the provided intent. "
    "Return only JSON matching the requested schema."
)

_JUDGE_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["success", "reasoning", "score"],
    "properties": {
        "success": {"type": "boolean"},
        "reasoning": {"type": "string"},
        "score": {"type": ["number", "null"]},
    },
}


@dataclass
class OpenAIJudge:
    """OpenAI-backed judge for ``ChatMessageAssert.judge(...)``.

    The ``openai`` package is imported lazily so ``pipecat-evals`` remains
    lightweight unless an LLM judge is actually used.
    """

    model: str = "gpt-4.1-mini"
    client: Any = None
    temperature: float = 0.0
    system_prompt: str = _DEFAULT_SYSTEM_PROMPT

    async def evaluate(self, *, message: ChatMessage, intent: str) -> JudgeResult:
        client = self.client or self._new_client()
        response = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": self.system_prompt},
                {
                    "role": "user",
                    "content": (
                        "Intent:\n"
                        f"{intent}\n\n"
                        "Assistant response:\n"
                        f"{message.content}\n\n"
                        "Pass only if the response clearly satisfies the intent."
                    ),
                },
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "pipecat_eval_judgment",
                    "schema": _JUDGE_RESPONSE_SCHEMA,
                    "strict": True,
                },
            },
            temperature=self.temperature,
        )
        content = _response_content(response)
        try:
            payload = json.loads(content)
        except Exception:
            return JudgeResult(
                success=False,
                reasoning=f"Judge returned invalid JSON: {content[:200]}",
                raw=content,
            )
        return _payload_to_judge_result(payload, raw=content)

    def _new_client(self) -> Any:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover - depends on local env
            raise ImportError(
                "OpenAIJudge requires the openai package. Install "
                "`pipecat-evals[openai]` or add `openai>=1.40` to the test env."
            ) from exc
        return AsyncOpenAI()


LLMJudge = OpenAIJudge


def _response_content(response: Any) -> str:
    choice = response.choices[0]
    message = getattr(choice, "message", None)
    if isinstance(message, dict):
        return str(message.get("content") or "")
    return str(getattr(message, "content", "") or "")


def _payload_to_judge_result(payload: dict[str, Any], *, raw: Any) -> JudgeResult:
    success_value: Any = payload.get("success")
    if success_value is None and "verdict" in payload:
        success_value = str(payload["verdict"]).lower() in {
            "pass",
            "passed",
            "true",
            "yes",
        }

    reasoning = str(payload.get("reasoning") or payload.get("reason") or "")
    if success_value is None:
        return JudgeResult(
            success=False,
            reasoning=reasoning or "Judge response did not include success or verdict",
            score=_optional_float(payload.get("score")),
            raw=raw,
        )

    return JudgeResult(
        success=_as_bool(success_value),
        reasoning=reasoning,
        score=_optional_float(payload.get("score")),
        raw=raw,
    )


def _optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "pass", "passed", "success"}
    return bool(value)
