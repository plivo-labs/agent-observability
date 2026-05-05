"""pytest hook implementations + LiveKit `.judge()` interception."""

from __future__ import annotations

import functools
import logging
import os
import queue
import threading
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
    run_name: Optional[str] = None
    fallback_dir: Optional[Path] = None
    _judge_restorer: Optional[Any] = None
    _autocapture_restorer: Optional[Any] = None
    _test_tokens: dict = {}
    # Populated by pytest_sessionfinish so pytest_terminal_summary can print the
    # run_id (and clickable dashboard URL) alongside the normal pytest summary.
    _last_run_id: Optional[str] = None
    _last_upload_ok: bool = False
    # Live streaming
    live_streaming: bool = True
    heartbeat_interval: float = 10.0
    _flusher_thread: Optional[threading.Thread] = None
    _stop_event: Optional[threading.Event] = None


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
    group.addoption(
        "--agent-observability-run-name",
        dest="agent_observability_run_name",
        default=None,
        help=(
            "Optional freeform label for this run (e.g. 'v9.1-with-new-prompt'). "
            "Overrides AGENT_OBSERVABILITY_RUN_NAME."
        ),
    )
    group.addoption(
        "--agent-observability-timeout",
        dest="agent_observability_timeout",
        default=None,
        type=float,
        help=(
            "Upload request timeout in seconds. Default 10. "
            "Overrides AGENT_OBSERVABILITY_TIMEOUT."
        ),
    )
    group.addoption(
        "--agent-observability-max-retries",
        dest="agent_observability_max_retries",
        default=None,
        type=int,
        help=(
            "Max upload attempts before writing the payload to the fallback "
            "cache. Default 3. Overrides AGENT_OBSERVABILITY_MAX_RETRIES."
        ),
    )
    group.addoption(
        "--agent-observability-fallback-dir",
        dest="agent_observability_fallback_dir",
        default=None,
        help=(
            "Directory to write failed-upload payloads to. Defaults to the "
            "pytest cache (.pytest_cache/agent-observability). "
            "Overrides AGENT_OBSERVABILITY_FALLBACK_DIR."
        ),
    )
    group.addoption(
        "--agent-observability-live-streaming",
        dest="agent_observability_live_streaming",
        default=None,
        help=(
            "Enable live case streaming (true/false). Default true. "
            "Overrides AGENT_OBSERVABILITY_LIVE_STREAMING."
        ),
    )
    group.addoption(
        "--agent-observability-heartbeat-interval",
        dest="agent_observability_heartbeat_interval",
        default=None,
        type=float,
        help=(
            "Heartbeat POST interval in seconds. Default 10. "
            "Overrides AGENT_OBSERVABILITY_HEARTBEAT_INTERVAL."
        ),
    )


# ── Configure / unconfigure (lifecycle) ─────────────────────────────────────


