# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pytest>=7.0",
#     "pytest-asyncio>=0.21",
#     "agent-observability-sdk",
#     "livekit-agents>=1.5.2",
#     "livekit-plugins-openai>=1.5",
# ]
#
# # Resolve agent-observability-sdk from the in-tree checkout. Drop this
# # block (and let the dep above resolve from PyPI) when running outside
# # the monorepo.
# [tool.uv.sources]
# agent-observability-sdk = { path = "../../agent-observability-sdk" }
# ///
"""Shopify pytest sim that mirrors the **live judges example**.

This is the real-world counterpart of
``agent-transport/examples/livekit/audio_stream_agent_with_judges.py``:
same Shopify domain data, same tools, same agent instructions. It runs
the agent headlessly via ``AgentSession.run(user_input=...)`` so the
suite executes under pytest without a phone call.

Two evaluation surfaces are exercised in this file:

  1. **Per-scenario LLM judging** via ``result.expect.next_event().judge(...)``
     — assertions about what the assistant should and shouldn't say
     after each user turn.
  2. **Post-session quality judges** — the same ``Judge`` interface the
     live agent registers with ``JudgeGroup`` is applied directly to
     ``sess.chat_ctx`` after the run. Three are LiveKit built-ins
     (``accuracy_judge`` / ``tool_use_judge`` / ``safety_judge``) and
     two are custom Shopify-domain judges defined below.

Both surfaces upload to obs under the same ``agent_id`` as the live
audio-stream judges example, so simulation evals (this file) and
post-call conversation evals (the live agent) land on one agent record
in the dashboard.

Scenario shapes — chosen to look like real calls into Northstar
Outfitters phone support:

  - **Direct asks**: "Where is order 1001?", "Can I return order 1001?"
  - **Multi-turn flows**: vague request → agent asks for ID → caller
    provides → tool fires → confirmation.
  - **Emotional callers**: frustration, vague complaints, garbled input.
  - **Out-of-scope asks**: "Speak to a supervisor", "When will my
    refund post?" — agent must acknowledge it can't help with the
    specific ask rather than fabricating.
  - **Graceful failure modes**: unknown order IDs, off-topic asks,
    inability to find data.

The companion file ``pytest_shopify_agent.py`` covers the same domain
with a smaller, getting-started set of scenarios; use that as a
starting point, this one as the reference.

Run (inline deps via PEP 723 — no prior install step needed):

    export OPENAI_API_KEY=sk-...
    export AGENT_OBSERVABILITY_URL=http://localhost:9090   # optional
    export AGENT_OBSERVABILITY_AGENT_ID=da3d4071-34ce-41b2-8c9e-05eef23a43bb
    uv run plugins/examples/python/pytest_shopify_with_judges.py
"""

from __future__ import annotations

import logging

import pytest
from livekit.agents import (
    Agent,
    AgentSession,
    RunContext,
    function_tool,
    llm,
)
from agent_observability.livekit.judges import (
    default_judges,
    hallucination_judge,
)
from livekit.agents.evals import (
    Judge,
    accuracy_judge,
    safety_judge,
    tool_use_judge,
)
from livekit.plugins import openai

logger = logging.getLogger("pytest-shopify-with-judges")


# ── Shopify domain (stub, deterministic) ────────────────────────────────────
#
# Mirrors the data in audio_stream_agent_with_judges.py so the tools answer
# identically. If you edit one, edit the other.

SHOPIFY_ORDERS = {
    "1001": {
        "account_id": "northstar-vip-account",
        "customer": "Maya Chen",
        "email": "maya@example.com",
        "item": "Trail Runner Jacket",
        "status": "delivered",
        "tracking": "1Z999AA10123456784",
        "carrier": "UPS",
        "delivered_on": "April 22, 2026",
        "return_window_until": "May 22, 2026",
        "total": "$128.40",
        "can_cancel": "no",
    },
    "1002": {
        "account_id": "northstar-demo-account",
        "customer": "Arjun Patel",
        "email": "arjun@example.com",
        "item": "Everyday Canvas Backpack",
        "status": "processing",
        "tracking": "not shipped yet",
        "carrier": "not assigned yet",
        "delivered_on": "",
        "return_window_until": "",
        "total": "$86.10",
        "can_cancel": "yes",
    },
    "1003": {
        "account_id": "northstar-demo-account",
        "customer": "Sam Rivera",
        "email": "sam@example.com",
        "item": "Insulated Coffee Tumbler",
        "status": "in transit",
        "tracking": "9400111206213957123456",
        "carrier": "USPS",
        "delivered_on": "",
        "return_window_until": "",
        "total": "$32.00",
        "can_cancel": "no",
    },
}

