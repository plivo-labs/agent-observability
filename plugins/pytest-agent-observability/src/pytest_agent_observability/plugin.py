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

# How long the flusher waits (in seconds) on the queue for the next
# completed case before checking the stop signal. Lower = more
# responsive but more wakeups; 3s is a good balance — cases arrive in
# bursts at end-of-test, so per-test latency to dashboard is dominated
# by this floor.
_FLUSHER_DRAIN_TIMEOUT_S = 3.0


# Module-level state set up in pytest_configure, cleared in pytest_unconfigure.
class _State:
    enabled: bool = False
    collector: Optional[col.RunCollector] = None
    upload_config: Optional[up.UploadConfig] = None
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    account_id: Optional[str] = None
    # Optional human-readable label for this run. Set via
    # `--agent-observability-run-name` or AGENT_OBSERVABILITY_RUN_NAME.
    run_name: Optional[str] = None
    fallback_dir: Optional[Path] = None
    # Per-case streaming: when enabled (default), each finished case is
    # enqueued and a background worker POSTs partial-case payloads to
    # the server every ~3s. The terminal pytest_sessionfinish POST still
    # carries the full case list, so streaming is purely UX (cases show
    # up live instead of all-at-once at end).
    live_streaming: bool = True
    _case_queue: Optional["queue.Queue[col.CaseRecord]"] = None
    _flusher_thread: Optional[threading.Thread] = None
    _stop_event: Optional[threading.Event] = None
    _judge_restorer: Optional[Any] = None
    _autocapture_restorer: Optional[Any] = None
    _test_tokens: dict = {}
    # Populated by pytest_sessionfinish so pytest_terminal_summary can print the
    # run_id (and clickable dashboard URL) alongside the normal pytest summary.
    _last_run_id: Optional[str] = None
    _last_upload_ok: bool = False


_state = _State()


def _parse_bool(raw: Optional[str], default: bool = True) -> bool:
    """Parse a CLI/env boolean. Accepts truthy/falsy strings; falls back
    to `default` when value is None/empty/unrecognised-as-False."""
    if raw is None:
        return default
    return str(raw).strip().lower() not in ("false", "0", "no", "off", "")


