"""pytest hook implementations + LiveKit `.judge()` interception."""

from __future__ import annotations

import functools
import logging
import os
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Optional

import pytest

from . import collector as col
from . import events as evt
from . import payload as pl
from . import uploader as up
from .ci import detect_ci


logger = logging.getLogger("pytest_agent_observability")


# Module-level state set up in pytest_configure, cleared in pytest_unconfigure.
class _State:
    enabled: bool = False
    collector: Optional[col.RunCollector] = None
    upload_config: Optional[up.UploadConfig] = None
    agent_id: Optional[str] = None
    account_id: Optional[str] = None
    fallback_dir: Optional[Path] = None
    _judge_restorer: Optional[Any] = None
    _autocapture_restorer: Optional[Any] = None
    _test_tokens: dict = {}


_state = _State()


# ── Pytest command-line options ─────────────────────────────────────────────


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("agent-observability")
    group.addoption(
        "--agent-observability-url",
        dest="agent_observability_url",
        default=None,
        help="Base URL of the agent-observability server. Overrides AGENT_OBSERVABILITY_URL.",
    )
    group.addoption(
        "--agent-observability-agent-id",
        dest="agent_observability_agent_id",
        default=None,
        help="Agent identifier for this test run. Overrides AGENT_OBSERVABILITY_AGENT_ID.",
    )
    group.addoption(
        "--agent-observability-account-id",
        dest="agent_observability_account_id",
        default=None,
        help="Account identifier for this test run. Overrides AGENT_OBSERVABILITY_ACCOUNT_ID.",
    )


# ── Configure / unconfigure (lifecycle) ─────────────────────────────────────


def pytest_configure(config: pytest.Config) -> None:
    url = config.getoption("agent_observability_url") or os.getenv("AGENT_OBSERVABILITY_URL")
    if not url:
        return  # No-op when not configured.

    user = os.getenv("AGENT_OBSERVABILITY_USER")
    pw = os.getenv("AGENT_OBSERVABILITY_PASS")
    auth = (user, pw) if user and pw else None

    _state.enabled = True
    _state.upload_config = up.UploadConfig(url=url, basic_auth=auth)
    _state.agent_id = (
        config.getoption("agent_observability_agent_id")
        or os.getenv("AGENT_OBSERVABILITY_AGENT_ID")
    )
    _state.account_id = (
        config.getoption("agent_observability_account_id")
        or os.getenv("AGENT_OBSERVABILITY_ACCOUNT_ID")
    )

    cache_dir = getattr(config, "cache", None)
    if cache_dir is not None:
        try:
            _state.fallback_dir = Path(cache_dir.mkdir("agent-observability"))
        except Exception:
            _state.fallback_dir = Path(".pytest_cache") / "agent-observability"
    else:
        _state.fallback_dir = Path(".pytest_cache") / "agent-observability"

    _install_judge_wrapper()
    _install_autocapture_wrapper()


def pytest_unconfigure(config: pytest.Config) -> None:
    for attr in ("_judge_restorer", "_autocapture_restorer"):
        restorer = getattr(_state, attr, None)
        if restorer is not None:
            try:
                restorer()
            except Exception:
                pass
            setattr(_state, attr, None)
    _state.enabled = False
    col.clear_all_state()
    _state._test_tokens.clear()


# ── Session hooks ───────────────────────────────────────────────────────────


def pytest_sessionstart(session: pytest.Session) -> None:
    if not _state.enabled:
        return
    _state.collector = col.RunCollector.new(started_at=time.time(), ci=detect_ci())


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    if not _state.enabled or _state.collector is None:
        return

    payload = pl.build_payload(
        collector=_state.collector,
        agent_id=_state.agent_id,
        account_id=_state.account_id,
        finished_at=time.time(),
    )

    assert _state.upload_config is not None
    up.upload(payload, _state.upload_config, fallback_dir=_state.fallback_dir)