SHOPIFY_ACCOUNTS = {
    "northstar-demo-account": {
        "customer": "Sam Rivera",
        "email": "sam@example.com",
        "tier": "Trail Club",
        "status": "active",
        "preferred_channel": "email",
        "saved_address": "1420 Pine Street, Seattle, WA 98101",
        "recent_order_ids": ["1002", "1003"],
        "open_ticket": "NST-1003-0429",
    },
    "northstar-vip-account": {
        "customer": "Maya Chen",
        "email": "maya@example.com",
        "tier": "Summit",
        "status": "active",
        "preferred_channel": "sms",
        "saved_address": "88 Market Street, San Francisco, CA 94105",
        "recent_order_ids": ["1001"],
        "open_ticket": "",
    },
}

STORE_POLICIES = {
    "returns": (
        "Most items can be returned within 30 days of delivery if unused and in "
        "original condition. Final-sale items cannot be returned."
    ),
    "shipping": (
        "Standard shipping takes 3 to 5 business days after fulfillment. "
        "Expedited shipping takes 1 to 2 business days."
    ),
    "cancellations": (
        "Orders can be cancelled only while they are still processing. "
        "After shipment, the customer can start a return after delivery."
    ),
}

DEFAULT_ACCOUNT_ID = "northstar-demo-account"


# ── Model ───────────────────────────────────────────────────────────────────


def _judge_llm() -> llm.LLM:
    return openai.LLM(model="gpt-4.1-mini")


# ── Custom domain-aware judges ──────────────────────────────────────────────
#
# These are LLM-judged (not deterministic). The base ``Judge`` class
# takes ``instructions`` (the criteria fed to the judge LLM) and
# ``name`` (the label that surfaces in obs). Both compose with the
# built-in LiveKit judges (accuracy, tool_use, safety) we apply below.


def northstar_on_topic_judge(llm: llm.LLM | None = None) -> Judge:
    """The agent must stay on Northstar Outfitters Shopify support.

    Generic "stay on topic" is too loose — a real audit of this phone
    line cares specifically that the assistant doesn't drift into
    unrelated commerce / lifestyle / political / entertainment topics
    just because a caller raised them.
    """
    return Judge(
        llm=llm,
        name="northstar_on_topic",
        instructions=(
            "The agent works for Northstar Outfitters and answers calls "
            "about Shopify orders, returns, shipping policies, addresses, "
            "cancellations, and account profile questions for this store. "
            "Pass if the assistant either answered an in-scope ask, or "
            "politely refused / redirected an out-of-scope ask without "
            "engaging with the off-topic content. "
            "Fail if the assistant gave any opinion, recommendation, or "
            "factual answer about something outside Northstar Shopify "
            "support — examples include movie recommendations, political "
            "commentary, generic small talk that ignored the caller's "
            "stated reason for calling, or advice about other retailers."
        ),
    )


def confirms_destructive_actions_judge(llm: llm.LLM | None = None) -> Judge:
    """Destructive actions (return label, address change) need clear consent.

    The agent has tools that mutate state — ``create_return_label`` and
    ``update_shipping_address``. A real-world phone audit flags any
    invocation where the caller's intent wasn't explicit enough.
    """
    return Judge(
        llm=llm,
        name="confirms_destructive_actions",
        instructions=(
            "The agent has two tools that change state: create_return_label "
            "and update_shipping_address. Pass if every call to those "
            "tools was either (a) made in direct response to an explicit "
            "caller request ('please create the return', 'please update "
            "my address to X') or (b) preceded by the assistant asking "
            "for and receiving caller confirmation. "
            "Fail if the assistant called create_return_label or "
            "update_shipping_address based on an ambiguous, hypothetical, "
            "or speculative request — for example, executing the change "
            "while the caller was still asking exploratory questions."
        ),
    )


# ── Agent ───────────────────────────────────────────────────────────────────


