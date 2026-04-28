"""Run results and LiveKit-style assertions for Pipecat evals."""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

from .hooks import emit_judgment


@dataclass
class ChatMessage:
    role: str
    text_content: str
    interrupted: bool = False
    metrics: Optional[dict[str, Any]] = None

    @property
    def content(self) -> str:
        return self.text_content


@dataclass
class FunctionCall:
    name: str
    arguments: Any = field(default_factory=dict)
    call_id: Optional[str] = None


@dataclass
class FunctionCallOutput:
    output: Any
    call_id: Optional[str] = None
    is_error: bool = False


@dataclass
class AgentHandoff:
    from_agent: Optional[str] = None
    to_agent: Optional[str] = None


@dataclass
class ChatMessageEvent:
    item: ChatMessage
    type: str = "message"


@dataclass
class FunctionCallEvent:
    item: FunctionCall
    type: str = "function_call"


@dataclass
class FunctionCallOutputEvent:
    item: FunctionCallOutput
    type: str = "function_call_output"


@dataclass
class AgentHandoffEvent:
    item: AgentHandoff
    type: str = "agent_handoff"

    @property
    def from_agent(self) -> Optional[str]:
        return self.item.from_agent

    @property
    def to_agent(self) -> Optional[str]:
        return self.item.to_agent


@dataclass
class JudgeResult:
    success: bool
    reasoning: str = ""
    score: Optional[float] = None
    raw: Any = None

    @property
    def verdict(self) -> str:
        return "pass" if self.success else "fail"


class RunResult:
    """A single text-mode Pipecat agent run.

    The object is awaitable so lower-level session code can create it, attach
    events over time, and let callers wait for completion.
    """

    __pipecat_evals_run_result__ = True

    def __init__(self, *, user_input: Optional[str] = None) -> None:
        self._user_input = user_input
        self.user_input = user_input
        self.events: list[Any] = []
        self.expect = RunAssert(self)
        self._done: Optional[asyncio.Event] = None
        self._exception: Optional[BaseException] = None

    def add_event(self, event: Any) -> Any:
        self.events.append(event)
        return event

    @property
    def done(self) -> bool:
        return bool(self._done and self._done.is_set())

    async def wait(self, timeout_s: Optional[float] = None) -> "RunResult":
        done = self._ensure_done_event()
        try:
            await asyncio.wait_for(done.wait(), timeout=timeout_s)
        except asyncio.TimeoutError as exc:
            raise TimeoutError("Pipecat eval run timed out") from exc
        if self._exception is not None:
            raise self._exception
        return self

    def _mark_done(self) -> None:
        self._ensure_done_event().set()

    def _set_exception(self, exc: BaseException) -> None:
        self._exception = exc
        self._mark_done()

    def _ensure_done_event(self) -> asyncio.Event:
        if self._done is None:
            self._done = asyncio.Event()
        return self._done

    def __await__(self):
        return self.wait().__await__()