def _status_from_exitstatus(exitstatus: int) -> str:
    """Map pytest's exit code to the run lifecycle status the server
    expects. pytest_sessionfinish always fires (even on KeyboardInterrupt
    and internal errors), so we can derive the right status from
    exitstatus rather than running a parallel heartbeat-based liveness
    signal.

    pytest.ExitCode values:
      0 OK                  -> 'completed'  (all tests passed)
      1 TESTS_FAILED        -> 'completed'  (run finished; tests had failures)
      2 INTERRUPTED         -> 'cancelled'  (Ctrl+C / SIGINT)
      3 INTERNAL_ERROR      -> 'failed'     (pytest crashed)
      4 USAGE_ERROR         -> 'completed'  (CLI misuse; pytest ran fine)
      5 NO_TESTS_COLLECTED  -> 'completed'  (nothing matched; not a failure)
    """
    if exitstatus == 2:
        return "cancelled"
    if exitstatus == 3:
        return "failed"
    return "completed"


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
        "--agent-observability-agent-name",
        dest="agent_observability_agent_name",
        default=None,
        help=(
            "Human-readable label for the agent (free-form text). "
            "Overrides AGENT_OBSERVABILITY_AGENT_NAME."
        ),
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
            "Optional human-readable label for this run (e.g. 'Nightly smoke'). "
            "Overrides AGENT_OBSERVABILITY_RUN_NAME."
        ),
    )
    group.addoption(
        "--agent-observability-live-streaming",
        dest="agent_observability_live_streaming",
        default=None,
        help=(
            "Stream each completed case to the dashboard as it finishes "
            "(default true). Pass `false`/`0`/`no` to disable — the terminal "
            "session-finish POST still sends the full case list. "
            "Overrides AGENT_OBSERVABILITY_LIVE_STREAMING."
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


# ── Configure / unconfigure (lifecycle) ─────────────────────────────────────


def pytest_configure(config: pytest.Config) -> None:
    url = config.getoption("agent_observability_url") or os.getenv("AGENT_OBSERVABILITY_URL")
    if not url:
        return  # No-op when no server is configured.

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
    _state.agent_name = (
        config.getoption("agent_observability_agent_name")
        or os.getenv("AGENT_OBSERVABILITY_AGENT_NAME")
    )
    _state.account_id = (
        config.getoption("agent_observability_account_id")
        or os.getenv("AGENT_OBSERVABILITY_ACCOUNT_ID")
    )
    _state.run_name = (
        config.getoption("agent_observability_run_name")
        or os.getenv("AGENT_OBSERVABILITY_RUN_NAME")
    )
    _state.live_streaming = _parse_bool(
        config.getoption("agent_observability_live_streaming")
        or os.getenv("AGENT_OBSERVABILITY_LIVE_STREAMING"),
        default=True,
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

    # Stream a status='running' row up front so the dashboard surfaces
    # the in-flight run. The terminal session-finish POST overwrites it
    # via the server's INSERT ON CONFLICT DO UPDATE. Best-effort — a
    # failed running-ping doesn't break the test run (it just means the
    # dashboard sees the run for the first time when sessionfinish hits).
    if _state.upload_config is None:
        return

    try:
        running_payload = pl.build_payload(
            collector=_state.collector,
            agent_id=_state.agent_id,
            agent_name=_state.agent_name,
            account_id=_state.account_id,
            finished_at=None,
            status="running",
            name=_state.run_name,
        )
        # No fallback for the running ping — the terminal POST is what
        # matters for offline recovery (and the read overlay's 1h TTL
        # cleans up any 'running' row whose terminal POST never lands).
        up.upload(running_payload, _state.upload_config, fallback_dir=None)
    except Exception:
        pass

    # Per-case streaming: start the background flusher so each
    # completed case lands on the dashboard within ~3s rather than at
    # session-end. Disabled when the user passes --agent-observability-
    # live-streaming=false.
    if _state.live_streaming:
        _state._case_queue = queue.Queue()
        _state._stop_event = threading.Event()
        _state._flusher_thread = threading.Thread(
            target=_flusher_loop,
            args=(
                _state._case_queue,
                _state._stop_event,
                _state.upload_config,
                _state.collector,
                _state.agent_id,
                _state.agent_name,
                _state.account_id,
                _state.run_name,
            ),
            daemon=True,
            name="agent-observability-flusher",
        )
        _state._flusher_thread.start()


def _flusher_loop(
    q: "queue.Queue[col.CaseRecord]",
    stop: threading.Event,
    config: up.UploadConfig,
    collector: col.RunCollector,
    agent_id: Optional[str],
    agent_name: Optional[str],
    account_id: Optional[str],
    run_name: Optional[str],
) -> None:
    """Drain queue every ~3s and POST drained cases as a partial
    payload (status='running', cases=<just these>). The server treats
    these additively: case inserts use ON CONFLICT (case_id) DO NOTHING
    and run-level totals/sums are recomputed from eval_cases after each
    insert, so the run row stays consistent with what's been uploaded.
    Failures are silently swallowed — the terminal POST at session-finish
    carries the full set and is the source of truth.
    """
    while not stop.is_set():
        cases: list[col.CaseRecord] = []
        try:
            # Block up to drain_timeout for the first case so we don't
            # spin while idle.
            cases.append(q.get(timeout=_FLUSHER_DRAIN_TIMEOUT_S))
            # Drain everything else that's queued up (e.g. a burst of
            # parallel-test completions) without blocking.
            while True:
                cases.append(q.get_nowait())
        except queue.Empty:
            pass

        if not cases:
            continue

        try:
            partial = pl.build_payload(
                collector=collector,
                agent_id=agent_id,
                agent_name=agent_name,
                account_id=account_id,
                finished_at=None,
                status="running",
                name=run_name,
                cases=cases,
            )
            up.best_effort_post(partial, config)
        except Exception as e:
            logger.debug("live-stream POST error: %s", e)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    if not _state.enabled or _state.collector is None:
        return

    # Stop the flusher BEFORE the terminal POST so it can't race the
    # final upload (which carries the full case list and is the source
    # of truth). Residual queued cases are already in collector.cases
    # via pytest_runtest_makereport, so dropping the queue is safe.
    if _state._stop_event is not None:
        _state._stop_event.set()
    if _state._flusher_thread is not None:
        _state._flusher_thread.join(timeout=5.0)
    _state._flusher_thread = None
    _state._stop_event = None
    _state._case_queue = None

    # pytest_sessionfinish always fires — including on Ctrl+C
    # (exitstatus=2 INTERRUPTED) and pytest internal errors
    # (exitstatus=3 INTERNAL_ERROR) — so we can pass the right status
    # downstream without a separate liveness channel.
    status = _status_from_exitstatus(exitstatus)

    payload = pl.build_payload(
        collector=_state.collector,
        agent_id=_state.agent_id,
        agent_name=_state.agent_name,
        account_id=_state.account_id,
        finished_at=time.time(),
        status=status,
        name=_state.run_name,
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
    sessions = state.sessions if state else []
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

    # Append synthetic `usage` events from each captured AgentSession.
    # LiveKit's RunResult.events DON'T carry LLM token counts on
    # item.metrics — those live on AgentSession.usage via
    # ModelUsageCollector. The server's computeCaseMetrics handles
    # `type: "usage"` events specifically for this case so cost +
    # tokens land in the dashboard without a separate ingest path.
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

    # Per-case streaming: also enqueue for the flusher so the dashboard
    # sees this case within ~3s. Best-effort — queue.put_nowait can fail
    # if the queue is bounded (we don't bound it), and dropping a streamed
    # update is fine because collector.cases still has the record for
    # the terminal POST.
    if _state.live_streaming and _state._case_queue is not None:
        try:
            _state._case_queue.put_nowait(record)
        except Exception:
            pass


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

    Also records the AgentSession itself — at session-finish we read
    `session.usage` to emit synthetic `type: "usage"` events with token
    counts (LiveKit doesn't surface tokens on RunResult.events.metrics).

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
    """Read LLM token usage from an AgentSession's accumulated
    ModelUsageCollector entries. Returns one synthetic `usage` event
    per (provider, model) combination — server's computeCaseMetrics
    walks these the same way it walks per-message `metrics` for tokens
    and cost.

    Returns [] when the session has no usage attribute (older LiveKit
    versions), or when accessing it raises, or when all collectors are
    non-LLM types (e.g. STT/TTS). Never raises — the test outcome must
    not depend on whether usage extraction works.
    """
    try:
        agent_usage = session.usage  # AgentSessionUsage
        model_usage_list = getattr(agent_usage, "model_usage", None) or []
    except Exception:
        return []

    out: list[dict] = []
    for mu in model_usage_list:
        # Only LLM usage carries the input/output token split we need
        # for cost. STT/TTS collectors have different shapes.
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