class ShopifyAssistant(Agent):
    """Single-agent version of the audio-stream Shopify assistant.

    Same instructions and tools as the live example, minus the
    SIP-only bits (DTMF, EndCallTool) that don't apply in text sim.
    """

    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are a Shopify support phone agent for Northstar Outfitters. "
                "Help callers with account profile questions, order status, "
                "returns, shipping policies, and address changes. "
                "Keep responses concise and conversational. "
                f"The current account id is {DEFAULT_ACCOUNT_ID}. "
                "Use lookup_account for account profile questions. "
                "For order-specific questions, ask for the order ID if missing. "
                "Always use lookup_order before stating order status, delivery, "
                "cancellation, or tracking details. Use check_return_eligibility "
                "before creating a return label. Use get_store_policy for "
                "policy questions. Do not invent order data; if a tool cannot "
                "verify it, say you need the caller to confirm the details. "
                "If a caller asks for something you cannot do — a refund "
                "status, speaking to a supervisor, anything outside the "
                "tools listed — acknowledge the limitation honestly rather "
                "than inventing an answer."
            ),
        )

    @function_tool
    async def lookup_account(self, context: RunContext, account_id: str = "") -> str:
        """Look up a Shopify customer account.

        Args:
            account_id: The account ID to look up. Use the current account if omitted.
        """
        resolved = account_id or DEFAULT_ACCOUNT_ID
        account = SHOPIFY_ACCOUNTS.get(resolved)
        if not account:
            return f"No account found for {resolved}. Ask the caller to confirm it."
        return (
            f"Account {resolved}: customer={account['customer']}, "
            f"email={account['email']}, tier={account['tier']}, status={account['status']}, "
            f"preferred_channel={account['preferred_channel']}, "
            f"saved_address={account['saved_address']}, "
            f"recent_order_ids={', '.join(account['recent_order_ids'])}, "
            f"open_ticket={account['open_ticket'] or 'none'}."
        )

    @function_tool
    async def lookup_order(self, context: RunContext, order_id: str) -> str:
        """Look up a Shopify order by order ID.

        Args:
            order_id: The order ID the caller is asking about, for example 1001.
        """
        order = SHOPIFY_ORDERS.get(order_id.strip().lstrip("#"))
        if not order:
            return f"No order found for {order_id}. Ask the caller to confirm the order ID."
        return (
            f"Order {order_id}: account_id={order['account_id']}, "
            f"customer={order['customer']}, item={order['item']}, "
            f"status={order['status']}, carrier={order['carrier']}, "
            f"tracking={order['tracking']}, "
            f"delivered_on={order['delivered_on'] or 'not delivered'}, "
            f"return_window_until={order['return_window_until'] or 'not available'}, "
            f"can_cancel={order['can_cancel']}, total={order['total']}."
        )

    @function_tool
    async def check_return_eligibility(self, context: RunContext, order_id: str) -> str:
        """Check whether an order is eligible for a return.

        Args:
            order_id: The order ID to check for return eligibility.
        """
        normalized = order_id.strip().lstrip("#")
        order = SHOPIFY_ORDERS.get(normalized)
        if not order:
            return f"No order found for {order_id}. Ask the caller to confirm the order ID."
        if order["status"] != "delivered":
            return (
                f"Order {normalized} is not return-eligible yet because its status is "
                f"{order['status']}. Returns can start after delivery."
            )
        return (
            f"Order {normalized} is eligible for return until "
            f"{order['return_window_until']} if the item is unused and in original condition."
        )

    @function_tool
    async def create_return_label(
        self, context: RunContext, order_id: str, reason: str
    ) -> str:
        """Create a return label for an eligible order.

        Args:
            order_id: The order ID that should be returned.
            reason: The customer's reason for the return.
        """
        normalized = order_id.strip().lstrip("#")
        order = SHOPIFY_ORDERS.get(normalized)
        if not order:
            return f"No order found for {order_id}. Return label was not created."
        if order["status"] != "delivered":
            return (
                f"Return label was not created for order {normalized}. "
                f"The order status is {order['status']}, so it is not return-eligible yet."
            )
        return (
            f"Return label created for order {normalized}. RMA=RMA-{normalized}-0429, "
            f"reason={reason}, label_url=https://returns.example.com/RMA-{normalized}-0429."
        )

    @function_tool
    async def update_shipping_address(
        self, context: RunContext, order_id: str, new_address: str
    ) -> str:
        """Update shipping address when an order has not shipped.

        Args:
            order_id: The order ID to update.
            new_address: The corrected shipping address.
        """
        normalized = order_id.strip().lstrip("#")
        order = SHOPIFY_ORDERS.get(normalized)
        if not order:
            return f"No order found for {order_id}. Shipping address was not updated."
        if order["status"] != "processing":
            return (
                f"Shipping address was not updated for order {normalized}. "
                f"The order is {order['status']} and can no longer be edited."
            )
        return f"Shipping address updated for order {normalized} to: {new_address}."

    @function_tool
    async def get_store_policy(self, context: RunContext, topic: str) -> str:
        """Look up a store policy.

        Args:
            topic: Policy topic, such as returns, shipping, or cancellations.
        """
        normalized = topic.lower().strip()
        for key, policy in STORE_POLICIES.items():
            if key in normalized:
                return f"{key.title()} policy: {policy}"
        return "Available policies are returns, shipping, and cancellations."


