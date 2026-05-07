from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from pipecat_evals import RunResult
from pipecat_evals.hooks import register_run_result_hook
from pipecat_evals.session import AgentSession, _FrameCapture


@dataclass
class LLMTextFrame:
    text: str


class LLMFullResponseEndFrame:
    pass


@dataclass
class TTSTextFrame:
    text: str


@dataclass
class LLMMessagesFrame:
    messages: list


class EndFrame:
    pass


class StopFrame:
    pass


@dataclass
class ErrorFrame:
    error: str


@dataclass
class FunctionCallsStartedFrame:
    function_calls: list


@dataclass
class FunctionCallInProgressFrame:
    function_name: str
    arguments: str
    tool_call_id: str


@dataclass
class FunctionCallResultFrame:
    result: object
    tool_call_id: str


@dataclass
class TTFBMetricsData:
    processor: str
    value: float
    model: str | None = None


@dataclass
class LLMTokenUsage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cache_read_input_tokens: int | None = None


@dataclass
class LLMUsageMetricsData:
    processor: str
    value: LLMTokenUsage
    model: str | None = None


@dataclass
class TTSUsageMetricsData:
    processor: str
    value: int
    model: str | None = None


@dataclass
class MetricsFrame:
    data: list


@dataclass
class AgentHandoffFrame:
    from_agent: str
    to_agent: str


@dataclass
class FramePushed:
    frame: object


@dataclass
class TransferFrame:
    old_agent: object
    new_agent: object


@pytest.mark.asyncio
async def test_frame_capture_records_messages_calls_outputs_and_handoffs():
    result = RunResult(user_input="hello")
    capture = _FrameCapture()
    capture.begin_run(result)

    capture.capture_frame(LLMTextFrame("Hi "))
    capture.capture_frame(LLMTextFrame("there"))
    capture.capture_frame(LLMFullResponseEndFrame())

    result.expect.next_event().is_message(content="Hi there")
    assert result.done

    result = RunResult(user_input="order")
    capture.begin_run(result)
    capture.capture_frame(FunctionCallInProgressFrame(
        function_name="lookup_order",
        arguments='{"id":"123"}',
        tool_call_id="call-1",
    ))
    capture.capture_frame(FunctionCallResultFrame(
        result={"status": "shipped"},
        tool_call_id="call-1",
    ))
    capture.capture_frame(AgentHandoffFrame(from_agent="triage", to_agent="support"))
    capture.end_run()

    result.expect.next_event().is_function_call(
        name="lookup_order",
        arguments={"id": "123"},
    )
    result.expect.next_event().is_function_call_output(call_id="call-1")
    result.expect.next_event().is_agent_handoff(from_agent="triage", to_agent="support")
    result.expect.no_more_events()


@pytest.mark.asyncio
async def test_frame_capture_records_variant_frames_and_errors():
    capture = _FrameCapture()

    result = RunResult(user_input="tts")
    capture.begin_run(result)
    capture.capture_frame(TTSTextFrame("spoken"))
    capture.capture_frame(LLMFullResponseEndFrame())
    result.expect.next_event().is_message(content="spoken")
    assert result.done

    result = RunResult(user_input="messages")
    capture.begin_run(result)
    capture.capture_frame(LLMMessagesFrame(messages=[
        {"role": "user", "content": "ignored"},
        {"role": "assistant", "content": ["hi", "!"]},
    ]))
    capture.end_run()
    result.expect.next_event().is_message(content="hi!")
    result.expect.no_more_events()

    result = RunResult(user_input="functions")
    capture.begin_run(result)
    capture.capture_frame(FunctionCallsStartedFrame(function_calls=[
        SimpleNamespace(name="lookup", args='{"id":"123"}', id="call-1"),
        SimpleNamespace(function_name="search", arguments={"q": "x"}, tool_call_id="call-2"),
    ]))
    capture.capture_frame(FunctionCallResultFrame(result="ok", tool_call_id="call-1"))
    capture.capture_frame(FunctionCallResultFrame(result="done", tool_call_id="call-2"))
    capture.capture_frame(EndFrame())
    result.expect.next_event().is_function_call(name="lookup", arguments={"id": "123"})
    result.expect.next_event().is_function_call(name="search", arguments={"q": "x"})
    result.expect.next_event().is_function_call_output(call_id="call-1")
    result.expect.next_event().is_function_call_output(call_id="call-2")
    assert result.done

    result = RunResult(user_input="handoff")
    capture.begin_run(result)
    capture.capture_frame(TransferFrame(
        old_agent=SimpleNamespace(name="triage"),
        new_agent=SimpleNamespace(id="support"),
    ))
    capture.capture_frame(StopFrame())
    result.expect.next_event().is_agent_handoff(from_agent="triage", to_agent="support")

    result = RunResult(user_input="error")
    capture.begin_run(result)
    capture.capture_frame(ErrorFrame(error="bad frame"))
    with pytest.raises(RuntimeError, match="bad frame"):
        await result.wait(timeout_s=0.001)


