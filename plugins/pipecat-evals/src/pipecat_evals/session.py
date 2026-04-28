"""Pipecat session runner for text-mode evals."""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .hooks import emit_run_result
from .run_result import (
    AgentHandoff,
    AgentHandoffEvent,
    ChatMessage,
    ChatMessageEvent,
    FunctionCall,
    FunctionCallEvent,
    FunctionCallOutput,
    FunctionCallOutputEvent,
    RunResult,
    first_present,
    jsonish_arguments,
)


DEFAULT_TIMEOUT_S = 30.0


class AgentSession:
    """Run text prompts through a Pipecat pipeline and collect eval events."""

    def __init__(self, *, timeout_s: float = DEFAULT_TIMEOUT_S) -> None:
        self.timeout_s = timeout_s
        self._capture = _FrameCapture()
        self._pipeline: Any = None
        self._task: Any = None
        self._runner: Any = None
        self._runner_task: Optional[asyncio.Task[Any]] = None
        self._started = False

    async def __aenter__(self) -> "AgentSession":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def start(
        self,
        pipeline_or_factory: Any,
        *,
        params: Any = None,
        observers: Optional[list[Any]] = None,
        task_kwargs: Optional[dict[str, Any]] = None,
        runner: Any = None,
    ) -> "AgentSession":
        PipelineTask, PipelineParams, PipelineRunner = _load_pipecat_pipeline_classes()

        pipeline = await _resolve_pipeline(pipeline_or_factory)
        task_kwargs = dict(task_kwargs or {})

        task_params = params
        if task_params is None:
            task_params = PipelineParams()
        elif isinstance(task_params, dict):
            task_params = PipelineParams(**task_params)

        observer_list = [_PipecatObserver(self._capture), *(observers or [])]
        if "observers" in task_kwargs and task_kwargs["observers"]:
            task_kwargs["observers"] = [*observer_list, *list(task_kwargs["observers"])]
        else:
            task_kwargs["observers"] = observer_list

        task = PipelineTask(pipeline, params=task_params, **task_kwargs)
        self._pipeline = pipeline
        self._task = task
        self._runner = runner or PipelineRunner()
        self._started = True

        self._runner_task = asyncio.create_task(self._runner.run(task))
        self._runner_task.add_done_callback(self._on_runner_done)
        await asyncio.sleep(0)
        return self

    async def run(
        self,
        *,
        user_input: str,
        timeout_s: Optional[float] = None,
    ) -> RunResult:
        if not self._started or self._task is None:
            raise RuntimeError("AgentSession.start(...) must be awaited before run(...)")

        result = RunResult(user_input=user_input)
        self._capture.begin_run(result)

        frame = _create_user_input_frame(user_input)
        await self._task.queue_frame(frame)
        completed = await result.wait(timeout_s=self.timeout_s if timeout_s is None else timeout_s)
        emit_run_result(completed)
        return completed

    async def close(self) -> None:
        if self._task is not None:
            cancel = getattr(self._task, "cancel", None)
            if callable(cancel):
                try:
                    value = cancel()
                    if inspect.isawaitable(value):
                        await value
                except Exception:
                    pass

        if self._runner_task is not None and not self._runner_task.done():
            self._runner_task.cancel()
            try:
                await self._runner_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        self._started = False
        self._task = None
        self._runner = None
        self._runner_task = None
        self._capture.end_run()

    def _on_runner_done(self, task: asyncio.Task[Any]) -> None:
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            self._capture.fail_active(exc)


@dataclass
class _TextBuffer:
    source: Optional[str] = None
    chunks: list[str] = field(default_factory=list)

    def append(self, source: str, text: str) -> None:
        if self.source is not None and self.source != source and self.chunks:
            self.chunks.clear()
        self.source = source
        self.chunks.append(text)

    def flush(self) -> Optional[str]:
        if not self.chunks:
            return None
        text = "".join(self.chunks)
        self.chunks.clear()
        self.source = None
        return text