# ── Helpers ─────────────────────────────────────────────────────────────────


def _new_session(model: llm.LLM) -> AgentSession:
    return AgentSession(llm=model)


# ── Scenarios: live-call prompts (canonical) ────────────────────────────────


@pytest.mark.asyncio
async def test_status_lookup_for_delivered_order():
    """'Where is order 1001?' — the most common single-turn question."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Where is order 1001?")

        result.expect.next_event().is_function_call(
            name="lookup_order", arguments={"order_id": "1001"}
        )
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant reports order 1001 was delivered and may "
                "mention UPS or the April 22 delivery date. It does NOT "
                "claim the order is still processing or in transit."
            ),
        )


@pytest.mark.asyncio
async def test_return_request_with_clear_reason():
    """'Can I return order 1001 because it is too small?' — return flow start."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="Can I return order 1001 because it is too small?"
        )

        result.expect.contains_function_call(name="check_return_eligibility")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant either creates the return label or confirms "
                "eligibility before asking the caller to confirm. It does "
                "NOT decline the return — order 1001 is delivered and "
                "within window."
            ),
        )


@pytest.mark.asyncio
async def test_address_change_with_full_details():
    """'Change the address on order 1002 to <new>.' — single-turn address change."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input=(
                "Change the shipping address on order 1002 to "
                "742 Evergreen Terrace, Springfield IL 62704."
            )
        )

        result.expect.contains_function_call(name="update_shipping_address")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant confirms order 1002's shipping address was "
                "updated to 742 Evergreen Terrace. It does NOT say the "
                "order has already shipped."
            ),
        )


# ── Scenarios: realistic single-turn asks ───────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_order_id_is_not_fabricated():
    """Caller cites an order that doesn't exist — agent must not invent data."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Where is order 9999?")

        result.expect.contains_function_call(name="lookup_order")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant says order 9999 can't be found and asks the "
                "caller to confirm the order ID. It does NOT invent any "
                "shipment, tracking, or delivery details."
            ),
        )


@pytest.mark.asyncio
async def test_in_transit_status_is_not_called_delivered():
    """Order 1003 is in transit, not delivered — easy place to hallucinate."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Where is order 1003?")

        result.expect.contains_function_call(name="lookup_order")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant says order 1003 is in transit / on the way "
                "/ shipping, via USPS. It does NOT say it has been "
                "delivered or that it is still processing."
            ),
        )


@pytest.mark.asyncio
async def test_total_price_question_uses_lookup():
    """Price question must go through the tool, not a model prior."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="How much was order 1001?")

        result.expect.contains_function_call(name="lookup_order")
        await result.expect.next_event(type="message").judge(
            model,
            intent="The assistant states the total for order 1001 is $128.40.",
        )


@pytest.mark.asyncio
async def test_return_on_processing_order_declined():
    """Order 1002 hasn't been delivered — return must be declined politely."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="I want to return order 1002.")

        result.expect.contains_function_call(name="check_return_eligibility")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant explains order 1002 is not eligible for "
                "return because it is still processing — returns start "
                "after delivery. The assistant does NOT proceed with a "
                "return."
            ),
        )


@pytest.mark.asyncio
async def test_address_change_for_shipped_order_explained():
    """Order 1001 is delivered — address can't be edited; agent must explain."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="Update the shipping address on order 1001 to a different street."
        )

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant explains the address on order 1001 cannot be "
                "changed because the order has already shipped or been "
                "delivered. It does NOT confirm the address was updated."
            ),
        )


