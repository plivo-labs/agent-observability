"""LiveKit-judge: score a conversation against criteria using livekit.agents.evals.

One judge per criterion (`_LLMJudge` with the criterion's question as its
instructions), run over a `ChatContext` with an Azure LLM. Returns AO's
`{criteria, overall, notes}` shape so the `/v1/judge` contract + callers are
unchanged. Shared by the API judge endpoint and the caller's post-call eval.

LEVELED JUDGE (additive): when `scopes` requests more than the default
`("flow",)`, the same per-criterion judges are run over sub-slices of the
conversation — whole conversation (`flow`), per-agent partitions split at
`agent_handoff` items (`agent`), per-task segments split at
`agent_config_update`/`agent_handoff` (`task`), and per-assistant-turn windows
(`node`) — and the results are returned under an additive `scopes` block. The
default `scopes=("flow",)` is byte-identical to the pre-leveled behavior (same
cost, no extra LLM calls, no `scopes` key).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import ChatContext
from livekit.agents.llm.chat_context import ChatItem
from livekit.plugins import openai

from truman_calling.core.settings import settings

# Map transcript labels → ChatContext roles. The agent-under-test is "assistant"
# (matches criterion phrasing like "Did the agent…"); the caller/persona is "user".
_CALLER_LABELS = {"user", "caller", "persona", "customer", "director", "speaker_1"}

_VALID_SCOPES = ("flow", "agent", "task", "node")


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


# ---------------------------------------------------------------------------
# Per-criterion judges (built ONCE, reused across every scope x slice)
# ---------------------------------------------------------------------------


def _build_judges(criteria: list[dict[str, Any]], llm: openai.LLM) -> list[tuple[str, _LLMJudge]]:
    judges: list[tuple[str, _LLMJudge]] = []
    for i, c in enumerate(criteria):
        name = str(c.get("key") or c.get("name") or f"criterion_{i}")
        question = str(c.get("question") or name)
        judges.append((name, _LLMJudge(name=name, instructions=question, llm=llm)))
    return judges


def _verdict_to_dict(name: str, res: Any) -> dict[str, Any]:
    if hasattr(res, "verdict"):
        return {"name": name, "pass": res.verdict == "pass", "justification": getattr(res, "reasoning", "") or ""}
    if isinstance(res, dict):  # synthetic (empty-slice guard)
        return {"name": name, "pass": bool(res.get("pass")), "justification": str(res.get("justification") or "")}
    return {"name": name, "pass": False, "justification": f"judge error: {res}"}


def _overall_and_score(crit: list[dict[str, Any]]) -> tuple[str, int]:
    passed = sum(1 for x in crit if x["pass"])
    total = len(crit)
    overall = "pass" if total and passed == total else "fail"
    score = round(passed / total * 100) if total else 0
    return overall, score


# ---------------------------------------------------------------------------
# Slice helpers over chat_ctx.items
# ---------------------------------------------------------------------------


def _is_message(item: ChatItem) -> bool:
    return getattr(item, "type", None) == "message"


def _agent_slices(items: list[ChatItem]) -> list[dict[str, Any]]:
    """Split the conversation at `agent_handoff` items into per-agent partitions.

    Each slice carries a `turn_range` (inclusive indices into the message-only
    turn sequence) so consumers can attach the tasks that fall within each
    agent's window — NOT all tasks to the first agent. Zero handoffs → exactly
    ONE slice spanning the whole conversation, labelled "Agent under test"
    (never fabricate phantom agents)."""
    turn_index_of: dict[int, int] = {}
    turn_counter = 0
    for pos, item in enumerate(items):
        if _is_message(item):
            turn_index_of[pos] = turn_counter
            turn_counter += 1

    slices: list[dict[str, Any]] = []
    current: list[ChatItem] = []
    current_turns: list[int] = []
    current_agent_id: str | None = None
    handoff_seen = False

    def flush(agent_id: str | None) -> None:
        turn_range = [current_turns[0], current_turns[-1]] if current_turns else [0, 0]
        slices.append({"agent_id": agent_id, "items": current[:], "turn_range": turn_range})

    for pos, item in enumerate(items):
        if getattr(item, "type", None) == "agent_handoff":
            handoff_seen = True
            flush(current_agent_id)
            current = []
            current_turns = []
            current_agent_id = getattr(item, "new_agent_id", None)
            continue
        current.append(item)
        if pos in turn_index_of:
            current_turns.append(turn_index_of[pos])
    flush(current_agent_id)

    if not handoff_seen:
        # single agent → exactly one entry labelled "Agent under test"
        turn_range = slices[0]["turn_range"] if slices else [0, 0]
        return [{"agent_id": "agent_under_test", "label": "Agent under test", "items": items[:], "turn_range": turn_range}]

    out: list[dict[str, Any]] = []
    for idx, sl in enumerate(slices):
        aid = sl["agent_id"] or f"agent_{idx}"
        out.append({"agent_id": aid, "label": aid, "items": sl["items"], "turn_range": sl["turn_range"]})
    return out


def _task_slices(items: list[ChatItem]) -> list[dict[str, Any]]:
    """Segment at `agent_config_update`/`agent_handoff` boundaries within the conversation.

    Each segment tracks its turn_range (indices into the message-only turn sequence).
    Boundary markers themselves are not turns. If there is a single segment, the caller
    expands each *criterion* into a task-like objective (handled in assembly)."""
    turn_index_of: dict[int, int] = {}
    turn_counter = 0
    for pos, item in enumerate(items):
        if _is_message(item):
            turn_index_of[pos] = turn_counter
            turn_counter += 1

    segments: list[dict[str, Any]] = []
    current: list[ChatItem] = []
    current_turns: list[int] = []
    seg_index = 0

    def flush() -> None:
        nonlocal seg_index
        if not current:
            return
        turn_range = [current_turns[0], current_turns[-1]] if current_turns else [0, 0]
        segments.append(
            {
                "task_id": f"task_{seg_index}",
                "label": f"Segment {seg_index + 1}",
                "turn_range": turn_range,
                "items": current[:],
            }
        )
        seg_index += 1

    for pos, item in enumerate(items):
        itype = getattr(item, "type", None)
        if itype in ("agent_config_update", "agent_handoff"):
            flush()
            current = []
            current_turns = []
            continue
        current.append(item)
        if pos in turn_index_of:
            current_turns.append(turn_index_of[pos])
    flush()
    return segments


def _turn_slices(items: list[ChatItem], max_node_turns: int) -> list[dict[str, Any]]:
    """One slice per assistant ChatMessage, paired with its preceding user message for context.

    Each slice is a 1-2 item sub-context carrying turn_index/turn_id/role/text of the
    assistant turn. Capped at `max_node_turns` (earliest assistant turns kept)."""
    messages = [(pos, it) for pos, it in enumerate(items) if _is_message(it)]
    # turn_index is the index into the message-only sequence
    pos_to_turn = {pos: ti for ti, (pos, _it) in enumerate(messages)}

    slices: list[dict[str, Any]] = []
    for pos, item in messages:
        if getattr(item, "role", None) != "assistant":
            continue
        sub_items: list[ChatItem] = []
        # preceding user message (immediately prior message item, if it's a user turn)
        prior = None
        for ppos, pit in reversed([(p, i) for p, i in messages if p < pos]):
            prior = (ppos, pit)
            break
        if prior is not None and getattr(prior[1], "role", None) == "user":
            sub_items.append(prior[1])
        sub_items.append(item)
        slices.append(
            {
                "turn_index": pos_to_turn[pos],
                "turn_id": getattr(item, "id", None),
                "role": "assistant",
                "text": getattr(item, "text_content", None) or "",
                "items": sub_items,
            }
        )
        if len(slices) >= max_node_turns:
            break
    return slices


_SYNTHETIC_EMPTY = {"pass": False, "justification": "no content"}


# ---------------------------------------------------------------------------
# Judge core
# ---------------------------------------------------------------------------


async def judge_chat_ctx(
    chat_ctx: ChatContext,
    criteria: list[dict[str, Any]],
    *,
    scopes: tuple[str, ...] = ("flow",),
    max_node_turns: int = 12,
) -> dict[str, Any]:
    """Run one LiveKit `_LLMJudge` per criterion over the conversation.

    Always returns today's `{criteria, overall, notes}` (the `flow` result). When
    `scopes` requests scopes beyond `("flow",)`, an additive `scopes` block is
    appended carrying the requested per-scope results (flow/agent/task/node).
    With the default `scopes=("flow",)` the output is byte-identical to before
    (no `scopes` key, no extra LLM calls)."""
    if not criteria:
        return {"criteria": [], "overall": "fail", "notes": "no criteria provided"}

    llm = _judge_llm()
    judges = _build_judges(criteria, llm)
    leveled = tuple(s for s in scopes if s in _VALID_SCOPES and s != "flow")

    # ---- Build the slice plan. flow is always evaluated (it IS today's result). ----
    items = list(chat_ctx.items)

    # Each "unit" is a slice that gets the full criterion battery. We build one
    # ChatContext per unit and run (unit x criterion) judges in ONE gather.
    flow_unit = {"scope": "flow", "ctx": chat_ctx, "meta": {}, "uidx": 0}
    units: list[dict[str, Any]] = [flow_unit]

    # Stable position of each unit. Do NOT use units.index(u) later: list.index
    # compares dicts by VALUE, so two value-equal units would resolve to the
    # wrong (first) index. Tag each unit with its real position on append.
    def register(u: dict[str, Any]) -> dict[str, Any]:
        u["uidx"] = len(units)
        units.append(u)
        return u

    agent_units: list[dict[str, Any]] = []
    if "agent" in leveled:
        for sl in _agent_slices(items):
            ctx = ChatContext(items=sl["items"]) if sl["items"] else None
            u = {"scope": "agent", "ctx": ctx, "meta": {"agent_id": sl["agent_id"], "label": sl["label"], "turn_range": sl["turn_range"]}}
            agent_units.append(register(u))

    task_units: list[dict[str, Any]] = []
    if "task" in leveled:
        segs = _task_slices(items)
        if len(segs) <= 1:
            # single segment → expose each CRITERION as a task objective. NOTE:
            # each such task unit is pinned to ONE criterion, so its overall/score
            # is binary — _overall_and_score returns 0 or 100, never a graded
            # percentage. The UI shows it alongside graded flow/agent scores; treat
            # a single-segment task "score" as pass(100)/fail(0), not a gradient.
            seg = segs[0] if segs else {"turn_range": [0, 0], "items": items}
            seg_ctx = ChatContext(items=seg["items"]) if seg.get("items") else None
            for ci, (cname, cj) in enumerate(judges):
                u = {
                    "scope": "task",
                    "ctx": seg_ctx,
                    "meta": {
                        "task_id": f"task_{ci}",
                        "label": cname,
                        "turn_range": seg.get("turn_range", [0, 0]),
                        "single_criterion": cname,
                    },
                }
                task_units.append(register(u))
        else:
            for seg in segs:
                ctx = ChatContext(items=seg["items"]) if seg["items"] else None
                u = {
                    "scope": "task",
                    "ctx": ctx,
                    "meta": {"task_id": seg["task_id"], "label": seg["label"], "turn_range": seg["turn_range"]},
                }
                task_units.append(register(u))

    node_units: list[dict[str, Any]] = []
    if "node" in leveled:
        for sl in _turn_slices(items, max_node_turns):
            ctx = ChatContext(items=sl["items"]) if sl["items"] else None
            u = {
                "scope": "node",
                "ctx": ctx,
                "meta": {
                    "turn_index": sl["turn_index"],
                    "turn_id": sl["turn_id"],
                    "role": sl["role"],
                    "text": sl["text"],
                },
            }
            node_units.append(register(u))

    # ---- One asyncio.gather over the (unit x criterion) product. ----
    # task single-segment units pin to a single criterion; everything else runs
    # the full criterion battery. Empty slices are guarded with a synthetic fail
    # (no LLM call).
    calls: list[Any] = []
    call_index: dict[tuple[int, int], int] = {}  # (unit_idx, crit_idx) -> position in `calls`

    async def run(judge: _LLMJudge, ctx: ChatContext):
        try:
            return await judge.evaluate(chat_ctx=ctx, llm=llm)
        except Exception as e:  # noqa: BLE001 — one bad judge shouldn't sink the batch
            return e

    async def synthetic():
        return dict(_SYNTHETIC_EMPTY)

    for ui, unit in enumerate(units):
        single = unit["meta"].get("single_criterion")
        for ci, (cname, cj) in enumerate(judges):
            if single is not None and cname != single:
                continue
            ctx = unit["ctx"]
            empty = ctx is None or not any(_is_message(it) for it in ctx.items)
            call_index[(ui, ci)] = len(calls)
            calls.append(synthetic() if empty else run(cj, ctx))

    results = await asyncio.gather(*calls)

    def crit_for(ui: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        single = units[ui]["meta"].get("single_criterion")
        for ci, (cname, _cj) in enumerate(judges):
            if single is not None and cname != single:
                continue
            out.append(_verdict_to_dict(cname, results[call_index[(ui, ci)]]))
        return out

    # ---- Assemble today's flow result (byte-identical to before). ----
    flow_crit = crit_for(flow_unit["uidx"])
    passed = sum(1 for x in flow_crit if x["pass"])
    overall = "pass" if flow_crit and passed == len(flow_crit) else "fail"
    result: dict[str, Any] = {
        "criteria": flow_crit,
        "overall": overall,
        "notes": f"{passed}/{len(flow_crit)} criteria passed (LiveKit judges).",
    }

    if not leveled:
        return result  # byte-identical to pre-leveled output (no `scopes` key)

    # ---- Assemble the additive `scopes` block (only requested scopes). ----
    scopes_block: dict[str, Any] = {}

    # `flow` is ALWAYS present in the block (the back-compat anchor) so consumers
    # can rely on scopes.flow even when only node/task/agent were requested.
    f_overall, f_score = _overall_and_score(flow_crit)
    scopes_block["flow"] = {"criteria": flow_crit, "overall": f_overall, "score": f_score}

    if "agent" in scopes:
        agent_out: list[dict[str, Any]] = []
        for u in agent_units:
            crit = crit_for(u["uidx"])
            ov, sc = _overall_and_score(crit)
            agent_out.append(
                {
                    "agent_id": u["meta"]["agent_id"],
                    "label": u["meta"]["label"],
                    "turn_range": u["meta"]["turn_range"],
                    "criteria": crit,
                    "overall": ov,
                    "score": sc,
                }
            )
        scopes_block["agent"] = agent_out

    if "task" in scopes:
        # When there is a single segment, each criterion is its own task-like
        # objective (label = criterion name); otherwise one entry per segment.
        # Both shapes assemble identically from `task_units`.
        task_out: list[dict[str, Any]] = []
        for u in task_units:
            crit = crit_for(u["uidx"])
            ov, sc = _overall_and_score(crit)
            task_out.append(
                {
                    "task_id": u["meta"]["task_id"],
                    "label": u["meta"]["label"],
                    "turn_range": u["meta"]["turn_range"],
                    "criteria": crit,
                    "overall": ov,
                    "score": sc,
                }
            )
        scopes_block["task"] = task_out

    if "node" in scopes:
        node_out: list[dict[str, Any]] = []
        for u in node_units:
            crit = crit_for(u["uidx"])
            ov, _sc = _overall_and_score(crit)
            node_out.append(
                {
                    "turn_index": u["meta"]["turn_index"],
                    "turn_id": u["meta"]["turn_id"],
                    "role": u["meta"]["role"],
                    "text": u["meta"]["text"],
                    "criteria": crit,
                    "overall": ov,
                }
            )
        scopes_block["node"] = node_out

    result["scopes"] = scopes_block
    return result


async def judge_transcript_text(
    transcript: str,
    criteria: list[dict[str, Any]],
    *,
    caller_labels: set[str] | None = None,
    scopes: tuple[str, ...] = ("flow",),
    max_node_turns: int = 12,
) -> dict[str, Any]:
    # Slice AFTER chat_ctx_from_transcript_text so caller_labels/role-inversion is already applied.
    return await judge_chat_ctx(
        chat_ctx_from_transcript_text(transcript, caller_labels=caller_labels),
        criteria,
        scopes=scopes,
        max_node_turns=max_node_turns,
    )