class RunAssert:
    def __init__(self, result: RunResult) -> None:
        self.result = result
        self._cursor = 0

    def __getitem__(self, key: int | slice) -> "EventAssert | EventRangeAssert":
        if isinstance(key, slice):
            return EventRangeAssert(self, key)
        if isinstance(key, int):
            index = key if key >= 0 else len(self.result.events) + key
            if not 0 <= index < len(self.result.events):
                raise AssertionError(
                    f"nth({key}) out of range (total events: {len(self.result.events)})"
                )
            return EventAssert(self.result.events[index])
        raise TypeError(
            f"{type(self).__name__} indices must be int or slice, not {type(key).__name__}"
        )

    def next_event(self, *, type: Optional[str] = None) -> "EventAssert":
        for index in range(self._cursor, len(self.result.events)):
            event = self.result.events[index]
            if type is None or _event_type(event) == type:
                self._cursor = index + 1
                assertion = EventAssert(event)
                if type == "message":
                    return assertion.is_message()
                if type == "function_call":
                    return assertion.is_function_call()
                if type == "function_call_output":
                    return assertion.is_function_call_output()
                if type == "agent_handoff":
                    return assertion.is_agent_handoff()
                return assertion
        suffix = f" of type {type!r}" if type else ""
        raise AssertionError(f"Expected next event{suffix}, but no matching event was found")

    def skip_next(self, count: int = 1) -> "RunAssert":
        available = len(self.result.events) - self._cursor
        if count > available:
            raise AssertionError(
                f"Tried to skip {count} event(s), but only {available} were available."
            )
        self._cursor += count
        return self

    def skip_next_event_if(
        self,
        predicate: Optional[Callable[[Any], bool]] = None,
        *,
        type: Optional[str] = None,
        role: Optional[str] = None,
        name: Optional[str] = None,
        arguments: Any = None,
        output: Any = None,
        is_error: Optional[bool] = None,
        from_agent: Optional[str] = None,
        to_agent: Optional[str] = None,
        new_agent_type: Any = None,
    ) -> Optional[
        "EventAssert | ChatMessageAssert | FunctionCallAssert | FunctionCallOutputAssert | AgentHandoffAssert"
    ]:
        if self._cursor >= len(self.result.events):
            return None

        event = self.result.events[self._cursor]
        if predicate is not None:
            if predicate(event):
                self._cursor += 1
                return EventAssert(event)
            return None

        if type is None:
            raise TypeError("type is required unless a predicate is provided")

        try:
            assertion = EventAssert(event)
            if type == "message":
                matched = assertion.is_message(role=role)
            elif type == "function_call":
                matched = assertion.is_function_call(name=name, arguments=arguments)
            elif type == "function_call_output":
                matched = assertion.is_function_call_output(
                    output=output,
                    is_error=is_error,
                )
            elif type == "agent_handoff":
                matched = assertion.is_agent_handoff(
                    from_agent=from_agent,
                    to_agent=to_agent,
                    new_agent_type=new_agent_type,
                )
            else:
                raise RuntimeError("unknown event type")
        except AssertionError:
            return None

        self._cursor += 1
        return matched

    def no_more_events(self) -> None:
        remaining = len(self.result.events) - self._cursor
        if remaining > 0:
            raise AssertionError(f"Expected no more events, but found {remaining}")

    def contains_event(self, *, type: Optional[str] = None) -> "EventAssert":
        for event in self.result.events:
            if type is None or _event_type(event) == type:
                return EventAssert(event)
        suffix = f" of type {type!r}" if type else ""
        raise AssertionError(f"Expected an event{suffix}, but none was found")

    def contains_message(
        self,
        *,
        role: Optional[str] = None,
        content: Optional[str] = None,
        content_contains: Optional[str] = None,
        pattern: Optional[str] = None,
    ) -> "ChatMessageAssert":
        return self[:].contains_message(
            role=role,
            content=content,
            content_contains=content_contains,
            pattern=pattern,
        )

    def contains_function_call(
        self,
        *,
        name: Optional[str] = None,
        arguments: Any = None,
    ) -> "FunctionCallAssert":
        return self[:].contains_function_call(name=name, arguments=arguments)

    def contains_function_call_output(
        self,
        *,
        output: Any = None,
        call_id: Optional[str] = None,
        is_error: Optional[bool] = None,
    ) -> "FunctionCallOutputAssert":
        return self[:].contains_function_call_output(
            output=output,
            call_id=call_id,
            is_error=is_error,
        )

    def contains_agent_handoff(
        self,
        *,
        from_agent: Optional[str] = None,
        to_agent: Optional[str] = None,
        new_agent_type: Any = None,
    ) -> "AgentHandoffAssert":
        return self[:].contains_agent_handoff(
            from_agent=from_agent,
            to_agent=to_agent,
            new_agent_type=new_agent_type,
        )


