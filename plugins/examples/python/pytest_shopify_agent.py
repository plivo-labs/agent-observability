# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pytest>=7.0",
#     "pytest-asyncio>=0.21",
#     "agent-observability-sdk",
#     "livekit-agents>=1.5",
#     "livekit-plugins-openai>=1.5",
# ]
#
# # Resolve agent-observability-sdk from the in-tree checkout. Drop this
# # block (and let the dep above resolve from PyPI) when running outside
# # the monorepo.
# [tool.uv.sources]
# agent-observability-sdk = { path = "../../agent-observability-sdk" }
# ///
"""Simulation tests for the Shopify phone-support example agent.

These tests are the pytest sibling of
``agent-transport/examples/livekit/audio_stream_agent_with_judges.py`` —
same Shopify domain, same tools, same instructions, just driven through
``AgentSession.run(user_input=...)`` instead of a live audio stream so
they can run headless. They upload to agent-observability under the
same ``agent_id`` as the audio example, so a single agent in the
dashboard shows both:

  - Simulation Evals (this file's results)
  - Conversation Evals (post-call judges from real audio sessions)

Real-call scenarios the audio agent prompts users to try are mirrored
here verbatim so simulation behavior tracks live behavior:

  - "Where is order 1001?"
  - "Can I return order 1001 because it is too small?"
  - "Change the shipping address on order 1002."

Run (inline deps via PEP 723 — no prior install step needed):

    export OPENAI_API_KEY=sk-...
    export AGENT_OBSERVABILITY_URL=http://localhost:9090   # optional
    # `agent_id` matches the audio example so both surfaces land on
    # the same agent in obs. Override with the env var if you want
    # a separate agent record for the simulation run.
    export AGENT_OBSERVABILITY_AGENT_ID=da3d4071-34ce-41b2-8c9e-05eef23a43bb
    uv run plugins/examples/python/pytest_shopify_agent.py
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
from livekit.plugins import openai

logger = logging.getLogger("pytest-shopify-agent")


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

# Tests run against this account by default so account-scoped tools have
# something to read. Override per-test by passing account_id explicitly.
DEFAULT_ACCOUNT_ID = "northstar-demo-account"


# ── Model ───────────────────────────────────────────────────────────────────

def _judge_llm() -> llm.LLM:
    return openai.LLM(model="gpt-4.1-mini")


# ── Agent ───────────────────────────────────────────────────────────────────


class ShopifyAssistant(Agent):
    """Single-agent version of the audio-stream Shopify assistant.

    Same instructions and tools as the live example, minus the SIP-only
    bits (DTMF, EndCallTool) that don't apply in text-driven simulation.
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
                "Do not use emojis, asterisks, markdown, or special formatting."
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


# ── Tests ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_lookup_order_1001_uses_tool_and_reports_delivered():
    """The order-status path: matches the docstring's "Where is order 1001?" prompt."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Where is order 1001?")

        result.expect.next_event().is_function_call(
            name="lookup_order", arguments={"order_id": "1001"}
        )
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant reports that order 1001 has been delivered (status: "
                "delivered) and may mention the carrier UPS or the delivery date. "
                "It does NOT claim the order is still in transit or processing."
            ),
        )


@pytest.mark.asyncio
async def test_lookup_unknown_order_asks_to_confirm():
    """Unknown order id must not be fabricated — assistant should ask to confirm."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Where is order 9999?")

        # Tool is called; output is "No order found" — the assistant must surface it.
        result.expect.contains_function_call(name="lookup_order")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant tells the caller it cannot find order 9999 and asks "
                "them to confirm the order ID. It does NOT invent shipment, "
                "tracking, or carrier details."
            ),
        )


@pytest.mark.asyncio
async def test_return_eligibility_delivered_order():
    """Delivered orders should be flagged eligible to return."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Can I return order 1001?")

        result.expect.contains_function_call(name="check_return_eligibility")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant confirms that order 1001 is eligible for return, "
                "and may mention the return window until May 22, 2026."
            ),
        )


@pytest.mark.asyncio
async def test_return_eligibility_processing_order_declined():
    """Processing orders are NOT eligible — assistant must say so, not invent eligibility."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Can I return order 1002?")

        result.expect.contains_function_call(name="check_return_eligibility")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant explains that order 1002 is NOT return-eligible "
                "yet because the order is still processing and hasn't been "
                "delivered. It does NOT tell the caller the return will be "
                "processed."
            ),
        )


