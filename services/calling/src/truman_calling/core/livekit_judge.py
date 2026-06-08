"""LiveKit-judge: score a conversation against criteria using livekit.agents.evals.

One judge per criterion (`_LLMJudge` with the criterion's question as its
instructions), run over a `ChatContext` with an Azure LLM. Returns AO's
`{criteria, overall, notes}` shape so the `/v1/judge` contract + callers are
unchanged. Shared by the API judge endpoint and the caller's post-call eval.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import ChatContext
from livekit.plugins import openai

from truman_calling.core.settings import settings

# Map transcript labels → ChatContext roles. The agent-under-test is "assistant"
# (matches criterion phrasing like "Did the agent…"); the caller/persona is "user".
_CALLER_LABELS = {"user", "caller", "persona", "customer", "director", "speaker_1"}


def _judge_llm() -> openai.LLM:
    return openai.LLM.with_azure(
        model=settings.azure_openai_judge_deployment,
        azure_endpoint=settings.azure_openai_endpoint,
        azure_deployment=settings.azure_openai_judge_deployment,
        api_version=settings.azure_openai_api_version,
        api_key=settings.azure_openai_api_key,
    )


def _role_for(label: str, caller_labels: set[str]) -> str:
    return "user" if label.lower().strip() in caller_labels else "assistant"


def chat_ctx_from_transcript_text(transcript: str, *, caller_labels: set[str] | None = None) -> ChatContext:
    """Parse a transcript (JSONL `{role,text}` lines, or `Label: text` lines) into a ChatContext.

    `caller_labels` are the transcript labels that denote the *caller/persona* (→ role "user");
    every other label is treated as the agent-under-test (→ role "assistant", matching criterion
    phrasing). Truman's transcript inverts the defaults (its caller is "assistant"), so the caller
    passes its own label set."""
    labels = caller_labels if caller_labels is not None else _CALLER_LABELS
    ctx = ChatContext.empty()
    for raw in (transcript or "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        role, text = "assistant", line
        if line.startswith("{"):
            try:
                o = json.loads(line)
                text = str(o.get("text") or o.get("transcript") or "").strip()
                role = _role_for(str(o.get("role") or o.get("speaker") or "assistant"), labels)
            except Exception:
                pass
        else:
            parts = line.split(":", 1)
            if len(parts) == 2 and len(parts[0]) <= 24:
                role, text = _role_for(parts[0], labels), parts[1].strip()
        if text:
            ctx.add_message(role=role, content=text)
    return ctx


async def judge_chat_ctx(chat_ctx: ChatContext, criteria: list[dict[str, Any]]) -> dict[str, Any]:
    """Run one LiveKit `_LLMJudge` per criterion over the conversation."""
    if not criteria:
        return {"criteria": [], "overall": "fail", "notes": "no criteria provided"}
    llm = _judge_llm()
    judges = []
    for i, c in enumerate(criteria):
        name = str(c.get("key") or c.get("name") or f"criterion_{i}")
        question = str(c.get("question") or name)
        judges.append((name, _LLMJudge(name=name, instructions=question, llm=llm)))

    async def run(judge: _LLMJudge):
        try:
            return await judge.evaluate(chat_ctx=chat_ctx, llm=llm)
        except Exception as e:  # noqa: BLE001 — one bad judge shouldn't sink the batch
            return e

    results = await asyncio.gather(*[run(j) for _, j in judges])
    out: list[dict[str, Any]] = []
    for (name, _), res in zip(judges, results):
        if hasattr(res, "verdict"):
            out.append({"name": name, "pass": res.verdict == "pass", "justification": getattr(res, "reasoning", "") or ""})
        else:
            out.append({"name": name, "pass": False, "justification": f"judge error: {res}"})
    passed = sum(1 for x in out if x["pass"])
    overall = "pass" if out and passed == len(out) else "fail"
    return {"criteria": out, "overall": overall, "notes": f"{passed}/{len(out)} criteria passed (LiveKit judges)."}


async def judge_transcript_text(
    transcript: str, criteria: list[dict[str, Any]], *, caller_labels: set[str] | None = None
) -> dict[str, Any]:
    return await judge_chat_ctx(chat_ctx_from_transcript_text(transcript, caller_labels=caller_labels), criteria)