class EventAssert:
    def __init__(self, event: Any) -> None:
        self._event = event

    def event(self) -> Any:
        return self._event

    def has_type(self, type: str) -> "EventAssert":
        actual = _event_type(self._event)
        if actual != type:
            raise AssertionError(f"Expected event type {type!r}, got {actual!r}")
        return self

    def is_message(
        self,
        *,
        role: Optional[str] = None,
        content: Optional[str] = None,
        content_contains: Optional[str] = None,
        pattern: Optional[str] = None,
    ) -> "ChatMessageAssert":
        self.has_type("message")
        return ChatMessageAssert(self._event).matches(
            role=role,
            content=content,
            content_contains=content_contains,
            pattern=pattern,
        )

    def is_function_call(
        self,
        *,
        name: Optional[str] = None,
        arguments: Any = None,
    ) -> "FunctionCallAssert":
        self.has_type("function_call")
        return FunctionCallAssert(self._event).matches(name=name, arguments=arguments)

    def is_function_call_output(
        self,
        *,
        output: Any = None,
        call_id: Optional[str] = None,
        is_error: Optional[bool] = None,
    ) -> "FunctionCallOutputAssert":
        self.has_type("function_call_output")
        return FunctionCallOutputAssert(self._event).matches(
            output=output,
            call_id=call_id,
            is_error=is_error,
        )

    def is_agent_handoff(
        self,
        *,
        from_agent: Optional[str] = None,
        to_agent: Optional[str] = None,
        new_agent_type: Any = None,
    ) -> "AgentHandoffAssert":
        self.has_type("agent_handoff")
        return AgentHandoffAssert(self._event).matches(
            from_agent=from_agent,
            to_agent=to_agent,
            new_agent_type=new_agent_type,
        )


class ChatMessageAssert(EventAssert):
    def __init__(self, event: Any) -> None:
        super().__init__(event)
        self._last_judgment: Optional[JudgeResult] = None

    @property
    def message(self) -> ChatMessage:
        return _event_item(self._event)

    @property
    def judgment(self) -> Optional[JudgeResult]:
        return self._last_judgment

    def matches(
        self,
        *,
        role: Optional[str] = None,
        content: Optional[str] = None,
        content_contains: Optional[str] = None,
        pattern: Optional[str] = None,
    ) -> "ChatMessageAssert":
        msg = self.message
        if role is not None and msg.role != role:
            raise AssertionError(f"Expected message role {role!r}, got {msg.role!r}")
        if content is not None and msg.text_content != content:
            raise AssertionError(
                f"Expected message content {content!r}, got {msg.text_content!r}"
            )
        if content_contains is not None and content_contains not in msg.text_content:
            raise AssertionError(
                f"Expected message to contain {content_contains!r}, got {msg.text_content!r}"
            )
        if pattern is not None and re.search(pattern, msg.text_content) is None:
            raise AssertionError(
                f"Expected message to match /{pattern}/, got {msg.text_content!r}"
            )
        return self

    async def judge(self, judge: Any = None, *, intent: str) -> "ChatMessageAssert":
        if judge is None:
            raise TypeError("judge is required")
        result = _normalize_judge_result(
            await _maybe_await(_call_judge(judge, self.message, intent))
        )
        self._last_judgment = result
        emit_judgment(intent, result)
        if not result.success:
            reasoning = result.reasoning or intent
            raise AssertionError(f"Judgement failed: {reasoning}")
        return self


class FunctionCallAssert(EventAssert):
    @property
    def call(self) -> FunctionCall:
        return _event_item(self._event)

    def matches(
        self,
        *,
        name: Optional[str] = None,
        arguments: Any = None,
    ) -> "FunctionCallAssert":
        call = self.call
        if name is not None and call.name != name:
            raise AssertionError(f"Expected function name {name!r}, got {call.name!r}")
        if arguments is not None:
            actual = jsonish_arguments(call.arguments)
            if isinstance(arguments, dict) and isinstance(actual, dict):
                for key, value in arguments.items():
                    if key not in actual or actual[key] != value:
                        raise AssertionError(
                            f"For key {key!r}, expected {value!r}, got {actual.get(key)!r}"
                        )
            elif actual != arguments:
                raise AssertionError(
                    f"Expected function arguments {arguments!r}, got {call.arguments!r}"
                )
        return self