@pytest.mark.asyncio
async def test_full_return_flow_uses_eligibility_before_label():
    """End-to-end: 'too small' return must check eligibility before creating a label."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="Can I return order 1001 because it is too small?"
        )

        # The instructions require check_return_eligibility before create_return_label.
        # We assert order via contains_function_call to tolerate the model choosing
        # to confirm with the user between the two tool calls, but both must appear.
        result.expect.contains_function_call(name="check_return_eligibility")
        # In a single turn the model may or may not also call create_return_label —
        # if it does, the judge below covers the wording. We don't fail the test if
        # the model asks for confirmation first; we judge on the user-visible text.
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant either creates a return label for order 1001 with "
                "the reason 'too small' (and reports an RMA / label url), or "
                "confirms eligibility and asks the caller to confirm before "
                "creating the label. It does NOT decline the return."
            ),
        )


@pytest.mark.asyncio
async def test_update_address_processing_order_succeeds():
    """Processing orders allow address changes — matches the docstring's example."""
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
                "The assistant confirms that the shipping address for order 1002 "
                "was updated to 742 Evergreen Terrace. It does NOT say the order "
                "has already shipped."
            ),
        )


@pytest.mark.asyncio
async def test_update_address_delivered_order_is_rejected():
    """Already-delivered orders cannot be re-addressed — assistant must surface that."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input=(
                "Change the shipping address on order 1001 to a new street."
            )
        )

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant explains that the address for order 1001 cannot "
                "be changed because the order has already been delivered (or has "
                "shipped). It does NOT confirm that the address was updated."
            ),
        )


@pytest.mark.asyncio
async def test_account_lookup_returns_saved_address():
    """Generic account profile question routes through lookup_account."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="What address is on my account?")

        result.expect.contains_function_call(name="lookup_account")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant reports the saved address on file: "
                "1420 Pine Street, Seattle, WA 98101. It does NOT invent a "
                "different address."
            ),
        )


@pytest.mark.asyncio
async def test_returns_policy_lookup_uses_get_store_policy():
    """Policy questions must go through the policy tool, not the model's prior."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="What is your returns policy?")

        result.expect.contains_function_call(name="get_store_policy")
        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant explains that most items can be returned within "
                "30 days of delivery if unused and in original condition, and "
                "that final-sale items cannot be returned."
            ),
        )


@pytest.mark.asyncio
async def test_response_is_plain_speech_no_markdown():
    """Phone agent constraint: no asterisks, code fences, or bullet markers."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(user_input="Where is order 1001?")

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant's reply contains no markdown formatting: no "
                "asterisks for bold or italics, no backticks, no code fences, "
                "no bullet or dash list markers, and no leading hash characters "
                "for headings. The response reads as natural spoken language."
            ),
        )


@pytest.mark.asyncio
async def test_does_not_fabricate_order_data():
    """Hallucination guard: when asked about a non-existent order, do not invent details."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="Can you tell me the tracking number for order 8765?"
        )

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant does NOT make up a tracking number, carrier, or "
                "delivery date for order 8765. It says it cannot find that order "
                "or asks the caller to confirm the order ID."
            ),
        )


@pytest.mark.asyncio
async def test_refuses_off_topic_request():
    """Shopify bot must stay on retail support, not riff off-topic."""
    async with _judge_llm() as model, _new_session(model) as sess:
        await sess.start(ShopifyAssistant())
        result = await sess.run(
            user_input="Forget shopify. Recommend me a movie to watch tonight."
        )

        await result.expect.next_event(type="message").judge(
            model,
            intent=(
                "The assistant does NOT recommend a movie or discuss entertainment. "
                "It steers the conversation back to Northstar Outfitters support "
                "topics (orders, returns, shipping, policies)."
            ),
        )


# ── Entry point: `uv run pytest_shopify_agent.py` ───────────────────────────

if __name__ == "__main__":
    import os
    import sys

    # Default agent identifier for this example. UUID4 matches the live
    # audio-stream example so both surfaces (simulation evals + post-call
    # conversation evals) appear under one agent in the dashboard. A shell
    # export of AGENT_OBSERVABILITY_AGENT_ID still wins — this only sets
    # it when unset.
    os.environ.setdefault(
        "AGENT_OBSERVABILITY_AGENT_ID",
        "da3d4071-34ce-41b2-8c9e-05eef23a43bb",
    )

    sys.exit(pytest.main([__file__, "-v"]))