def pytest_configure(config: pytest.Config) -> None:
    url = config.getoption("agent_observability_url") or os.getenv("AGENT_OBSERVABILITY_URL")
    if not url:
        return  # No-op when no server is configured.

    # Under pytest-xdist each worker is a separate process and would otherwise
    # mint its own run_id, fragmenting one logical pytest invocation across N
    # run rows. The master generates the id once; workers inherit it via env
    # (xdist forwards env to workers, and our collector reads the same var).
    if not hasattr(config, "workerinput"):  # master / non-xdist
        os.environ.setdefault("AGENT_OBSERVABILITY_RUN_ID", str(uuid.uuid4()))

    user = os.getenv("AGENT_OBSERVABILITY_USER")
    pw = os.getenv("AGENT_OBSERVABILITY_PASS")
    auth = (user, pw) if user and pw else None

    timeout_s = (
        config.getoption("agent_observability_timeout")
        or up._env_float("AGENT_OBSERVABILITY_TIMEOUT", 10.0)
    )
    max_retries = (
        config.getoption("agent_observability_max_retries")
        or up._env_int("AGENT_OBSERVABILITY_MAX_RETRIES", 3)
    )

    _state.enabled = True
    _state.upload_config = up.UploadConfig(
        url=url,
        basic_auth=auth,
        timeout_s=float(timeout_s),
        max_retries=int(max_retries),
    )
    _state.agent_id = (
        config.getoption("agent_observability_agent_id")
        or os.getenv("AGENT_OBSERVABILITY_AGENT_ID")
    )
    _state.account_id = (
        config.getoption("agent_observability_account_id")
        or os.getenv("AGENT_OBSERVABILITY_ACCOUNT_ID")
    )
    _state.run_name = (
        config.getoption("agent_observability_run_name")
        or os.getenv("AGENT_OBSERVABILITY_RUN_NAME")
    )

    override_dir = (
        config.getoption("agent_observability_fallback_dir")
        or os.getenv("AGENT_OBSERVABILITY_FALLBACK_DIR")
    )
    if override_dir:
        _state.fallback_dir = Path(override_dir)
    else:
        cache_dir = getattr(config, "cache", None)
        if cache_dir is not None:
            try:
                _state.fallback_dir = Path(cache_dir.mkdir("agent-observability"))
            except Exception:
                _state.fallback_dir = Path(".pytest_cache") / "agent-observability"
        else:
            _state.fallback_dir = Path(".pytest_cache") / "agent-observability"

    # Live streaming config
    live_raw = (
        config.getoption("agent_observability_live_streaming")
        or os.getenv("AGENT_OBSERVABILITY_LIVE_STREAMING", "true")
    )
    _state.live_streaming = str(live_raw).lower() not in ("false", "0", "no")

    _state.heartbeat_interval = float(
        config.getoption("agent_observability_heartbeat_interval")
        or up._env_float("AGENT_OBSERVABILITY_HEARTBEAT_INTERVAL", 10.0)
    )

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
    _state._flusher_thread = None
    _state._stop_event = None
    col.clear_all_state()
    _state._test_tokens.clear()


# ── Session hooks ───────────────────────────────────────────────────────────


def pytest_sessionstart(session: pytest.Session) -> None:
    if not _state.enabled:
        return
    _state.collector = col.RunCollector.new(started_at=time.time(), ci=detect_ci())

    assert _state.upload_config is not None
    _start_payload = pl.build_payload(
        collector=_state.collector,
        agent_id=_state.agent_id,
        account_id=_state.account_id,
        run_name=_state.run_name,
        finished_at=None,
        status="running",
        cases=[],
    )
    try:
        up.best_effort_post(_start_payload, _state.upload_config)
    except Exception as e:
        logger.warning("start-of-run POST failed: %s", e)

    if _state.live_streaming:
        _start_flusher()


def _start_flusher() -> None:
    """Start the background flusher thread."""
    q: "queue.Queue[col.CaseRecord]" = queue.Queue()
    stop = threading.Event()
    _state._stop_event = stop
    assert _state.collector is not None
    _state.collector._case_queue = q

    t = threading.Thread(
        target=_flusher_loop,
        args=(q, stop, _state.upload_config, _state.collector, _state.agent_id,
              _state.account_id, _state.run_name, _state.heartbeat_interval),
        daemon=True,
        name="agent-observability-flusher",
    )
    t.start()
    _state._flusher_thread = t


