# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pytest>=7.0",
#     "pytest-asyncio>=0.21",
#     "pytest-agent-observability",
#     "pipecat-ai[openai]",
#     "websockets>=13",
#     "pipecat-evals[openai]",
#     "openai>=1.40",
# ]
#
# [tool.uv.sources]
# pytest-agent-observability = { path = "../../pytest-agent-observability", editable = true }
# pipecat-evals = { path = "../../pipecat-evals", editable = true }
# ///
"""Dynamic Pipecat pytest evals against a real LLM-driven pizza agent.

Set ``OPENAI_API_KEY`` so both scenario generation and the agent under test
can call OpenAI:

    export OPENAI_API_KEY=sk-...
    AGENT_OBSERVABILITY_GENERATED_N=8 uv run plugins/examples/pytest/pipecat_generated_agent.py
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest
from loguru import logger

os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
logger.remove()
logger.add(sys.stderr, level=os.environ.get("PIPECAT_LOG_LEVEL", "WARNING"))

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService

from pipecat_evals import AgentSession, OpenAIJudge
from pipecat_scenario_runner import (
    AgentSpec,
    Scenario,
    ScenarioResult,
    generate_scenarios,
    summarize,
)


AGENT_MODEL = os.environ.get("AGENT_OBSERVABILITY_AGENT_MODEL", "gpt-4.1-mini")
JUDGE_MODEL = os.environ.get("AGENT_OBSERVABILITY_JUDGE_MODEL", "gpt-4.1-mini")


_MENU = {
    "margherita": 1200,
    "pepperoni": 1400,
    "veggie": 1300,
}


SYSTEM_PROMPT = (
    "You are a pizza ordering assistant. Use tools for menu and order data. "
    "When the user asks about the menu, call get_menu. When they place an "
    "order, call place_order with the items they listed and a delivery "
    "address (ask for one if missing). When they ask about an order, call "
    "get_order_status. When they cancel, call cancel_order. Reject items "
    "that are not on the menu and stay strictly on pizza-ordering topics."
)


TOOLS = ToolsSchema(standard_tools=[
    FunctionSchema(
        name="get_menu",
        description="Return pizza menu items with prices.",
        properties={},
        required=[],
    ),
    FunctionSchema(
        name="place_order",
        description="Place a pizza order.",
        properties={
            "items": {"type": "array", "items": {"type": "string"}},
            "delivery_address": {"type": "string"},
        },
        required=["items", "delivery_address"],
    ),
    FunctionSchema(
        name="get_order_status",
        description="Look up a pizza order status.",
        properties={"order_id": {"type": "string"}},
        required=["order_id"],
    ),
    FunctionSchema(
        name="cancel_order",
        description="Cancel a pizza order.",
        properties={"order_id": {"type": "string"}},
        required=["order_id"],
    ),
])


async def get_menu(params: FunctionCallParams) -> None:
    await params.result_callback(
        "Menu: margherita $12, pepperoni $14, veggie $13."
    )


async def place_order(params: FunctionCallParams) -> None:
    items = params.arguments.get("items") or []
    if not items or items[0] not in _MENU:
        await params.result_callback(
            "ERROR: that item is not on the menu."
        )
        return
    item = items[0]
    total = _MENU[item]
    await params.result_callback(
        f"Order o-0001 placed: {item}. Total ${total / 100:.2f}."
    )


async def get_order_status(params: FunctionCallParams) -> None:
    order_id = params.arguments["order_id"]
    await params.result_callback(f"ERROR: order {order_id!r} not found")


async def cancel_order(params: FunctionCallParams) -> None:
    order_id = params.arguments["order_id"]
    await params.result_callback(f"ERROR: order {order_id!r} not found")


def build_pipeline() -> Pipeline:
    llm = OpenAILLMService(model=AGENT_MODEL)
    llm.register_function("get_menu", get_menu)
    llm.register_function("place_order", place_order)
    llm.register_function("get_order_status", get_order_status)
    llm.register_function("cancel_order", cancel_order)

    context = LLMContext(
        messages=[{"role": "system", "content": SYSTEM_PROMPT}],
        tools=TOOLS,
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)
    return Pipeline([user_aggregator, llm, assistant_aggregator])


SPEC = AgentSpec(
    name="PizzaPipeline",
    role="Real-LLM Pipecat pizza ordering pipeline.",
    instructions=(
        "Answer pizza menu, ordering, status, cancellation, and off-topic "
        "requests using the tools listed below."
    ),
    tools=[
        {"name": "get_menu", "params": "", "description": "Return menu with prices."},
        {
            "name": "place_order",
            "params": "items: list[str], delivery_address: str",
            "description": "Place an order for menu pizzas.",
        },
        {
            "name": "get_order_status",
            "params": "order_id: str",
            "description": "Return order status or not-found.",
        },
        {
            "name": "cancel_order",
            "params": "order_id: str",
            "description": "Cancel an order or return not-found.",
        },
    ],
)


def _load_scenarios() -> list[Scenario]:
    n = int(os.environ.get("AGENT_OBSERVABILITY_GENERATED_N", "8"))
    return asyncio.run(generate_scenarios(SPEC, n=n))


_SCENARIOS = _load_scenarios()


async def start_session(session: AgentSession) -> None:
    await session.start(
        build_pipeline,
        task_kwargs={"enable_rtvi": False, "check_dangling_tasks": False},
    )


def _judge() -> OpenAIJudge:
    return OpenAIJudge(model=JUDGE_MODEL)


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", _SCENARIOS, ids=[s.name for s in _SCENARIOS])
async def test_generated_scenario(scenario: Scenario) -> None:
    async with AgentSession() as session:
        await start_session(session)
        result = await session.run(user_input=scenario.user_input)

    if scenario.expected_tool:
        result.expect.contains_function_call(name=scenario.expected_tool)

    await result.expect.contains_message(role="assistant").judge(
        _judge(),
        intent=scenario.judge_intent,
    )


async def run_all() -> list[ScenarioResult]:
    results: list[ScenarioResult] = []
    for scenario in _SCENARIOS:
        tools_called: list[str] = []
        assistant_reply = ""
        async with AgentSession() as session:
            await start_session(session)
            result = await session.run(user_input=scenario.user_input)

        for event in result.events:
            if event.type == "function_call":
                tools_called.append(event.item.name)
            elif event.type == "message":
                assistant_reply = event.item.text_content

        has_expected_tool = (
            scenario.expected_tool is None
            or scenario.expected_tool in tools_called
        )
        try:
            judged = await result.expect.contains_message(role="assistant").judge(
                _judge(),
                intent=scenario.judge_intent,
            )
            judgment = getattr(judged, "judgment", None) or judged
            judge_passed = judgment.success
            judge_reason = judgment.reasoning
        except AssertionError as exc:
            judge_passed = False
            judge_reason = str(exc)

        passed = has_expected_tool and judge_passed
        results.append(ScenarioResult(
            scenario=scenario,
            passed=passed,
            verdict="pass" if passed else "fail",
            judge_reason=(
                judge_reason or "matched expected tool and judged reply"
                if passed
                else _failure_reason(has_expected_tool, judge_reason)
            ),
            assistant_reply=assistant_reply,
            tools_called=tools_called,
        ))
    return results


def _failure_reason(has_expected_tool: bool, judge_reason: str) -> str:
    reasons: list[str] = []
    if not has_expected_tool:
        reasons.append("missing expected tool")
    if judge_reason:
        reasons.append(judge_reason)
    return "; ".join(reasons) or "judge failed"


def reload_scenarios(n: int | None = None) -> list[Scenario]:
    global _SCENARIOS
    if n is not None:
        os.environ["AGENT_OBSERVABILITY_GENERATED_N"] = str(n)
    _SCENARIOS = _load_scenarios()
    return _SCENARIOS


if __name__ == "__main__":
    os.environ.setdefault("AGENT_OBSERVABILITY_AGENT_ID", "demo-pipecat-pizza-bot")
    code = pytest.main([__file__, "-v"])
    if code == 0:
        print(summarize(asyncio.run(run_all())))
    sys.exit(code)
