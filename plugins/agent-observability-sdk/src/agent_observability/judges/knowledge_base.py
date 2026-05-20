"""Knowledge-base correctness judge.

Ported from cx-sqs-worker
`usecases/vibe_eval/evaluator/metrics/llm_metrics.go`
(`NewKnowledgeBaseCorrectnessMetric`) + `GetKnowledgeBaseCorrectnessPromptConfig`.

Used when the agent invoked a KB tool. The judge decides whether the call
was necessary — i.e. whether the answer was already discoverable in the
conversation context without the tool.
"""

from __future__ import annotations

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.judges._instructions import KNOWLEDGE_BASE_CORRECTNESS


def knowledge_base_correctness_judge(
    *,
    kb_context: str,
    llm: LLM | None = None,
) -> _LLMJudge:
    """`kb_context` is the result the KB tool returned (the new evidence
    the agent gained). The judge compares it to what was already
    discoverable in the existing conversation history."""
    return _LLMJudge(
        llm=llm,
        name="knowledge_base_correctness",
        instructions=KNOWLEDGE_BASE_CORRECTNESS.format(kb_context=kb_context),
    )
