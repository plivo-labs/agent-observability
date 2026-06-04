"""Post-session judge evaluation against a LiveKit session report.

The pattern the text-only worker hand-rolled was 30 lines of
``JudgeGroup`` construction, ``try`` / ``except Exception`` /
``finally`` cleanup, and ``llm.aclose()`` plumbing — for what should be
``await run_judges_on_report(report, judges=[…])``.

The helper owns the LLM lifecycle only when the caller passes ``llm=None``
— pass an LLM you constructed and it stays yours to close.
"""

from __future__ import annotations

import logging
import os
from contextlib import suppress
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from livekit.agents.evals import JudgeGroup

if TYPE_CHECKING:  # pragma: no cover - import only for type hints
    from livekit.agents.evals import EvaluationResult, Judge
    from livekit.agents.llm import LLM


_LOGGER = logging.getLogger("agent_observability.livekit")


def _default_judge_llm() -> "LLM":
    """Build the default OpenAI judge LLM.

    Extracted as a module-level helper so tests can ``monkeypatch.setattr``
    it without having to fake out the entire ``livekit.plugins`` namespace.
    The env precedence here is the documented contract for callers who
    don't pass an explicit ``llm`` to :func:`run_judges_on_report`.
    """
    model_name = os.environ.get(
        "JUDGE_LLM_MODEL", os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
    )
    # Imported lazily so importing this module on a host without
    # livekit-plugins-openai installed doesn't blow up. Callers who pass
    # their own ``llm`` don't trigger this import path at all.
    from livekit.plugins import openai as _openai

    return _openai.LLM(model=model_name)


async def run_judges_on_report(
    report: Any,
    *,
    judges: list["Judge"],
    llm: "LLM | None" = None,
    on_result: Callable[["EvaluationResult"], Awaitable[None]] | None = None,
    logger: logging.Logger | None = None,
) -> "EvaluationResult | None":
    """Run a list of LiveKit judges against a session report.

    Wraps ``JudgeGroup`` setup, exception capture, structured logging, and
    LLM cleanup. Intended to be called from inside ``on_session_end``::

        async def on_session_end(ctx: JobContext) -> None:
            apply_observability_tags(ctx.tagger, agent_id=AGENT_ID, ...)
            report = ctx.make_session_report()
            await run_judges_on_report(
                report,
                judges=[accuracy_judge(), safety_judge()],
            )

    :param report: Whatever ``ctx.make_session_report()`` returned. Only
        the ``.chat_history`` attribute is read.
    :param judges: List of LiveKit ``Judge`` instances. Empty list → no-op,
        returns ``None``.
    :param llm: LLM the judges call. When ``None``, an
        ``openai.LLM(model=<env>)`` is constructed and closed by this
        helper. The env precedence is ``JUDGE_LLM_MODEL`` → ``OPENAI_MODEL``
        → ``"gpt-4.1-mini"``. Pass your own ``llm`` to keep ownership and
        use a non-OpenAI provider.
    :param on_result: Optional async callback invoked with the evaluation
        result on success. Useful for pushing into Slack / Linear / your
        own audit trail.
    :param logger: Where to send the result + error logs. Defaults to
        ``logging.getLogger("agent_observability.livekit")``.
    :return: The ``EvaluationResult`` from ``JudgeGroup.evaluate(...)``, or
        ``None`` when ``judges`` is empty or evaluation raised.
    """
    if not judges:
        return None

    log = logger or _LOGGER
    owned_llm = llm is None
    if owned_llm:
        llm = _default_judge_llm()

    try:
        group = JudgeGroup(llm=llm, judges=list(judges))
        result = await group.evaluate(report.chat_history)
        verdicts = ", ".join(
            f"{name}={judgment.verdict}"
            for name, judgment in result.judgments.items()
        )
        log.info(
            "Judges evaluated: %d, score=%.2f (%s)",
            len(judges),
            result.score,
            verdicts,
        )
        if on_result is not None:
            await on_result(result)
        return result
    except Exception:
        log.exception("Judge evaluation failed")
        return None
    finally:
        if owned_llm and llm is not None:
            with suppress(Exception):
                await llm.aclose()