def _flusher_loop(
    q: "queue.Queue[col.CaseRecord]",
    stop: threading.Event,
    config: up.UploadConfig,
    collector: col.RunCollector,
    agent_id: Optional[str],
    account_id: Optional[str],
    run_name: Optional[str],
    heartbeat_interval: float,
) -> None:
    """Drain queue and POST; send heartbeat when idle too long."""
    last_posted_at = time.monotonic()
    drain_timeout = 3.0  # seconds to wait for next case before checking

    while not stop.is_set():
        cases: list[col.CaseRecord] = []
        # Drain all available cases (blocking up to drain_timeout on first item).
        try:
            cases.append(q.get(timeout=drain_timeout))
            # Drain remaining without blocking.
            while True:
                cases.append(q.get_nowait())
        except queue.Empty:
            pass

        if cases:
            payload = pl.build_payload(
                collector=collector,
                agent_id=agent_id,
                account_id=account_id,
                run_name=run_name,
                finished_at=None,
                status="running",
                cases=cases,
            )
            try:
                up.best_effort_post(payload, config)
            except Exception as e:
                logger.debug("live POST error: %s", e)
            last_posted_at = time.monotonic()
        elif time.monotonic() - last_posted_at >= heartbeat_interval:
            # Send heartbeat: empty cases refreshes last_heartbeat_at on server.
            heartbeat = pl.build_payload(
                collector=collector,
                agent_id=agent_id,
                account_id=account_id,
                run_name=run_name,
                finished_at=None,
                status="running",
                cases=[],
            )
            try:
                up.best_effort_post(heartbeat, config)
            except Exception as e:
                logger.debug("heartbeat POST error: %s", e)
            last_posted_at = time.monotonic()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    if not _state.enabled or _state.collector is None:
        return

    # Stop flusher and drain residual cases from queue.
    if _state._stop_event is not None:
        _state._stop_event.set()
    if _state._flusher_thread is not None:
        _state._flusher_thread.join(timeout=5.0)

    _state.collector._case_queue = None

    # Determine final run status from pytest exitstatus.
    # exitstatus 0=OK, 1=tests failed, 2=interrupted, 3=internal error,
    # 4=cmdline error, 5=no tests collected
    run_status = "completed" if exitstatus in (0, 1, 5) else "failed"

    payload = pl.build_payload(
        collector=_state.collector,
        agent_id=_state.agent_id,
        account_id=_state.account_id,
        run_name=_state.run_name,
        finished_at=time.time(),
        status=run_status,
    )

    _state._last_run_id = _state.collector.run_id

    assert _state.upload_config is not None  # guaranteed by pytest_configure
    _state._last_upload_ok = up.upload(
        payload, _state.upload_config, fallback_dir=_state.fallback_dir,
    )


def pytest_terminal_summary(
    terminalreporter: Any, exitstatus: int, config: pytest.Config
) -> None:
    """Print the run_id (and dashboard URL) in pytest's summary block."""
    run_id = _state._last_run_id
    if not run_id:
        return
    terminalreporter.write_sep("=", "agent-observability")
    if _state._last_upload_ok and _state.upload_config is not None:
        base_url = _state.upload_config.url  # already rstrip('/')
        terminalreporter.write_line(f"Run uploaded: {run_id}")
        terminalreporter.write_line(f"View at:      {base_url}/evals/{run_id}")
    else:
        terminalreporter.write_line(f"Run upload failed: {run_id}")
        if _state.fallback_dir is not None:
            fallback_path = _state.fallback_dir / f"{run_id}.json"
            terminalreporter.write_line(f"Payload saved: {fallback_path}")


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

    # Append token usage from AgentSession.usage (one usage event per LLM model/provider).
    sessions = state.sessions if state else []
    for session in sessions:
        events.extend(_extract_session_usage(session))

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
            col._record_session(self)
        except Exception:
            pass
        return result

    AgentSession.run = wrapped  # type: ignore[method-assign]

    def _restore() -> None:
        AgentSession.run = original  # type: ignore[method-assign]

    _state._autocapture_restorer = _restore


def _extract_session_usage(session: Any) -> list[dict]:
    """Read LLM token usage from AgentSession.usage and return as usage events.

    AgentSession accumulates usage via ModelUsageCollector. We emit one
    `usage` event per LLM provider/model combination so the server can
    compute per-case token totals and estimated cost.
    """
    try:
        agent_usage = session.usage  # AgentSessionUsage
        model_usage_list = getattr(agent_usage, "model_usage", None) or []
    except Exception:
        return []

    out: list[dict] = []
    for mu in model_usage_list:
        if getattr(mu, "type", None) != "llm_usage":
            continue
        prompt = int(getattr(mu, "input_tokens", 0) or 0)
        completion = int(getattr(mu, "output_tokens", 0) or 0)
        if prompt == 0 and completion == 0:
            continue
        cached = int(getattr(mu, "input_cached_tokens", 0) or 0)
        entry: dict = {
            "type": "usage",
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "provider": getattr(mu, "provider", None) or None,
            "model": getattr(mu, "model", None) or None,
        }
        if cached > 0:
            entry["cached_prompt_tokens"] = cached
        out.append(entry)
    return out
