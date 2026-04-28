# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "openai>=1.40",
# ]
# ///
"""Dynamic scenario generation helpers for the Pipecat pytest example.

If `OPENAI_API_KEY` is set, `generate_scenarios(...)` asks OpenAI for scenarios
using a JSON schema. If the key is absent, it returns deterministic fallback
scenarios so `pipecat_generated_agent.py` stays ready to run in local smoke
checks.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class AgentSpec:
    name: str
    role: str
    instructions: str
    tools: list[dict] = field(default_factory=list)


@dataclass
class Scenario:
    name: str
    user_input: str
    judge_intent: str
    expected_tool: Optional[str] = None
    expected_reply_contains: str = ""


@dataclass
class ScenarioResult:
    scenario: Scenario
    passed: bool
    verdict: str
    judge_reason: str
    assistant_reply: str
    tools_called: list[str]


_EXPECTED_PHRASES = [
    "Menu",
    "placed",
    "not on the menu",
    "not found",
    "cancelled",
    "pizza orders",
]


_SCENARIOS_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["scenarios"],
    "properties": {
        "scenarios": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
                    "user_input",
                    "judge_intent",
                    "expected_tool",
                    "expected_reply_contains",
                ],
                "properties": {
                    "name": {"type": "string", "description": "kebab-case id"},
                    "user_input": {"type": "string"},
                    "judge_intent": {"type": "string"},
                    "expected_tool": {
                        "type": ["string", "null"],
                        "enum": [
                            "get_menu",
                            "place_order",
                            "get_order_status",
                            "cancel_order",
                            None,
                        ],
                    },
                    "expected_reply_contains": {
                        "type": "string",
                        "enum": _EXPECTED_PHRASES,
                    },
                },
            },
        },
    },
}


async def generate_scenarios(
    spec: AgentSpec,
    n: int = 8,
    *,
    model: str = "gpt-4.1-mini",
) -> list[Scenario]:
    if not os.environ.get("OPENAI_API_KEY"):
        return fallback_scenarios(n)

    from openai import AsyncOpenAI

    client = AsyncOpenAI()
    tools = "\n".join(
        f"- {tool['name']}({tool.get('params', '')}): {tool.get('description', '')}"
        for tool in spec.tools
    )
    prompt = (
        "Generate pytest eval scenarios for this deterministic Pipecat pizza "
        "agent. Keep user inputs compatible with the tool names and expected "
        "reply phrases listed in the schema. Use diverse happy paths, edge "
        "cases, off-menu requests, order status, cancellation, and off-topic "
        "requests.\n\n"
        f"Agent: {spec.name}\nRole: {spec.role}\nInstructions: {spec.instructions}\n"
        f"Tools:\n{tools}\n\nGenerate exactly {n} scenarios."
    )
    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a QA engineer creating concise behavioral evals. "
                    "Return only JSON that matches the schema."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "pipecat_scenarios",
                "schema": _SCENARIOS_JSON_SCHEMA,
                "strict": True,
            },
        },
        temperature=0.6,
    )
    payload = json.loads(resp.choices[0].message.content or "{}")
    scenarios = [
        Scenario(
            name=item["name"],
            user_input=item["user_input"],
            judge_intent=item["judge_intent"],
            expected_tool=item.get("expected_tool"),
            expected_reply_contains=item["expected_reply_contains"],
        )
        for item in payload.get("scenarios", [])
    ]
    return scenarios[:n] or fallback_scenarios(n)


def fallback_scenarios(n: int = 8) -> list[Scenario]:
    base = [
        Scenario(
            name="show-menu",
            user_input="What pizzas are on the menu?",
            judge_intent="Shows the menu with available pizzas.",
            expected_tool="get_menu",
            expected_reply_contains="Menu",
        ),
        Scenario(
            name="place-margherita",
            user_input="Place one margherita pizza for 10 Market St.",
            judge_intent="Places an order for an on-menu pizza.",
            expected_tool="place_order",
            expected_reply_contains="placed",
        ),
        Scenario(
            name="reject-sushi",
            user_input="Can I order sushi?",
            judge_intent="Rejects an item that is not on the pizza menu.",
            expected_tool="get_menu",
            expected_reply_contains="not on the menu",
        ),
        Scenario(
            name="unknown-status",
            user_input="What is the status of order o-9999?",
            judge_intent="Communicates that the requested order was not found.",
            expected_tool="get_order_status",
            expected_reply_contains="not found",
        ),
        Scenario(
            name="unknown-cancel",
            user_input="Cancel order o-9999",
            judge_intent="Communicates that the cancellation target was not found.",
            expected_tool="cancel_order",
            expected_reply_contains="not found",
        ),
        Scenario(
            name="off-topic",
            user_input="Tell me a joke",
            judge_intent="Stays on task and redirects to pizza ordering.",
            expected_tool=None,
            expected_reply_contains="pizza orders",
        ),
    ]
    out: list[Scenario] = []
    while len(out) < n:
        item = base[len(out) % len(base)]
        suffix = "" if len(out) < len(base) else f"-{len(out) // len(base) + 1}"
        out.append(Scenario(
            name=f"{item.name}{suffix}",
            user_input=item.user_input,
            judge_intent=item.judge_intent,
            expected_tool=item.expected_tool,
            expected_reply_contains=item.expected_reply_contains,
        ))
    return out


def summarize(results: list[ScenarioResult]) -> dict[str, Any]:
    return {
        "total": len(results),
        "passed": sum(1 for result in results if result.passed),
        "failed": sum(1 for result in results if not result.passed),
        "cases": [
            {
                "name": result.scenario.name,
                "passed": result.passed,
                "verdict": result.verdict,
                "reason": result.judge_reason,
                "assistant_reply": result.assistant_reply,
                "tools_called": result.tools_called,
            }
            for result in results
        ],
    }