@pytest.mark.asyncio
async def test_frame_capture_attaches_metrics_to_message_events():
    result = RunResult(user_input="hello")
    capture = _FrameCapture()
    capture.begin_run(result)

    capture.capture_frame(MetricsFrame(data=[
        TTFBMetricsData(
            processor="OpenAILLMService",
            model="gpt-4.1-mini",
            value=0.42,
        ),
        LLMUsageMetricsData(
            processor="OpenAILLMService",
            model="gpt-4.1-mini",
            value=LLMTokenUsage(
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
                cache_read_input_tokens=3,
            ),
        ),
        TTSUsageMetricsData(
            processor="ElevenLabsTTSService",
            model="eleven_flash_v2_5",
            value=12,
        ),
    ]))
    capture.capture_frame(LLMTextFrame("Hi there"))
    capture.capture_frame(LLMFullResponseEndFrame())

    message = result.expect.next_event().is_message(content="Hi there").message
    assert message.metrics == {
        "llm_node_ttft": 0.42,
        "llm_metadata": {
            "model_name": "gpt-4.1-mini",
            "model_provider": "OpenAILLMService",
        },
        "llm_prompt_tokens": 10,
        "llm_completion_tokens": 5,
        "llm_total_tokens": 15,
        "llm_cache_read_tokens": 3,
        "tts_characters": 12,
        "tts_metadata": {
            "model_name": "eleven_flash_v2_5",
            "model_provider": "ElevenLabsTTSService",
        },
    }


@pytest.mark.asyncio
async def test_frame_capture_attaches_late_metrics_to_latest_message_event():
    result = RunResult(user_input="hello")
    capture = _FrameCapture()
    capture.begin_run(result)

    capture.capture_frame(LLMMessagesFrame(messages=[
        {"role": "assistant", "content": "hi"},
    ]))
    capture.capture_frame(MetricsFrame(data=[
        TTFBMetricsData(processor="OpenAILLMService", value=0.21),
    ]))
    capture.end_run()

    message = result.expect.next_event().is_message(content="hi").message
    assert message.metrics == {"llm_node_ttft": 0.21}


@pytest.mark.asyncio
async def test_frame_capture_dedupes_same_frame_observed_multiple_times():
    """Pipecat fires push and process observer events on every processor a
    frame traverses, so the same frame can reach the capture 6-8 times. Each
    physical frame (identified by frame.id) must be recorded once."""

    result = RunResult(user_input="order")
    capture = _FrameCapture()
    capture.begin_run(result)

    in_progress = FunctionCallInProgressFrame(
        function_name="lookup_order",
        arguments={"id": "1"},
        tool_call_id="call-1",
    )
    in_progress.id = 41
    capture.capture_frame(in_progress)

    result_frame = FunctionCallResultFrame(result="ok", tool_call_id="call-1")
    result_frame.id = 42
    for _ in range(8):
        capture.capture_frame(result_frame)

    chunk_a = LLMTextFrame(text="hello ")
    chunk_a.id = 43
    chunk_b = LLMTextFrame(text="there")
    chunk_b.id = 44
    for frame in (chunk_a, chunk_a, chunk_b, chunk_b, chunk_b):
        capture.capture_frame(frame)

    capture.capture_frame(LLMFullResponseEndFrame())

    result.expect.next_event().is_function_call(name="lookup_order")
    result.expect.next_event().is_function_call_output(call_id="call-1")
    result.expect.next_event().is_message(content="hello there")
    result.expect.no_more_events()
    assert result.done