# ── Per-test hooks ──────────────────────────────────────────────────────────


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item: pytest.Item, nextitem: Optional[pytest.Item]):
    if not _state.enabled:
        yield
        return

    test_id = item.nodeid
    token = col._set_current_test(test_id)
    _state._test_tokens[test_id] = token
    try:
        yield
    finally:
        col._reset_current_test(token)
        _state._test_tokens.pop(test_id, None)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo):
    outcome = yield
    if not _state.enabled or _state.collector is None:
        return

    report: pytest.TestReport = outcome.get_result()
    if report.when != "call" and not (report.when == "setup" and report.outcome != "passed"):
        # We only build one case record per test, triggered on 'call'. If setup
        # fails we also emit one — otherwise we'd miss errors.
        return

    state = col.pop_state(item.nodeid)
    run_results = state.run_results if state else []
    judgments = state.judgments if state else []

    # Merge events across possibly-multiple RunResult objects (multi-turn tests).
    events: list[dict] = []
    user_inputs: list[str] = []
    for rr in run_results:
        ui = getattr(rr, "_user_input", None) or getattr(rr, "user_input", None)
        if ui:
            user_inputs.append(ui)
        try:
            ev_list = list(getattr(rr, "events", []) or [])
        except Exception:
            ev_list = []
        events.extend(evt.serialize_events(ev_list))

    case_status, failure = _derive_status(report, call, judgments)

    record = col.CaseRecord(
        case_id=str(uuid.uuid4()),
        name=item.name,
        file=_nodeid_file(item),
        status=case_status,
        duration_ms=int(report.duration * 1000) if report.duration else None,
        user_input="\n".join(user_inputs) if user_inputs else None,
        events=events,
        judgments=judgments,
        failure=failure,
    )
    _state.collector.add_case(record)


def _nodeid_file(item: pytest.Item) -> Optional[str]:
    # Strip the "::test_name" portion.
    nodeid = item.nodeid
    return nodeid.split("::", 1)[0] if "::" in nodeid else nodeid


def _derive_status(
    report: pytest.TestReport,
    call: pytest.CallInfo,
    judgments: list[dict],
) -> tuple[str, Optional[dict]]:
    if report.outcome == "skipped":
        return "skipped", None

    if report.outcome == "passed":
        return "passed", None

    # Failed or errored.
    excinfo = call.excinfo
    if excinfo is None:
        return "failed", {"kind": "error", "message": str(report.longrepr) if report.longrepr else ""}

    failure_kind = "assertion" if excinfo.errisinstance(AssertionError) else "error"

    # If the failure looks like it came from a judge, bump to judge_failed.
    # (Also happens to be an AssertionError; we distinguish by the message prefix
    # LiveKit uses: "Judgement failed: ...")
    message = str(excinfo.value) if excinfo.value else ""
    if "Judgement failed" in message or any(j["verdict"] == "fail" for j in judgments):
        failure_kind = "judge_failed"

    return "failed", {
        "kind": failure_kind,
        "message": message,
        "stack": _format_traceback(excinfo),
    }


def _format_traceback(excinfo: pytest.ExceptionInfo) -> str:
    try:
        return "".join(traceback.format_exception(
            excinfo.type, excinfo.value, excinfo.tb,
        ))
    except Exception:
        return ""


# ── Judge interception (LiveKit-specific, optional) ─────────────────────────


def _install_judge_wrapper() -> None:
    """Monkey-patch ChatMessageAssert.judge so we can record intent + verdict.

    Safe if livekit-agents isn't installed — the wrapper simply isn't installed.
    """
    try:
        from livekit.agents.voice.run_result import ChatMessageAssert  # type: ignore
    except Exception:
        return

    original = ChatMessageAssert.judge

    @functools.wraps(original)
    async def wrapped(self, llm_v, *, intent: str):
        try:
            result = await original(self, llm_v, intent=intent)
            col._record_judgment(intent=intent, verdict="pass", reasoning="")
            return result
        except AssertionError as e:
            message = str(e)
            prefix = "Judgement failed:"
            reasoning = message.split(prefix, 1)[-1].strip() if prefix in message else message
            col._record_judgment(intent=intent, verdict="fail", reasoning=reasoning)
            raise

    ChatMessageAssert.judge = wrapped  # type: ignore[method-assign]

    def _restore() -> None:
        ChatMessageAssert.judge = original  # type: ignore[method-assign]

    _state._judge_restorer = _restore


def _install_autocapture_wrapper() -> None:
    """Monkey-patch AgentSession.run so every RunResult is auto-captured.

    Users no longer have to call `capture(result)` manually. The original
    `capture()` helper remains available for RunResults produced outside
    `.run()` (e.g. `AgentSession.start(capture_run=True)`).

    Safe if livekit-agents isn't installed — just no-ops.
    """
    try:
        from livekit.agents.voice.agent_session import AgentSession  # type: ignore
    except Exception:
        return

    original = AgentSession.run

    @functools.wraps(original)
    def wrapped(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        try:
            col.capture(result)
        except Exception:
            pass
        return result

    AgentSession.run = wrapped  # type: ignore[method-assign]

    def _restore() -> None:
        AgentSession.run = original  # type: ignore[method-assign]

    _state._autocapture_restorer = _restore
