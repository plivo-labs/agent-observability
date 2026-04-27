"""Per-test and per-run state held by the plugin.

The plugin installs itself as a pytest hook, but data flows through a small
module-level collector because pytest's hook interface is procedural and
test code needs a way to hand us the `RunResult` without importing plugin
internals.

Tests call `capture(run_result)` after `session.run(...)`. Values are stashed
in a ContextVar keyed to the currently-running test, keyed set by the plugin
during `pytest_runtest_protocol`.
"""

from __future__ import annotations

import contextvars
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional


# ── Per-test contextvar ─────────────────────────────────────────────────────

_current_test: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar(
    "agent_observability_current_test", default=None,
)


def _set_current_test(test_id: Optional[str]) -> contextvars.Token:
    return _current_test.set(test_id)


def _reset_current_test(token: contextvars.Token) -> None:
    try:
        _current_test.reset(token)
    except (ValueError, LookupError):
        pass


# ── Per-test state ──────────────────────────────────────────────────────────


@dataclass
class CaseState:
    run_results: list[Any] = field(default_factory=list)
    judgments: list[dict] = field(default_factory=list)
    _seen_ids: set[int] = field(default_factory=set)


# test_id -> CaseState
_states: dict[str, CaseState] = {}


def _state_for(test_id: str) -> CaseState:
    st = _states.get(test_id)
    if st is None:
        st = CaseState()
        _states[test_id] = st
    return st


def pop_state(test_id: str) -> Optional[CaseState]:
    return _states.pop(test_id, None)


def clear_all_state() -> None:
    _states.clear()


# ── Public API used by test code ────────────────────────────────────────────


def capture(run_result: Any) -> Any:
    """Attach a LiveKit RunResult to the currently-running test.

    Usually you don't need to call this — the plugin auto-captures every
    RunResult returned from `AgentSession.run(...)`. Call it manually when
    you have a RunResult from a source we don't intercept.

    Returns the run_result unchanged, so you can write one-liners:

        result = capture(await session.run(user_input="hi"))

    Calls are idempotent: capturing the same RunResult twice is a no-op.
    """
    test_id = _current_test.get()
    if test_id is None:
        return run_result
    state = _state_for(test_id)
    rid = id(run_result)
    if rid in state._seen_ids:
        return run_result
    state._seen_ids.add(rid)
    state.run_results.append(run_result)
    return run_result


# ── Internal: judgment recording (called by the judge wrapper) ──────────────


def _record_judgment(*, intent: str, verdict: str, reasoning: str) -> None:
    test_id = _current_test.get()
    if test_id is None:
        return
    _state_for(test_id).judgments.append({
        "intent": intent,
        "verdict": verdict,
        "reasoning": reasoning,
    })


# ── Run-level collector ─────────────────────────────────────────────────────


@dataclass
class CaseRecord:
    case_id: str
    name: str
    file: Optional[str]
    status: str  # 'passed' | 'failed' | 'errored' | 'skipped'
    duration_ms: Optional[int]
    user_input: Optional[str]
    events: list[dict]
    judgments: list[dict]
    failure: Optional[dict]


@dataclass
class RunCollector:
    run_id: str
    started_at: float  # unix seconds
    finished_at: Optional[float] = None
    ci: Optional[dict] = None
    cases: list[CaseRecord] = field(default_factory=list)

    @classmethod
    def new(cls, *, started_at: float, ci: Optional[dict] = None) -> "RunCollector":
        return cls(run_id=str(uuid.uuid4()), started_at=started_at, ci=ci)

    def add_case(self, case: CaseRecord) -> None:
        self.cases.append(case)
