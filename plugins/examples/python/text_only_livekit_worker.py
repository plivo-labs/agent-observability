# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "livekit-agents>=1.5.2",
#     "livekit-plugins-openai>=1.5.6",
#     "python-dotenv",
#     "agent-observability-sdk",
# ]
#
# [tool.uv.sources]
# # Resolve agent-observability-sdk from this checkout. Drop the override
# # (and let the dep above resolve from PyPI) when running outside the
# # monorepo.
# agent-observability-sdk = { path = "../../agent-observability-sdk" }
# ///
"""Raw-LiveKit text-only worker, instrumented via agent-observability-sdk.

Drives ``AgentSession`` with ``room_options.text_input/output=True`` so
the agent runs without any STT / TTS pipeline. Every session uploads its
report to agent-observability v2 via LiveKit's native upload path; the
SDK helpers handle the (otherwise hand-rolled) tagging, judge-running,
and URL resolution.

Run:

    export LIVEKIT_OBSERVABILITY_URL=https://obs.example.com
    export AGENT_OBSERVABILITY_AGENT_ID=9c2f7e3d-4b8a-4d2e-9f1b-textonly
    export OPENAI_API_KEY=sk-...
    uv run plugins/examples/python/text_only_livekit_worker.py console --text --record

For deployment as a normal worker (against a real LiveKit cluster):

    export LIVEKIT_URL=wss://...
    export LIVEKIT_API_KEY=...
    export LIVEKIT_API_SECRET=...
    # plus the env vars above
    uv run plugins/examples/python/text_only_livekit_worker.py start

What this demonstrates:

  - ``init_observability(ctx.tagger, ...)`` — one call replaces ~20 lines
    of hand-rolled ``tagger.add(...)`` plumbing and fast-fails if the
    upload URL is unset.
  - ``run_judges_on_report(report, judges=...)`` — wraps the LiveKit
    ``JudgeGroup`` setup, structured logging, and LLM cleanup; mixes
    LiveKit built-ins with SDK judges.
  - ``default_judges()`` — pre-configured ground-truth-free judges
    (Hallucination, Freeflow Response Accuracy, Hold-Requested Intent
    Accuracy, Loop Detection) that work on any session in isolation.

agent-transport's ``AudioStreamServer`` already wires this internally —
the helpers exist for workers that drive raw LiveKit directly.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any

from dotenv import load_dotenv

from agent_observability.livekit import init_observability, run_judges_on_report
from agent_observability.livekit.judges import default_judges
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    cli,
    room_io,
)
from livekit.agents.evals import accuracy_judge
from livekit.agents.llm import function_tool
from livekit.plugins import openai

load_dotenv()

logger = logging.getLogger("text-only-livekit-worker")

# Console mode picks up these defaults when LIVEKIT_* envs are missing.
# Lets `uv run … console --text --record` work out of the box for a
# local-only demo against the LiveKit console worker.
if "console" in sys.argv:
    os.environ.setdefault("LIVEKIT_URL", "ws://localhost:7880")
    os.environ.setdefault("LIVEKIT_API_KEY", "demo-livekit-api-key")
    os.environ.setdefault("LIVEKIT_API_SECRET", "demo-livekit-api-secret")

AGENT_ID = os.environ.get(
    "AGENT_OBSERVABILITY_AGENT_ID",
    "9c2f7e3d-4b8a-4d2e-9f1b-textonlyworker01",
)
AGENT_NAME = "text_only_livekit_worker"
ACCOUNT_ID = os.environ.get("AGENT_ACCOUNT_ID", "demo-account")

# Recording knobs the worker passes to ``AgentSession.start(record=...)``.
# Audio off, transcript / logs / traces on — that's the minimal payload
# the v2 server needs to materialize a session row.
TEXT_ONLY_RECORDING_OPTIONS = {
    "audio": False,
    "transcript": True,
    "logs": True,
    "traces": True,
}


class DemoAgent(Agent):
    """Tiny support agent that drives one tool call."""

    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are a brief support agent. When the user gives an "
                "order ID, call lookup_order. Otherwise answer concisely "
                "and stay on topic. Never invent order details."
            )
        )

    @function_tool
    async def lookup_order(
        self, context: RunContext, order_id: str
    ) -> dict[str, Any]:
        """Look up an order by ID.

        Args:
            order_id: The numeric order ID provided by the customer.
        """
        # Stubbed so the demo is deterministic.
        if order_id == "1001":
            return {
                "found": True,
                "order_id": "1001",
                "status": "delivered",
                "carrier": "UPS",
                "delivered_on": "2026-04-22",
            }
        return {"found": False, "order_id": order_id}


server = AgentServer()


async def on_session_end(ctx: JobContext) -> None:
    """Run judges against the session report at end-of-call.

    The SDK helper hides the `JudgeGroup` construction, exception handling,
    structured logging, and `llm.aclose()` cleanup. Pass any mix of LiveKit
    built-in judges (`accuracy_judge` here) and SDK judges
    (`default_judges()` returns the four ground-truth-free ones).
    """
    report = ctx.make_session_report()
    await run_judges_on_report(
        report,
        judges=[
            accuracy_judge(),       # LiveKit built-in
            *default_judges(),      # 4 SDK judges (hallucination, etc.)
        ],
        logger=logger,
    )
    logger.info(
        "Session ending: room_id=%s turns=%d",
        report.room_id,
        len(report.chat_history.items),
    )


@server.rtc_session(agent_name=AGENT_NAME, on_session_end=on_session_end)
async def entrypoint(ctx: JobContext) -> None:
    # One call: validates the URL env (raises if unset), emits the full
    # tag bundle (agent_id, account_id, agent.name, transport) the v2
    # server's ingest path expects.
    init_observability(
        ctx.tagger,
        agent_id=AGENT_ID,
        agent_name=AGENT_NAME,
        account_id=ACCOUNT_ID,
        transport="text",
        logger=logger,
    )

    session = AgentSession(
        llm=openai.LLM(model=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")),
    )
    await session.start(
        agent=DemoAgent(),
        room=ctx.room,
        record=TEXT_ONLY_RECORDING_OPTIONS,
        room_options=room_io.RoomOptions(
            text_input=True,
            text_output=True,
            audio_input=False,
            audio_output=False,
        ),
    )


if __name__ == "__main__":
    cli.run_app(server)