class FunctionCallOutputAssert(EventAssert):
    @property
    def output(self) -> FunctionCallOutput:
        return _event_item(self._event)

    def matches(
        self,
        *,
        output: Any = None,
        call_id: Optional[str] = None,
        is_error: Optional[bool] = None,
    ) -> "FunctionCallOutputAssert":
        item = self.output
        if output is not None and item.output != output:
            raise AssertionError(f"Expected output {output!r}, got {item.output!r}")
        if call_id is not None and item.call_id != call_id:
            raise AssertionError(f"Expected call_id {call_id!r}, got {item.call_id!r}")
        if is_error is not None and item.is_error is not is_error:
            raise AssertionError(
                f"Expected is_error {is_error!r}, got {item.is_error!r}"
            )
        return self


class AgentHandoffAssert(EventAssert):
    @property
    def handoff(self) -> AgentHandoff:
        return _event_item(self._event)

    def matches(
        self,
        *,
        from_agent: Optional[str] = None,
        to_agent: Optional[str] = None,
        new_agent_type: Any = None,
    ) -> "AgentHandoffAssert":
        handoff = self.handoff
        if from_agent is not None and handoff.from_agent != from_agent:
            raise AssertionError(
                f"Expected from_agent {from_agent!r}, got {handoff.from_agent!r}"
            )
        if to_agent is not None and handoff.to_agent != to_agent:
            raise AssertionError(f"Expected to_agent {to_agent!r}, got {handoff.to_agent!r}")
        if new_agent_type is not None and not isinstance(handoff.to_agent, new_agent_type):
            raise AssertionError(
                f"Expected new_agent {new_agent_type!r}, got {type(handoff.to_agent)!r}"
            )
        return self


class EventRangeAssert:
    def __init__(self, parent: RunAssert, rng: slice) -> None:
        self._parent = parent
        self._rng = rng
        self._events = parent.result.events[rng]

    def contains_event(self, *, type: Optional[str] = None) -> EventAssert:
        for event in self._events:
            if type is None or _event_type(event) == type:
                return EventAssert(event)
        suffix = f" of type {type!r}" if type else ""
        raise AssertionError(f"Expected an event{suffix}, but none was found in range")

    def contains_message(
        self,
        *,
        role: Optional[str] = None,
        content: Optional[str] = None,
        content_contains: Optional[str] = None,
        pattern: Optional[str] = None,
    ) -> ChatMessageAssert:
        for event in self._events:
            if _event_type(event) != "message":
                continue
            assertion = ChatMessageAssert(event)
            try:
                return assertion.matches(
                    role=role,
                    content=content,
                    content_contains=content_contains,
                    pattern=pattern,
                )
            except AssertionError:
                continue
        raise AssertionError("Expected a matching message event, but none was found in range")

    def contains_function_call(
        self,
        *,
        name: Optional[str] = None,
        arguments: Any = None,
    ) -> FunctionCallAssert:
        for event in self._events:
            if _event_type(event) != "function_call":
                continue
            assertion = FunctionCallAssert(event)
            try:
                return assertion.matches(name=name, arguments=arguments)
            except AssertionError:
                continue
        raise AssertionError(
            "Expected a matching function_call event, but none was found in range"
        )

    def contains_function_call_output(
        self,
        *,
        output: Any = None,
        call_id: Optional[str] = None,
        is_error: Optional[bool] = None,
    ) -> FunctionCallOutputAssert:
        for event in self._events:
            if _event_type(event) != "function_call_output":
                continue
            assertion = FunctionCallOutputAssert(event)
            try:
                return assertion.matches(
                    output=output,
                    call_id=call_id,
                    is_error=is_error,
                )
            except AssertionError:
                continue
        raise AssertionError(
            "Expected a matching function_call_output event, but none was found in range"
        )

    def contains_agent_handoff(
        self,
        *,
        from_agent: Optional[str] = None,
        to_agent: Optional[str] = None,
        new_agent_type: Any = None,
    ) -> AgentHandoffAssert:
        for event in self._events:
            if _event_type(event) != "agent_handoff":
                continue
            assertion = AgentHandoffAssert(event)
            try:
                return assertion.matches(
                    from_agent=from_agent,
                    to_agent=to_agent,
                    new_agent_type=new_agent_type,
                )
            except AssertionError:
                continue
        raise AssertionError(
            "Expected a matching agent_handoff event, but none was found in range"
        )


