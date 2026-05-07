from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import dataclass

import pytest

from pipecat_evals import AgentSession


@dataclass
class LLMTextFrame:
    text: str


class LLMFullResponseEndFrame:
    pass


@pytest.fixture(autouse=True)
def fake_pipecat_modules(monkeypatch):
    """Install the minimal Pipecat surface AgentSession needs for this example."""

    frame_mod = types.ModuleType("pipecat.frames.frames")
    task_mod = types.ModuleType("pipecat.pipeline.task")
    runner_mod = types.ModuleType("pipecat.pipeline.runner")

    class LLMMessagesAppendFrame:
        def __init__(self, *, messages, run_llm):
            self.messages = messages
            self.run_llm = run_llm

    class PipelineParams:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class PipelineTask:
        def __init__(self, pipeline, *, params, observers):
            self.pipeline = pipeline
            self.params = params
            self.observers = observers

        async def queue_frame(self, frame):
            user_text = frame.messages[-1]["content"]
            response = self.pipeline.reply(user_text)
            for observer in self.observers:
                await observer.on_push_frame(self, frame=LLMTextFrame(response))
                await observer.on_push_frame(self, frame=LLMFullResponseEndFrame())

        async def cancel(self):
            return None

    class PipelineRunner:
        async def run(self, task):
            while True:
                await asyncio.sleep(0.01)

    frame_mod.LLMMessagesAppendFrame = LLMMessagesAppendFrame
    task_mod.PipelineParams = PipelineParams
    task_mod.PipelineTask = PipelineTask
    runner_mod.PipelineRunner = PipelineRunner

    modules = {
        "pipecat": types.ModuleType("pipecat"),
        "pipecat.frames": types.ModuleType("pipecat.frames"),
        "pipecat.frames.frames": frame_mod,
        "pipecat.pipeline": types.ModuleType("pipecat.pipeline"),
        "pipecat.pipeline.task": task_mod,
        "pipecat.pipeline.runner": runner_mod,
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)


class BankingPipeline:
    def reply(self, user_text: str) -> str:
        if "balance" in user_text.lower():
            return "Your checking account balance is $42.00."
        return "I can help with balances, transfers, and card questions."


def build_pipeline():
    return BankingPipeline()


@pytest.mark.asyncio
async def test_mock_pipecat_agent_balance():
    async with AgentSession(timeout_s=1.0) as session:
        await session.start(build_pipeline)
        result = await session.run(user_input="What is my balance?")

    result.expect.next_event().is_message(
        role="assistant",
        content_contains="$42.00",
    )
    result.expect.no_more_events()
