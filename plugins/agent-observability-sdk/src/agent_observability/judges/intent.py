"""Intent-related judges.

- `hold_requested_intent_accuracy_judge` (LLM) — was a hold/wait response
  appropriate? No ground truth required; the judge looks at the agent's last
  message and the user's preceding turn.
  Ported from cx-sqs-worker `metrics/llm_metrics.go::NewHoldRequestedIntentAccuracyMetric`.
- `IntentAccuracyJudge` (programmatic) — case-insensitive string match of
  expected vs. actual intent. Ported line-for-line from
  `metrics/programmatic.go::intentAccuracyMetric` (lines 11–54).

cx-sqs-worker's `intent_detection` judge is intentionally NOT ported —
its prompt is tightly coupled to cx-sqs-worker's flow-graph "available
intents" model, which doesn't generalize beyond that runtime.
"""

from __future__ import annotations

from livekit.agents.evals import JudgmentResult
from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.judges._instructions import HOLD_REQUESTED_INTENT_ACCURACY


def hold_requested_intent_accuracy_judge(llm: LLM | None = None) -> _LLMJudge:
    """LLM judge: when the agent told the user to hold/wait, did the user
    actually request that?

    No ground truth needed — the judge reads the latest agent message and
    the user's preceding turn from the conversation.
    """
    return _LLMJudge(
        llm=llm,
        name="hold_requested_intent_accuracy",
        instructions=HOLD_REQUESTED_INTENT_ACCURACY,
    )


class IntentAccuracyJudge:
    """Programmatic judge — case-insensitive string match of expected vs.
    actual intent.

    Both values are passed at construction time; `chat_ctx` is ignored
    during `evaluate()`. The judge still satisfies LiveKit's `Judge`
    protocol (name property + async evaluate returning JudgmentResult), so
    it slots into `JudgeGroup` next to LLM judges.

    Ports `cx-sqs-worker/.../metrics/programmatic.go:11-54` verbatim
    including the score-then-verdict mapping (1.0 → pass, 0.0 → fail).
    """

    def __init__(
        self,
        *,
        expected_intent: str,
        actual_intent: str,
        name: str = "intent_accuracy",
    ) -> None:
        self._expected = expected_intent
        self._actual = actual_intent
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    async def evaluate(
        self,
        *,
        chat_ctx=None,  # noqa: ARG002 — accepted for protocol compatibility
        reference=None,  # noqa: ARG002
        llm: LLM | None = None,  # noqa: ARG002
    ) -> JudgmentResult:
        expected_norm = self._expected.strip().lower()
        actual_norm = self._actual.strip().lower()
        if expected_norm == actual_norm:
            return JudgmentResult(
                verdict="pass",
                reasoning=(
                    f"Intent matches. Expected '{self._expected}', got "
                    f"'{self._actual}'."
                ),
            )
        return JudgmentResult(
            verdict="fail",
            reasoning=(
                f"Intent mismatch. Expected '{self._expected}', got "
                f"'{self._actual}'."
            ),
        )