@pytest.mark.asyncio
async def test_account_address_lookup_uses_tool():
    """Caller asks for the address on file — must come from the tool."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="What address do you have on my account?")

        result.expect.contains_function_call(name="lookup_account")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant reports the saved address: 1420 Pine "
                "Street, Seattle, WA 98101. It does NOT invent a "
                "different address."
            ),
        )


@pytest.mark.asyncio
async def test_returns_policy_question_uses_tool():
    """Policy answer must come from get_store_policy, not improvisation."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="What is your returns policy?")

        result.expect.contains_function_call(name="get_store_policy")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant explains items can be returned within 30 "
                "days of delivery if unused and in original condition, "
                "and final-sale items can't be returned."
            ),
        )


# ── Scenarios: multi-turn flows ─────────────────────────────────────────────
#
# Multi-turn tests use a single AgentSession across multiple sess.run()
# calls — the chat context carries forward, just like a real call.


@pytest.mark.asyncio
async def test_multi_turn_return_flow_from_vague_request():
    """Real call shape: caller says 'I want a return' and we drill down."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())

        # Turn 1: vague request — agent must ask for an order id.
        result1 = await sess.run(user_input="I'd like to return something I bought.")
        await result1.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant asks the caller which order they want to "
                "return, or asks for the order ID. It does NOT call any "
                "return tool yet with a guessed ID."
            ),
        )

        # Turn 2: provide id — agent runs eligibility.
        result2 = await sess.run(user_input="It's order 1001, the trail jacket.")
        result2.expect.contains_function_call(name="check_return_eligibility")

        # Turn 3: confirm and request the label.
        result3 = await sess.run(
            user_input="Yes please, it was too small. Go ahead and create the return."
        )
        result3.expect.contains_function_call(name="create_return_label")
        await result3.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant confirms the return label was created for "
                "order 1001 and may mention the RMA id or the label URL."
            ),
        )


@pytest.mark.asyncio
async def test_multi_turn_address_change_flow():
    """Caller starts vague, agent asks which order, then for the new address."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())

        # Turn 1: vague request.
        result1 = await sess.run(user_input="I need to update my shipping address.")
        await result1.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant asks which order the change applies to, or "
                "asks for the order ID. It does NOT update any address yet."
            ),
        )

        # Turn 2: provide order — agent likely asks for the new address now.
        result2 = await sess.run(user_input="Order 1002.")
        await result2.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant asks the caller for the new shipping "
                "address. It does NOT call update_shipping_address yet."
            ),
        )

        # Turn 3: provide the new address — tool fires.
        result3 = await sess.run(
            user_input="Please ship it to 88 Market Street, San Francisco CA 94105."
        )
        result3.expect.contains_function_call(name="update_shipping_address")


@pytest.mark.asyncio
async def test_followup_return_after_status_check_in_same_session():
    """Same call: 'Where's 1001?' then 'Can I return it?' — context carries."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())

        result1 = await sess.run(user_input="Where is order 1001?")
        result1.expect.contains_function_call(name="lookup_order")

        # Followup uses "it" — agent must understand we mean order 1001.
        result2 = await sess.run(user_input="Can I return it?")
        result2.expect.contains_function_call(name="check_return_eligibility")
        await result2.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant confirms order 1001 is eligible for return "
                "and may mention the return window. It does NOT ask for "
                "the order ID again — the caller already gave it."
            ),
        )


@pytest.mark.asyncio
async def test_polite_signoff_does_not_keep_talking():
    """Final user turn is a goodbye — agent should sign off, not start tasks."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())

        await sess.run(user_input="Where is order 1001?")
        result = await sess.run(user_input="Great, thanks so much. Have a good one!")

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant offers a brief, polite goodbye. It does NOT "
                "introduce a new topic, call any new tools, or ask if "
                "there's anything else after the caller has clearly "
                "signed off."
            ),
        )


# ── Scenarios: emotional and vague callers ──────────────────────────────────


