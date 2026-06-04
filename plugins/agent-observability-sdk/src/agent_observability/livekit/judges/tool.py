"""Tool-correctness judge (programmatic).

Ported line-for-line from cx-sqs-worker
`usecases/vibe_eval/evaluator/metrics/programmatic.go:65-163` — set-membership
scoring of expected vs. actual tool calls with a configurable pass threshold.

Unlike its Go cousin, this one auto-extracts the actual tools called from
`chat_ctx.items` (LiveKit's `function_call` events). Users only need to
supply the expected set.
"""

from __future__ import annotations

from typing import Iterable

from livekit.agents.evals import JudgmentResult
from livekit.agents.llm import LLM, ChatContext


class ToolCorrectnessJudge:
    """Compare the set of tools the agent actually called against the
    expected set.

    Scoring (from programmatic.go:144-152):
      - both sets empty                            → 1.0 (pass)
      - expected_count > 0                         → matched / expected_count
      - expected_count == 0 and unexpected_count>0 → 0.0
      - else                                       → 1.0

    `verdict = "pass"` when `score >= threshold` (default 1.0 — strict
    parity with cx-sqs-worker's typical config).
    """

    def __init__(
        self,
        *,
        expected_tools: Iterable[str],
        threshold: float = 1.0,
        name: str = "tool_correctness",
    ) -> None:
        self._expected = {t.strip().lower() for t in expected_tools if t}
        self._threshold = threshold
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    async def evaluate(
        self,
        *,
        chat_ctx: ChatContext,
        reference: ChatContext | None = None,  # noqa: ARG002
        llm: LLM | None = None,  # noqa: ARG002
    ) -> JudgmentResult:
        actual = {
            item.name.strip().lower()
            for item in chat_ctx.items
            if item.type == "function_call" and getattr(item, "name", None)
        }

        if not self._expected and not actual:
            return JudgmentResult(
                verdict="pass",
                reasoning="No tools expected and none called.",
            )

        matched = self._expected & actual
        missing = self._expected - actual
        unexpected = actual - self._expected

        if self._expected:
            score = len(matched) / len(self._expected)
        elif unexpected:
            score = 0.0
        else:
            score = 1.0

        if score >= self._threshold:
            return JudgmentResult(
                verdict="pass",
                reasoning=(
                    f"Tool calls correct. Expected {len(self._expected)} tool(s), "
                    f"{len(matched)} matched."
                ),
            )

        parts: list[str] = []
        if missing:
            parts.append(f"Missing tools: {sorted(missing)}")
        if unexpected:
            parts.append(f"Unexpected tools: {sorted(unexpected)}")
        reasoning = ". ".join(parts) if parts else "Tool call mismatch."
        return JudgmentResult(verdict="fail", reasoning=reasoning)