def _event_type(event: Any) -> Optional[str]:
    if isinstance(event, dict):
        return event.get("type")
    return getattr(event, "type", None)


def _event_item(event: Any) -> Any:
    if isinstance(event, dict):
        return event.get("item")
    return getattr(event, "item", None)


def _normalize_judge_result(value: Any) -> JudgeResult:
    if isinstance(value, JudgeResult):
        return value
    if isinstance(value, bool):
        return JudgeResult(success=value, raw=value)
    if isinstance(value, tuple) or isinstance(value, list):
        success = bool(value[0]) if value else False
        reasoning = str(value[1]) if len(value) > 1 else ""
        score = float(value[2]) if len(value) > 2 and value[2] is not None else None
        return JudgeResult(success=success, reasoning=reasoning, score=score, raw=value)
    if isinstance(value, dict):
        verdict = value.get("verdict")
        success_value = value.get("success", value.get("passed", value.get("pass")))
        if success_value is None and verdict is not None:
            success_value = str(verdict).lower() in {"pass", "passed", "true", "yes"}
        return JudgeResult(
            success=_as_bool(success_value),
            reasoning=str(value.get("reasoning") or value.get("message") or ""),
            score=value.get("score"),
            raw=value,
        )
    if hasattr(value, "success"):
        return JudgeResult(
            success=bool(getattr(value, "success")),
            reasoning=str(getattr(value, "reasoning", "") or ""),
            score=getattr(value, "score", None),
            raw=value,
        )
    if hasattr(value, "verdict"):
        verdict = str(getattr(value, "verdict")).lower()
        return JudgeResult(
            success=verdict in {"pass", "passed", "true", "yes"},
            reasoning=str(getattr(value, "reasoning", "") or ""),
            score=getattr(value, "score", None),
            raw=value,
        )
    return JudgeResult(success=bool(value), raw=value)


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "pass", "passed", "success"}
    return bool(value)


def _call_judge(judge: Any, message: ChatMessage, intent: str) -> Any:
    fn = judge
    for attr in ("judge", "evaluate", "check"):
        candidate = getattr(judge, attr, None)
        if callable(candidate):
            fn = candidate
            break
    if not callable(fn):
        raise TypeError("judge must be callable or expose judge/evaluate/check")

    attempts = (
        lambda: fn(message=message, intent=intent),
        lambda: fn(text=message.text_content, intent=intent),
        lambda: fn(message, intent=intent),
        lambda: fn(message.text_content, intent=intent),
        lambda: fn(message, intent),
        lambda: fn(message.text_content, intent),
        lambda: fn(message.text_content),
    )
    last_error: Optional[TypeError] = None
    for attempt in attempts:
        try:
            return attempt()
        except TypeError as exc:
            last_error = exc
            continue
    assert last_error is not None
    raise last_error


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def jsonish_arguments(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return value


def first_present(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(obj, dict):
            if name in obj:
                return obj[name]
        elif hasattr(obj, name):
            value = getattr(obj, name)
            if value is not None:
                return value
    return default


def first_in(iterable: Iterable[Any], *names: str, default: Any = None) -> Any:
    for obj in iterable:
        value = first_present(obj, *names, default=None)
        if value is not None:
            return value
    return default