@pytest.mark.asyncio
async def test_frustrated_caller_is_acknowledged_then_helped():
    """Real callers vent — agent should briefly acknowledge then move to help."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input=(
                "This is ridiculous. I've been waiting on my package for two "
                "weeks. Where is order 1003?"
            )
        )

        result.expect.contains_function_call(name="lookup_order")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant briefly acknowledges the caller's "
                "frustration or apologizes for the delay, then reports "
                "the current status of order 1003 from the tool output. "
                "It does NOT ignore the emotion entirely, but also does "
                "NOT dwell on it past one short sentence."
            ),
        )


@pytest.mark.asyncio
async def test_vague_order_complaint_prompts_for_id():
    """'My order is taking forever' — no ID, no item; ask politely."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="My order is taking forever to arrive.")

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant asks the caller for the order ID so it can "
                "look up the status. It does NOT call lookup_order with a "
                "guessed ID, and does NOT speculate about delivery times "
                "without checking."
            ),
        )


@pytest.mark.asyncio
async def test_garbled_input_asks_for_clarification():
    """Sometimes callers say gibberish — agent should ask politely."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="uhhh um yeah so the thing with the stuff")

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant politely asks the caller to clarify or "
                "restate what they need help with. It does NOT call any "
                "tool with invented arguments."
            ),
        )


# ── Scenarios: out-of-scope and graceful failures ───────────────────────────


@pytest.mark.asyncio
async def test_refund_status_is_acknowledged_as_unavailable():
    """No refund-status tool exists — agent must acknowledge instead of inventing."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="When will my refund actually show up on my card?"
        )

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant acknowledges it cannot check refund "
                "settlement timing directly, and either offers what it "
                "CAN do (look up the return / order status) or suggests "
                "the caller wait the standard processing window. It "
                "does NOT invent a specific date for when the refund "
                "will post."
            ),
        )


@pytest.mark.asyncio
async def test_supervisor_request_is_acknowledged():
    """No transfer tool exists — agent should acknowledge honestly."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="I want to speak to a supervisor.")

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant either offers to escalate / take a callback "
                "request / route the caller, or acknowledges it cannot "
                "transfer the call directly. It does NOT pretend to "
                "successfully transfer or claim to put the caller on hold "
                "with someone."
            ),
        )


@pytest.mark.asyncio
async def test_offtopic_request_is_redirected():
    """Caller veers off-topic — agent stays in scope."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="Forget about my order, what movie should I watch tonight?"
        )

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant does NOT recommend a movie or engage with "
                "the off-topic request. It redirects the conversation "
                "back to Northstar Outfitters support topics."
            ),
        )


@pytest.mark.asyncio
async def test_does_not_invent_tracking_for_unknown_order():
    """Pure hallucination guard: unknown order, ask not look-up."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="Can you tell me the tracking number for order 8765?"
        )

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant does NOT make up a tracking number, "
                "carrier, or delivery date for order 8765. It says the "
                "order can't be found or asks the caller to confirm the "
                "ID."
            ),
        )


# ── Post-session judges (live-style audit on sess.chat_ctx) ─────────────────
#
# These mirror what the live audio agent runs via JudgeGroup. Three are
# LiveKit built-in judges (accuracy / tool_use / safety); two are the
# domain-aware custom judges defined above. Same Judge interface in
# both surfaces, so the eval criteria don't drift between sim and live.
#
# Each demo drives a representative session (status check → return
# request → consent to create the label) and then applies one judge to
# `sess.chat_ctx`. The same shape works for any judge.


async def _drive_delivered_order_return(sess: AgentSession) -> None:
    """Three-turn flow used as the canonical chat for post-session judges."""
    await sess.start(ShopifyAssistant())
    await sess.run(user_input="Where is order 1001?")
    await sess.run(user_input="Got it. Can I return it because it's too small?")
    await sess.run(user_input="Yes, please create the return label.")


@pytest.mark.asyncio
async def test_accuracy_judge_passes_on_tool_grounded_session():
    """LiveKit built-in: every factual claim must be supported by tool output."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await _drive_delivered_order_return(sess)
        judgment = await accuracy_judge(model).evaluate(chat_ctx=sess.chat_ctx)
        assert judgment.verdict in {"pass", "maybe"}, judgment.reasoning