class _FrameCapture:
    def __init__(self) -> None:
        self._active: Optional[RunResult] = None
        self._text = _TextBuffer()
        self._pending_calls = 0
        # Each Pipecat frame triggers the observer multiple times — once per
        # push event and once per process event on each processor it
        # traverses. Dedupe by frame.id so a single physical frame is
        # captured once. Pipecat assigns frame.id on construction.
        self._seen_frame_ids: set[Any] = set()
        # Pipecat broadcasts BOTH FunctionCallsStartedFrame (batch summary)
        # and FunctionCallInProgressFrame (one per call) for every tool
        # call, then a single FunctionCallResultFrame. Those are distinct
        # frames with different frame.ids, so frame-level dedup doesn't
        # collapse them — dedupe by tool_call_id too so _pending_calls
        # reaches zero and one event lands per call.
        self._seen_call_keys: set[Any] = set()

    def begin_run(self, result: RunResult) -> None:
        self._active = result
        self._text = _TextBuffer()
        self._pending_calls = 0
        self._seen_frame_ids = set()
        self._seen_call_keys = set()

    def end_run(self) -> None:
        if self._active is not None and not self._active.done:
            self._flush_message()
            self._active._mark_done()
        self._active = None

    def fail_active(self, exc: BaseException) -> None:
        if self._active is not None and not self._active.done:
            self._active._set_exception(exc)

    def capture_frame(self, frame: Any) -> None:
        if self._active is None or self._active.done:
            return

        frame_id = getattr(frame, "id", None)
        if frame_id is not None:
            if frame_id in self._seen_frame_ids:
                return
            self._seen_frame_ids.add(frame_id)
            # Pipecat's broadcast_frame builds TWO frame instances (downstream
            # and upstream) with different ids and links them via
            # broadcast_sibling_id. Pre-seed the sibling id so the second one
            # is skipped when it reaches the observer.
            sibling_id = getattr(frame, "broadcast_sibling_id", None)
            if sibling_id is not None:
                self._seen_frame_ids.add(sibling_id)

        frame_name = frame.__class__.__name__

        if frame_name == "ErrorFrame":
            error = first_present(frame, "error", "message", default="Pipecat pipeline error")
            self._active._set_exception(RuntimeError(str(error)))
            return

        if frame_name in {"LLMTextFrame", "TextFrame"}:
            text = _frame_text(frame)
            if text:
                self._text.append("llm", text)
            return

        if frame_name in {"TTSTextFrame", "AggregatedTextFrame"}:
            text = _frame_text(frame)
            if text:
                self._text.append("tts", text)
            return

        if frame_name in {"LLMMessagesFrame", "LLMMessagesAppendFrame"}:
            for message in _assistant_messages(frame):
                self._active.add_event(ChatMessageEvent(item=message))
            return

        if frame_name in {
            "FunctionCallsStartedFrame",
            "FunctionCallInProgressFrame",
            "FunctionCallFromLLM",
        }:
            self._flush_message()
            for call in _function_calls(frame):
                key = call.call_id if call.call_id is not None else id(call)
                if key in self._seen_call_keys:
                    continue
                self._seen_call_keys.add(key)
                self._pending_calls += 1
                self._active.add_event(FunctionCallEvent(item=call))
            return

        if frame_name == "FunctionCallResultFrame":
            output = _function_output(frame)
            self._active.add_event(FunctionCallOutputEvent(item=output))
            self._pending_calls = max(0, self._pending_calls - 1)
            return

        if "Handoff" in frame_name or "Transfer" in frame_name:
            self._flush_message()
            self._active.add_event(AgentHandoffEvent(item=_handoff(frame)))
            return

        if frame_name in {"LLMFullResponseEndFrame", "EndFrame", "StopFrame", "CancelFrame"}:
            self._flush_message()
            if frame_name != "LLMFullResponseEndFrame" or self._pending_calls == 0:
                self._active._mark_done()

    def _flush_message(self) -> None:
        if self._active is None:
            return
        text = self._text.flush()
        if text:
            self._active.add_event(ChatMessageEvent(
                item=ChatMessage(role="assistant", text_content=text)
            ))


