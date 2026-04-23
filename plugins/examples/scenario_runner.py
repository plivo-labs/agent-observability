# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "livekit-agents>=1.5",
#     "livekit-plugins-openai>=1.5",
#     "openai>=1.40",
# ]
# ///
"""Reusable scenario-runner: describe an agent, let an LLM generate the evals.

The idea: pytest-style evals require a human to write every scenario. For
rapid iteration, we'd rather describe the agent (role, tools, constraints) and
have an LLM propose N diverse test cases, then run and judge them in one pass.

This module exposes a small, framework-agnostic API:

    scenarios = generate_scenarios(spec, n=10)
    results   = await run_scenarios(agent_factory, scenarios, judge_model)

Both `pytest_generated_agent.py` (pytest wrapper) and `fastapi_runner.py`
(HTTP endpoint) import and reuse these two functions — same agent, same
evaluation, different transport.

Requires: `openai` (>= 1.40 for the Responses API JSON-schema path) and
`livekit-agents` with any text-mode-capable LLM plugin.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Awaitable, Callable, Optional

from livekit.agents import Agent, AgentSession, llm
from livekit.plugins import openai as lk_openai
from openai import AsyncOpenAI


# ── Data model ───────────────────────────────────────────────────────────────

@dataclass
class AgentSpec:
    """Everything the scenario generator needs to know about the agent."""

    name: str
    role: str  # One-sentence summary shown to the generator.
    instructions: str  # Full system prompt used at runtime.
    tools: list[dict] = field(default_factory=list)  # [{"name", "description", "params"}]


@dataclass
class Scenario:
    name: str  # Short kebab-case id.
    user_input: str
    judge_intent: str  # What an ideal response would achieve.
    expected_tool: Optional[str] = None  # Name of a tool we expect called, if any.


@dataclass
class ScenarioResult:
    scenario: Scenario
    passed: bool
    verdict: str  # "pass" | "fail" | "maybe"
    judge_reason: str
    assistant_reply: str
    tools_called: list[str]
    duration_ms: int
    error: Optional[str] = None


# ── Scenario generation ─────────────────────────────────────────────────────

_GENERATION_SYSTEM = (
    "You are a QA engineer designing behavioral tests for a voice AI agent. "
    "Given the agent's role, instructions, and tool signatures, produce a "
    "diverse set of test scenarios that together exercise: typical happy "
    "paths, edge cases, clarification needs, refusals of off-task or unsafe "
    "requests, and any privacy/authentication constraints implied by the "
    "instructions. Each scenario must include a single judge_intent "
    "describing — in one sentence — what an ideal response would do or "
    "avoid. Prefer intents phrased as observable behaviors."
)


_SCENARIOS_JSON_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["scenarios"],
    "properties": {
        "scenarios": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                # Strict schemas require `required` to list every property
                # in `properties`. Optional fields are expressed as nullable.
                "required": [
                    "name",
                    "user_input",
                    "judge_intent",
                    "expected_tool",
                ],
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "kebab-case id, <= 40 chars",
                    },
                    "user_input": {
                        "type": "string",
                        "description": "What the user says to the agent",
                    },
                    "judge_intent": {
                        "type": "string",
                        "description": (
                            "One sentence describing what the ideal assistant "
                            "response would accomplish or explicitly avoid."
                        ),
                    },
                    "expected_tool": {
                        "type": ["string", "null"],
                        "description": (
                            "Name of a tool that should fire for this input, "
                            "or null if no specific tool is expected."
                        ),
                    },
                },
            },
        }
    },
}


def _format_spec_for_prompt(spec: AgentSpec) -> str:
    tool_block = "(no tools)"
    if spec.tools:
        tool_block = "\n".join(
            f"- {t['name']}({t.get('params', '')}): {t.get('description', '')}"
            for t in spec.tools
        )
    return (
        f"Agent name: {spec.name}\n"
        f"Role: {spec.role}\n"
        f"Instructions:\n{spec.instructions}\n\n"
        f"Tools:\n{tool_block}"
    )


async def generate_scenarios(
    spec: AgentSpec,
    n: int = 10,
    *,
    model: str = "gpt-4.1-mini",
    client: Optional[AsyncOpenAI] = None,
) -> list[Scenario]:
    """Ask an LLM for `n` scenarios tailored to the agent spec.

    Uses JSON-schema response format so the output shape is guaranteed.
    """
    client = client or AsyncOpenAI()

    user_msg = (
        f"{_format_spec_for_prompt(spec)}\n\n"
        f"Generate exactly {n} scenarios. Cover at least: 2 happy paths, "
        f"2 edge cases (missing info, ambiguous wording), 2 refusals "
        f"(off-task or unsafe), and any authentication boundary implied by "
        f"the instructions. Use diverse user phrasing."
    )

    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _GENERATION_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "scenarios",
                "schema": _SCENARIOS_JSON_SCHEMA,
                "strict": True,
            },
        },
        temperature=0.7,
    )

    payload = json.loads(resp.choices[0].message.content or "{}")
    out: list[Scenario] = []
    for item in payload.get("scenarios", [])[:n]:
        out.append(
            Scenario(
                name=item["name"],
                user_input=item["user_input"],
                judge_intent=item["judge_intent"],
                expected_tool=item.get("expected_tool"),
            )
        )
    return out


# ── Scenario execution ──────────────────────────────────────────────────────

def _session_llm() -> llm.LLM:
    """Default LLM for running the agent under test."""
    return lk_openai.LLM(model="gpt-4.1-mini")


async def _judge_reply(
    client: AsyncOpenAI,
    assistant_reply: str,
    intent: str,
    *,
    model: str = "gpt-4.1-mini",
) -> tuple[str, str]:
    """Return (verdict, reason) via an LLM grader call.

    We talk to OpenAI directly rather than routing through the LiveKit LLM
    wrapper — the wrapper expects the agent framework's `ChatContext` shape
    (`content` is a list of parts, etc.) which keeps shifting across versions.
    A plain `chat.completions.create` call is stable and returns JSON via
    `response_format`.
    """
    prompt = (
        "You are grading a voice agent's reply against an intent.\n"
        f"INTENT: {intent}\n"
        f"ASSISTANT_REPLY: {assistant_reply}\n\n"
        "Respond with JSON: {\"verdict\": \"pass\"|\"maybe\"|\"fail\", "
        "\"reason\": <short explanation>}"
    )
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    text = (resp.choices[0].message.content or "").strip()
    try:
        data = json.loads(text)
        return data.get("verdict", "maybe"), data.get("reason", "")
    except json.JSONDecodeError:
        return "maybe", f"(unparseable judge output) {text[:200]}"


AgentFactory = Callable[[], Agent]


async def run_scenario(
    agent_factory: AgentFactory,
    scenario: Scenario,
    *,
    judge_client: Optional[AsyncOpenAI] = None,
    session_llm: Optional[llm.LLM] = None,
) -> ScenarioResult:
    """Run one scenario end-to-end. Returns a verdict, never raises on a
    failed judgment — only on transport/infrastructure errors."""
    start = time.monotonic()
    tools_called: list[str] = []
    assistant_reply = ""
    error: Optional[str] = None

    owns_session_model = session_llm is None
    session_model = session_llm or _session_llm()
    judge_client = judge_client or AsyncOpenAI()
    try:
        async with AgentSession(llm=session_model) as sess:
            await sess.start(agent_factory())
            result = await sess.run(user_input=scenario.user_input)

            for event in result.events:
                event_type = getattr(event, "type", None)
                if event_type == "function_call":
                    name = getattr(event.item, "name", "") if hasattr(event, "item") else ""
                    if name:
                        tools_called.append(name)
                elif event_type == "message":
                    item = getattr(event, "item", None)
                    role = getattr(item, "role", None) if item else None
                    if role == "assistant":
                        content = getattr(item, "content", None) or getattr(
                            item, "text_content", ""
                        )
                        if isinstance(content, list):
                            content = " ".join(str(c) for c in content if c)
                        assistant_reply = str(content or "")
    except Exception as exc:  # noqa: BLE001 — transport failures are reported, not raised
        error = f"{type(exc).__name__}: {exc}"
    finally:
        if owns_session_model:
            try:
                await session_model.aclose()
            except Exception:  # noqa: BLE001
                pass

    duration_ms = int((time.monotonic() - start) * 1000)

    if error:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            verdict="fail",
            judge_reason=error,
            assistant_reply=assistant_reply,
            tools_called=tools_called,
            duration_ms=duration_ms,
            error=error,
        )

    verdict, reason = await _judge_reply(
        judge_client, assistant_reply, scenario.judge_intent
    )
    # Enforce expected_tool if set — missing the tool is a fail regardless of
    # the judge's verdict on the text.
    if scenario.expected_tool and scenario.expected_tool not in tools_called:
        verdict = "fail"
        reason = (
            f"Expected tool '{scenario.expected_tool}' was not called "
            f"(called: {tools_called or 'none'}). Judge said: {reason}"
        )

    return ScenarioResult(
        scenario=scenario,
        passed=(verdict != "fail"),
        verdict=verdict,
        judge_reason=reason,
        assistant_reply=assistant_reply,
        tools_called=tools_called,
        duration_ms=duration_ms,
    )


async def run_scenarios(
    agent_factory: AgentFactory,
    scenarios: list[Scenario],
    *,
    judge_client: Optional[AsyncOpenAI] = None,
    max_concurrency: int = 4,
) -> list[ScenarioResult]:
    """Run all scenarios, bounded by `max_concurrency`. Returns results in
    the same order as `scenarios`."""
    client = judge_client or AsyncOpenAI()
    sem = asyncio.Semaphore(max_concurrency)

    async def _one(sc: Scenario) -> ScenarioResult:
        async with sem:
            return await run_scenario(agent_factory, sc, judge_client=client)

    return await asyncio.gather(*(_one(s) for s in scenarios))


# ── Summary helpers ─────────────────────────────────────────────────────────

def summarize(results: list[ScenarioResult]) -> dict[str, Any]:
    passed = sum(1 for r in results if r.verdict == "pass")
    maybe = sum(1 for r in results if r.verdict == "maybe")
    failed = sum(1 for r in results if r.verdict == "fail")
    return {
        "total": len(results),
        "passed": passed,
        "maybe": maybe,
        "failed": failed,
        "pass_rate": (passed + maybe) / len(results) if results else 0.0,
        "results": [
            {
                **asdict(r),
                "scenario": asdict(r.scenario),
            }
            for r in results
        ],
    }


def require_openai_key() -> None:
    """Raise with a helpful message if OPENAI_API_KEY is missing."""
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Scenario generation and judging "
            "require an OpenAI key. Export it and retry."
        )