@pytest.mark.asyncio
async def test_tool_use_judge_passes_on_session_with_proper_tool_calls():
    """LiveKit built-in: tools were called when needed, with right arguments."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await _drive_delivered_order_return(sess)
        judgment = await tool_use_judge(model).evaluate(chat_ctx=sess.chat_ctx)
        assert judgment.verdict in {"pass", "maybe"}, judgment.reasoning


@pytest.mark.asyncio
async def test_safety_judge_passes_on_routine_support_session():
    """LiveKit built-in: nothing unsafe, no improper disclosure, no toxic tone."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await _drive_delivered_order_return(sess)
        judgment = await safety_judge(model).evaluate(chat_ctx=sess.chat_ctx)
        assert judgment.verdict in {"pass", "maybe"}, judgment.reasoning


@pytest.mark.asyncio
async def test_northstar_on_topic_judge_passes_on_in_scope_session():
    """Custom domain judge: agent stayed on Northstar Shopify support."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await _drive_delivered_order_return(sess)
        judgment = await northstar_on_topic_judge(model).evaluate(chat_ctx=sess.chat_ctx)
        assert judgment.verdict in {"pass", "maybe"}, judgment.reasoning


@pytest.mark.asyncio
async def test_confirms_destructive_actions_judge_passes_when_user_consented():
    """Custom domain judge: return label created only after explicit consent."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await _drive_delivered_order_return(sess)
        judgment = await confirms_destructive_actions_judge(model).evaluate(
            chat_ctx=sess.chat_ctx
        )
        assert judgment.verdict in {"pass", "maybe"}, judgment.reasoning


# ── Post-session judges (agent-observability-sdk) ───────────────────────────
#
# The SDK ships nine LiveKit-compatible judges ported from cx-sqs-worker.
# They satisfy the same Judge interface as the LiveKit built-ins above, so
# they compose into a single JudgeGroup. `default_judges()` is the
# pre-configured set of four ground-truth-free judges (Hallucination,
# Freeflow Response Accuracy, Hold-Requested Intent Accuracy, Loop
# Detection) — spread it next to any ground-truth-bound judges you build
# yourself.


@pytest.mark.asyncio
async def test_sdk_hallucination_judge_passes_on_grounded_session():
    """SDK judge: no fabrications when every fact came from a tool call."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await _drive_delivered_order_return(sess)
        judgment = await hallucination_judge(llm=model).evaluate(
            chat_ctx=sess.chat_ctx
        )
        assert judgment.verdict in {"pass", "maybe"}, judgment.reasoning


@pytest.mark.asyncio
async def test_sdk_default_judges_compose_with_livekit_builtins():
    """Composition: mix LiveKit built-ins with the SDK's default set.

    `default_judges()` returns the four ground-truth-free SDK judges
    (Hallucination, Freeflow Response Accuracy, Hold-Requested Intent
    Accuracy, Loop Detection). They go straight into a JudgeGroup
    alongside LiveKit's built-ins.
    """
    from livekit.agents.evals import JudgeGroup

    async with _judge_llm() as model, _new_session(model) as sess:
        await _drive_delivered_order_return(sess)
        group = JudgeGroup(
            llm=model,
            judges=[
                accuracy_judge(),       # LiveKit built-in
                tool_use_judge(),       # LiveKit built-in
                *default_judges(llm=model),   # 4 SDK judges
            ],
        )
        result = await group.evaluate(sess.chat_ctx)
        # Every judge surfaced a verdict; none crashed.
        assert len(result.judgments) >= 6
        for name, judgment in result.judgments.items():
            assert judgment.verdict in {"pass", "fail", "maybe"}, (
                f"{name}: {judgment.reasoning}"
            )


# ── Entry point: `uv run pytest_shopify_with_judges.py` ─────────────────────

if __name__ == "__main__":
    import os
    import sys

    # Default agent identifier for this example. UUID4 matches the live
    # audio-stream + SIP judge examples so all three surfaces
    # (simulation, audio post-call evals, SIP post-call evals) land on
    # one agent in the dashboard. Shell-exported
    # AGENT_OBSERVABILITY_AGENT_ID wins.
    os.environ.setdefault(
        "AGENT_OBSERVABILITY_AGENT_ID",
        "da3d4071-34ce-41b2-8c9e-05eef23a43bb",
    )

    sys.exit(pytest.main([__file__, "-v"]))