class _PipecatObserver:
    def __init__(self, capture: _FrameCapture) -> None:
        self._capture = capture

    async def on_push_frame(self, *args: Any, **kwargs: Any) -> None:
        self._capture.capture_frame(_find_frame(args, kwargs))

    async def on_process_frame(self, *args: Any, **kwargs: Any) -> None:
        self._capture.capture_frame(_find_frame(args, kwargs))

    async def on_frame(self, *args: Any, **kwargs: Any) -> None:
        self._capture.capture_frame(_find_frame(args, kwargs))

    async def on_pipeline_started(self) -> None:
        return None

    async def cleanup(self) -> None:
        return None


def _find_frame(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
    if "frame" in kwargs:
        return kwargs["frame"]
    for candidate in reversed(args):
        if candidate is not None and candidate.__class__.__name__.endswith("Frame"):
            return candidate
        frame = getattr(candidate, "frame", None)
        if frame is not None and frame.__class__.__name__.endswith("Frame"):
            return frame
    return args[-1] if args else None


async def _resolve_pipeline(pipeline_or_factory: Any) -> Any:
    if callable(pipeline_or_factory) and not _looks_like_pipeline(pipeline_or_factory):
        value = pipeline_or_factory()
    else:
        value = pipeline_or_factory
    if inspect.isawaitable(value):
        value = await value
    return value


def _looks_like_pipeline(value: Any) -> bool:
    return any(hasattr(value, attr) for attr in ("processors", "_processors", "queue_frame"))


def _load_pipecat_pipeline_classes() -> tuple[Any, Any, Any]:
    try:
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineParams, PipelineTask
    except Exception as exc:
        raise ImportError(
            "AgentSession requires pipecat-ai. Install Pipecat in the test environment."
        ) from exc
    return PipelineTask, PipelineParams, PipelineRunner


def _create_user_input_frame(user_input: str) -> Any:
    try:
        from pipecat.frames.frames import LLMMessagesAppendFrame
    except Exception as exc:
        raise ImportError(
            "Could not import Pipecat LLMMessagesAppendFrame for text input."
        ) from exc
    return LLMMessagesAppendFrame(
        messages=[{"role": "user", "content": user_input}],
        run_llm=True,
    )


def _frame_text(frame: Any) -> str:
    value = first_present(frame, "text", "content", default="")
    return "" if value is None else str(value)


def _assistant_messages(frame: Any) -> list[ChatMessage]:
    messages = first_present(frame, "messages", "items", default=[]) or []
    out: list[ChatMessage] = []
    for msg in messages:
        role = first_present(msg, "role", default=None)
        if role != "assistant":
            continue
        content = first_present(msg, "content", "text", "text_content", default="")
        if isinstance(content, list):
            content = "".join(str(part) for part in content)
        out.append(ChatMessage(role="assistant", text_content=str(content)))
    return out


def _function_calls(frame: Any) -> list[FunctionCall]:
    calls = first_present(frame, "function_calls", "calls", "tool_calls", default=None)
    if calls is None:
        calls = [frame]
    out: list[FunctionCall] = []
    for call in calls:
        name = first_present(call, "function_name", "name", default=None)
        if not name:
            continue
        args = first_present(call, "arguments", "args", default={})
        out.append(FunctionCall(
            name=str(name),
            arguments=jsonish_arguments(args),
            call_id=first_present(call, "tool_call_id", "call_id", "id", default=None),
        ))
    return out


def _function_output(frame: Any) -> FunctionCallOutput:
    output = first_present(frame, "result", "output", "value", default=None)
    return FunctionCallOutput(
        output=output,
        call_id=first_present(frame, "tool_call_id", "call_id", "id", default=None),
        is_error=bool(first_present(frame, "is_error", "error", default=False)),
    )


def _handoff(frame: Any) -> AgentHandoff:
    return AgentHandoff(
        from_agent=_agent_name(first_present(frame, "from_agent", "old_agent", default=None)),
        to_agent=_agent_name(first_present(frame, "to_agent", "new_agent", default=None)),
    )


def _agent_name(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    name = first_present(value, "name", "id", default=None)
    if name:
        return str(name)
    cls = getattr(value, "__class__", None)
    return cls.__name__ if cls is not None else str(value)