@pytest.mark.asyncio
async def test_frame_capture_dedupes_broadcast_sibling_frames():
    """Pipecat's broadcast_frame builds two distinct frame instances (one
    pushed downstream, one upstream) with different ids but linked via
    broadcast_sibling_id. Both reach the observer; only one event must land."""

    result = RunResult(user_input="order")
    capture = _FrameCapture()
    capture.begin_run(result)

    in_progress = FunctionCallInProgressFrame(
        function_name="lookup_order",
        arguments={"id": "1"},
        tool_call_id="call-1",
    )
    in_progress.id = 100
    capture.capture_frame(in_progress)

    downstream_result = FunctionCallResultFrame(
        result="ok",
        tool_call_id="call-1",
    )
    downstream_result.id = 101
    upstream_result = FunctionCallResultFrame(
        result="ok",
        tool_call_id="call-1",
    )
    upstream_result.id = 102
    downstream_result.broadcast_sibling_id = upstream_result.id
    upstream_result.broadcast_sibling_id = downstream_result.id

    capture.capture_frame(downstream_result)
    capture.capture_frame(upstream_result)

    capture.capture_frame(LLMFullResponseEndFrame())

    result.expect.next_event().is_function_call(name="lookup_order")
    result.expect.next_event().is_function_call_output(call_id="call-1")
    result.expect.no_more_events()
    assert result.done


@pytest.mark.asyncio
async def test_frame_capture_dedupes_started_and_in_progress_for_same_call_id():
    """Real Pipecat broadcasts FunctionCallsStartedFrame (batch summary) and a
    FunctionCallInProgressFrame for each call. The capture must count every
    tool_call_id exactly once or _pending_calls will never reach zero."""

    result = RunResult(user_input="order")
    capture = _FrameCapture()
    capture.begin_run(result)

    capture.capture_frame(FunctionCallsStartedFrame(function_calls=[
        SimpleNamespace(
            function_name="lookup_order",
            arguments={"id": "123"},
            tool_call_id="call-1",
        ),
    ]))
    capture.capture_frame(FunctionCallInProgressFrame(
        function_name="lookup_order",
        arguments={"id": "123"},
        tool_call_id="call-1",
    ))
    capture.capture_frame(FunctionCallResultFrame(
        result={"status": "shipped"},
        tool_call_id="call-1",
    ))
    capture.capture_frame(LLMFullResponseEndFrame())

    result.expect.next_event().is_function_call(
        name="lookup_order",
        arguments={"id": "123"},
    )
    result.expect.next_event().is_function_call_output(call_id="call-1")
    result.expect.no_more_events()
    assert result.done


@pytest.mark.asyncio
async def test_pipecat_observer_accepts_real_observer_event_objects():
    result = RunResult(user_input="observer")
    session = AgentSession()
    session._capture.begin_run(result)
    observer = session._capture

    from pipecat_evals.session import _PipecatObserver

    pipecat_observer = _PipecatObserver(observer)
    await pipecat_observer.on_pipeline_started()
    await pipecat_observer.on_push_frame(FramePushed(frame=LLMTextFrame("pong")))
    await pipecat_observer.on_process_frame(FramePushed(frame=LLMFullResponseEndFrame()))
    await pipecat_observer.cleanup()

    completed = await result.wait(timeout_s=0.001)
    completed.expect.next_event().is_message(content="pong")


@pytest.mark.asyncio
async def test_agent_session_queues_text_and_captures_pipeline_frames(monkeypatch):
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
            self.queued = []

        async def queue_frame(self, frame):
            self.queued.append(frame)
            for observer in self.observers:
                await observer.on_push_frame(self, frame=LLMTextFrame("pong"))
                await observer.on_push_frame(self, frame=LLMFullResponseEndFrame())

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

    class ExtraObserver:
        def __init__(self):
            self.frames = []

        async def on_push_frame(self, *_args, frame):
            self.frames.append(frame)

    async def build_pipeline():
        return "pipeline"

    observed_results = []
    unregister = register_run_result_hook(lambda result: observed_results.append(result))
    try:
        extra_observer = ExtraObserver()
        session = AgentSession()
        await session.start(
            build_pipeline,
            params={"allow_interruptions": False},
            observers=[extra_observer],
        )
        result = await session.run(user_input="ping", timeout_s=0.2)
        task = session._task
        await session.close()
    finally:
        unregister()

    assert task.pipeline == "pipeline"
    assert task.params.kwargs == {"allow_interruptions": False}
    assert task.queued[0].messages == [{"role": "user", "content": "ping"}]
    assert task.queued[0].run_llm is True
    assert any(isinstance(frame, LLMTextFrame) for frame in extra_observer.frames)
    assert result.user_input == "ping"
    result.expect.next_event().is_message(content="pong")
    assert observed_results == [result]


@pytest.mark.asyncio
async def test_agent_session_requires_start_and_pipecat_imports(monkeypatch):
    session = AgentSession()
    with pytest.raises(RuntimeError, match="start"):
        await session.run(user_input="ping", timeout_s=0.001)

    monkeypatch.setitem(sys.modules, "pipecat.pipeline.task", None)
    with pytest.raises(ImportError, match="pipecat-ai"):
        await session.start("pipeline")
