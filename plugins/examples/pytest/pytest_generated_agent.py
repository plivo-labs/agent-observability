# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pytest>=7.0",
#     "pytest-asyncio>=0.21",
#     "pytest-agent-observability",
#     "livekit-agents>=1.5",
#     "livekit-plugins-openai>=1.5",
#     "openai>=1.40",
# ]
#
# [tool.uv.sources]
# pytest-agent-observability = { path = "../../pytest-agent-observability" }
# ///
"""Pytest example where an LLM generates the scenarios for you.

You describe the agent (role, instructions, tool signatures). At test-collection
time the runner calls OpenAI once to produce a diverse set of scenarios, then
`@pytest.mark.parametrize` turns each into its own pytest case. Every case
runs the agent, lets a second LLM judge the reply, and passes/fails on the
judge's verdict (plus a strict `expected_tool` check if the generator asked
for one).

This complements `pytest_generated_agent.py`-style hand-written tests:

  - Hand-written tests pin behaviors you already know you care about.
  - Generated tests find gaps you wouldn't have thought of.

Reused from `scenario_runner.py`:
  - `generate_scenarios(spec, n)` → the LLM call
  - `run_scenario(factory, sc, judge)` → one eval
  - `summarize(results)` → human-readable report

Run (inline deps via PEP 723 — no prior install step needed):

    export OPENAI_API_KEY=sk-...
    export AGENT_OBSERVABILITY_AGENT_ID=demo-pizza-bot   # optional
    export AGENT_OBSERVABILITY_GENERATED_N=10            # optional; default 10
    uv run plugins/examples/pytest_generated_agent.py
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import pytest
from livekit.agents import Agent, AgentSession, RunContext, function_tool
from livekit.plugins import openai as lk_openai
from scenario_runner import (
    AgentSpec,
    Scenario,
    generate_scenarios,
)

# ── The agent under test ────────────────────────────────────────────────────

_MENU = {
    "margherita": {"price_cents": 1200, "desc": "tomato, mozzarella, basil"},
    "pepperoni": {"price_cents": 1400, "desc": "pepperoni, mozzarella"},
    "veggie": {"price_cents": 1300, "desc": "peppers, onions, olives, mushrooms"},
}
_ORDERS: dict[str, dict] = {}


class PizzaShopAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are the voice order-taker at Tony's Pizza. You can look "
                "up the menu, place orders, check status, and cancel orders. "
                "Only take orders for items on the menu — if the caller asks "
                "for something not on the menu, say so. Always confirm the "
                "total and delivery address before calling place_order. "
                "Never quote a price you did not get from the menu tool. "
                "Stay on-topic: no jokes, no unrelated chit-chat."
            ),
        )

    @function_tool
    async def get_menu(self, ctx: RunContext) -> str:
        """Return the current menu as a readable list with prices."""
        lines = [
            f"- {name}: ${info['price_cents'] / 100:.2f} — {info['desc']}"
            for name, info in _MENU.items()
        ]
        return "Menu:\n" + "\n".join(lines)

    @function_tool
    async def place_order(
        self,
        ctx: RunContext,
        items: list[str],
        delivery_address: str,
    ) -> str:
        """Place an order.

        Args:
            items: List of pizza names, lower-case, matching the menu.
            delivery_address: Free-form street address.
        """
        unknown = [i for i in items if i.lower() not in _MENU]
        if unknown:
            return f"ERROR: items not on menu: {', '.join(unknown)}"
        order_id = f"o-{len(_ORDERS) + 1:04d}"
        total = sum(_MENU[i.lower()]["price_cents"] for i in items)
        _ORDERS[order_id] = {
            "status": "received",
            "items": items,
            "address": delivery_address,
            "total_cents": total,
        }
        return f"Order {order_id} placed. Total ${total / 100:.2f}."

    @function_tool
    async def get_order_status(self, ctx: RunContext, order_id: str) -> str:
        """Return the status of an order by id."""
        order = _ORDERS.get(order_id)
        if not order:
            return f"ERROR: order {order_id!r} not found"
        return f"Order {order_id}: {order['status']}"

    @function_tool
    async def cancel_order(self, ctx: RunContext, order_id: str) -> str:
        """Cancel an order by id."""
        order = _ORDERS.get(order_id)
        if not order:
            return f"ERROR: order {order_id!r} not found"
        if order["status"] == "delivered":
            return f"ERROR: order {order_id} was already delivered"
        order["status"] = "cancelled"
        return f"Order {order_id} cancelled."


SPEC = AgentSpec(
    name="PizzaShopAgent",
    role="Voice order-taker for a neighbourhood pizza shop.",
    instructions=(
        "Take orders for menu items only. Confirm totals and address before "
        "placing. Reject off-menu requests and off-topic chit-chat. Never "
        "quote a price you did not get from get_menu."
    ),
    tools=[
        {"name": "get_menu", "params": "", "description": "Return menu with prices."},
        {
            "name": "place_order",
            "params": "items: list[str], delivery_address: str",
            "description": "Place an order; rejects off-menu items.",
        },
        {
            "name": "get_order_status",
            "params": "order_id: str",
            "description": "Return status of an order.",
        },
        {
            "name": "cancel_order",
            "params": "order_id: str",
            "description": "Cancel an order unless it's already delivered.",
        },
    ],
)


# ── Collection-time scenario generation ─────────────────────────────────────


def _load_scenarios() -> list[Scenario]:
    """Generate or load scenarios at import/collection time.

    We call OpenAI synchronously here (via asyncio.run) because pytest needs
    the parametrize iterable to be concrete *before* test functions run. The
    result is cached in the module so a single `pytest` run hits the API once.
    """
    n = int(os.environ.get("AGENT_OBSERVABILITY_GENERATED_N", "10"))

    if not os.environ.get("OPENAI_API_KEY"):
        pytest.skip(
            "OPENAI_API_KEY is not set — cannot generate scenarios. "
            "Export the key to run this example.",
            allow_module_level=True,
        )

    return asyncio.run(generate_scenarios(SPEC, n=n))


_SCENARIOS: list[Scenario] = _load_scenarios()


# ── The test ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", _SCENARIOS, ids=[s.name for s in _SCENARIOS])
async def test_generated_scenario(scenario: Scenario) -> None:
    """One parametrized case per generated scenario.

    We use the framework's `.judge()` API rather than our own judge loop so
    the `pytest-agent-observability` plugin (which monkey-patches
    `ChatMessageAssert.judge`) captures each generated scenario's intent +
    verdict + reasoning as a first-class Judgment event in the dashboard. A
    fail surfaces as a judgment card, not a raw pytest assertion traceback.
    """
    async with (
        lk_openai.LLM(model="gpt-4.1-mini") as model,
        AgentSession(llm=model) as sess,
    ):
        await sess.start(PizzaShopAgent())
        result = await sess.run(user_input=scenario.user_input)

        # Strict tool-call check when the generator specified one. This still
        # fails via pytest assertion (it's a structural check, not an
        # LLM-judged one), which is the right category for it.
        if scenario.expected_tool:
            result.expect.contains_function_call(name=scenario.expected_tool)

        # The main verdict goes through `.judge()`, which the plugin records.
        await result.expect.next_event(type="message").judge(
            model, intent=scenario.judge_intent
        )


# ── Programmatic entry point (used by fastapi_runner.py) ────────────────────


async def run_all() -> list[ScenarioResult]:
    """Run every generated scenario and return raw results.

    The FastAPI endpoint in `fastapi_runner.py` imports this when the caller
    wants to bypass pytest entirely. Shares the same scenarios and the same
    agent — only the framing changes.
    """
    from scenario_runner import run_scenarios

    return await run_scenarios(PizzaShopAgent, _SCENARIOS)


def reload_scenarios(n: int | None = None) -> list[Scenario]:
    """Regenerate the module-level scenario list. Useful for HTTP retriggering."""
    global _SCENARIOS
    if n is not None:
        os.environ["AGENT_OBSERVABILITY_GENERATED_N"] = str(n)
    _SCENARIOS = _load_scenarios()
    return _SCENARIOS


# ── Entry point: `uv run pytest_generated_agent.py` ─────────────────────────

if __name__ == "__main__":
    import sys

    # Default dashboard tag for this example. A shell export of
    # AGENT_OBSERVABILITY_AGENT_ID still wins — this only sets it when unset.
    os.environ.setdefault("AGENT_OBSERVABILITY_AGENT_ID", "demo-pizza-bot")

    sys.exit(pytest.main([__file__, "-v"]))
