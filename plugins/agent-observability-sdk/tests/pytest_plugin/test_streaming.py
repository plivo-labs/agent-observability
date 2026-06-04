"""Tests for the live-status additions: session-start streams a
'running' row, session-finish derives the terminal status from pytest's
exitstatus.

Heartbeats have been removed — pytest_sessionfinish always fires
(including on Ctrl+C and pytest internal errors), so we don't need a
parallel liveness channel. The server-side overlay handles the residual
'hard-kill' case (SIGKILL, OOM, machine death) via a 1h TTL on
last_activity_at — tested in tests/evals-overlay.test.ts.
"""

from __future__ import annotations

import queue
import threading
import time
from unittest.mock import MagicMock, patch

from agent_observability.livekit.pytest import collector as col
from agent_observability.livekit.pytest import plugin as pl
from agent_observability.livekit.pytest import uploader as up


def _make_config() -> up.UploadConfig:
    return up.UploadConfig(
        url="http://stub:9090",
        basic_auth=None,
        timeout_s=1.0,
        max_retries=1,
    )


def _reset_plugin_state() -> None:
    # Make sure any flusher we spun up is stopped + joined before we
    # null the state fields, otherwise daemon threads can linger.
    if pl._state._stop_event is not None:
        try:
            pl._state._stop_event.set()
        except Exception:
            pass
    if pl._state._flusher_thread is not None:
        try:
            pl._state._flusher_thread.join(timeout=2.0)
        except Exception:
            pass
    pl._state._flusher_thread = None
    pl._state._stop_event = None
    pl._state._case_queue = None
    pl._state.collector = None
    pl._state.enabled = False
    pl._state.upload_config = None
    pl._state.agent_id = None
    pl._state.agent_name = None
    pl._state.account_id = None
    pl._state.run_name = None
    pl._state.live_streaming = True


# ── pytest_sessionstart: streams a 'running' row up front ──────────────────


def test_session_start_posts_running_payload_with_full_identity(monkeypatch):
    """Streaming session-start sends a status='running' payload so the
    dashboard surfaces the run while the suite is executing. All
    identity fields (agent_id, agent_name, account_id, ci, framework)
    must be present — the server's ON CONFLICT DO UPDATE relies on this
    so the terminal POST can use COALESCE rather than fight nulls."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.agent_id = "support-bot"
    pl._state.agent_name = "Support Bot"
    pl._state.account_id = "acct-1"

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionstart(MagicMock())
        assert len(captured) == 1
        run = captured[0]["run"]
        assert run["status"] == "running"
        assert run["finished_at"] is None
        # Identity fields preserved on the running ping.
        assert run["agent_id"] == "support-bot"
        assert run["agent_name"] == "Support Bot"
        assert run["account_id"] == "acct-1"
        assert run["testing_framework"] == "pytest"
        # No cases yet — they arrive in the terminal POST.
        assert captured[0]["cases"] == []
    finally:
        _reset_plugin_state()


def test_session_start_no_op_when_plugin_disabled():
    """When no AGENT_OBSERVABILITY_URL was configured, sessionstart is a
    no-op — don't post anything."""
    pl._state.enabled = False
    pl._state.upload_config = None
    try:
        pl.pytest_sessionstart(MagicMock())
        assert pl._state.collector is None
    finally:
        _reset_plugin_state()


def test_session_start_no_op_when_upload_config_missing(monkeypatch):
    """Even with enabled=True, missing upload_config should skip the
    running ping — defensive against partial state setup."""
    pl._state.enabled = True
    pl._state.upload_config = None
    posted = []
    monkeypatch.setattr(up, "upload", lambda *a, **kw: posted.append(a) or True)
    try:
        pl.pytest_sessionstart(MagicMock())
        # Collector is created but no upload happens.
        assert pl._state.collector is not None
        assert posted == []
    finally:
        _reset_plugin_state()


def test_session_start_swallows_upload_failures(monkeypatch):
    """A failed running-ping must not break the test run. The terminal
    POST is what matters for offline recovery; this is just an eager
    UX signal."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()

    def boom(*a, **kw):
        raise RuntimeError("simulated upload crash")

    monkeypatch.setattr(up, "upload", boom)
    try:
        # Should not raise.
        pl.pytest_sessionstart(MagicMock())
        assert pl._state.collector is not None
    finally:
        _reset_plugin_state()


# ── pytest_sessionfinish: status from pytest's exitstatus ──────────────────


def test_status_from_exitstatus_maps_all_cases():
    """pytest.ExitCode mappings:
      0 OK              -> completed
      1 TESTS_FAILED    -> completed (run finished; tests had failures)
      2 INTERRUPTED     -> cancelled (Ctrl+C)
      3 INTERNAL_ERROR  -> failed
      4 USAGE_ERROR     -> completed
      5 NO_TESTS_COLLECTED -> completed
    """
    assert pl._status_from_exitstatus(0) == "completed"
    assert pl._status_from_exitstatus(1) == "completed"
    assert pl._status_from_exitstatus(2) == "cancelled"
    assert pl._status_from_exitstatus(3) == "failed"
    assert pl._status_from_exitstatus(4) == "completed"
    assert pl._status_from_exitstatus(5) == "completed"
    # Unknown codes default to 'completed' rather than 'failed' — we'd
    # rather mark a run finished than spuriously alarming.
    assert pl._status_from_exitstatus(99) == "completed"


def test_session_finish_posts_completed_on_zero_exit(monkeypatch):
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.collector = col.RunCollector.new(started_at=100.0)
    pl._state.agent_id = "support-bot"
    pl._state.agent_name = "Support Bot"
    pl._state.account_id = "acct-1"

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionfinish(MagicMock(), 0)
        assert len(captured) == 1
        run = captured[0]["run"]
        assert run["status"] == "completed"
        assert run["finished_at"] is not None
        # Identity still present on the terminal POST.
        assert run["agent_id"] == "support-bot"
    finally:
        _reset_plugin_state()


def test_session_finish_posts_cancelled_on_keyboard_interrupt(monkeypatch):
    """exitstatus=2 (pytest.ExitCode.INTERRUPTED) → status='cancelled'."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.collector = col.RunCollector.new(started_at=100.0)

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionfinish(MagicMock(), 2)
        assert captured[0]["run"]["status"] == "cancelled"
    finally:
        _reset_plugin_state()


def test_session_finish_posts_failed_on_internal_error(monkeypatch):
    """exitstatus=3 (pytest.ExitCode.INTERNAL_ERROR) → status='failed'."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.collector = col.RunCollector.new(started_at=100.0)

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionfinish(MagicMock(), 3)
        assert captured[0]["run"]["status"] == "failed"
    finally:
        _reset_plugin_state()


def test_session_finish_posts_completed_on_test_failures(monkeypatch):
    """exitstatus=1 (tests failed) → 'completed': the run itself reached
    the end, it just had failing tests. 'failed' is reserved for cases
    where the run never properly completed."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.collector = col.RunCollector.new(started_at=100.0)

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionfinish(MagicMock(), 1)
        assert captured[0]["run"]["status"] == "completed"
    finally:
        _reset_plugin_state()


# ── Run name plumbing (CLI/env → state → payload) ──────────────────────────


def test_session_start_includes_run_name_when_set(monkeypatch):
    """When _state.run_name is set (from CLI flag or env var, both
    handled in pytest_configure), the session-start payload carries it
    so the dashboard can label the row immediately."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.run_name = "PR #482 smoke"

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionstart(MagicMock())
        assert captured[0]["run"]["name"] == "PR #482 smoke"
    finally:
        _reset_plugin_state()


def test_session_finish_includes_run_name_when_set(monkeypatch):
    """Terminal POST also includes the run name — server's COALESCE in
    ON CONFLICT preserves it either way, but sending it on both POSTs
    keeps the plugin payloads symmetrical and lets plugins that skip
    the session-start ping still get the name through."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.collector = col.RunCollector.new(started_at=100.0)
    pl._state.run_name = "Nightly smoke"

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionfinish(MagicMock(), 0)
        assert captured[0]["run"]["name"] == "Nightly smoke"
    finally:
        _reset_plugin_state()


def test_run_name_defaults_to_none_when_unset(monkeypatch):
    """Without CLI flag or env var, run_name stays None and the payload
    carries name=None. Server stores NULL; dashboard renders em-dash."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.collector = col.RunCollector.new(started_at=100.0)

    captured: list = []
    monkeypatch.setattr(
        up,
        "upload",
        lambda payload, cfg, fallback_dir=None: captured.append(payload) or True,
    )

    try:
        pl.pytest_sessionfinish(MagicMock(), 0)
        assert captured[0]["run"]["name"] is None
    finally:
        _reset_plugin_state()


# ── _parse_bool (live-streaming flag parser) ────────────────────────────────


def test_parse_bool_default_when_none():
    assert pl._parse_bool(None, default=True) is True
    assert pl._parse_bool(None, default=False) is False


def test_parse_bool_truthy_strings():
    for s in ["true", "True", "TRUE", "1", "yes", "on"]:
        assert pl._parse_bool(s, default=False) is True, f"expected True for {s!r}"


def test_parse_bool_falsy_strings():
    for s in ["false", "False", "FALSE", "0", "no", "off", ""]:
        assert pl._parse_bool(s, default=True) is False, f"expected False for {s!r}"


def test_parse_bool_unknown_treated_as_truthy_when_default_true():
    # Any non-empty non-falsy string falls through to truthy. Avoids
    # surprising silent disables when env vars carry odd values.
    assert pl._parse_bool("maybe", default=True) is True


# ── best_effort_post (uploader-side helper) ────────────────────────────────


def test_best_effort_post_returns_true_on_2xx():
    cfg = _make_config()
    mock_resp = MagicMock()
    mock_resp.status_code = 201
    mock_client = MagicMock()
    mock_client.__enter__.return_value.post.return_value = mock_resp

    with patch("httpx.Client", return_value=mock_client):
        ok = up.best_effort_post({"version": "v0", "run": {}}, cfg)
    assert ok is True


def test_best_effort_post_returns_false_on_5xx_without_retry():
    cfg = _make_config()
    mock_resp = MagicMock()
    mock_resp.status_code = 503
    mock_client = MagicMock()
    mock_client.__enter__.return_value.post.return_value = mock_resp

    with patch("httpx.Client", return_value=mock_client) as patched:
        ok = up.best_effort_post({}, cfg)
    assert ok is False
    # Single attempt — no retry loop, unlike upload().
    assert patched.return_value.__enter__.return_value.post.call_count == 1


def test_best_effort_post_swallows_network_errors():
    cfg = _make_config()
    with patch("httpx.Client", side_effect=ConnectionError("network down")):
        ok = up.best_effort_post({}, cfg)
    assert ok is False  # never raises


def test_best_effort_post_hits_evals_v0_endpoint():
    cfg = _make_config()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_client = MagicMock()
    mock_client.__enter__.return_value.post.return_value = mock_resp

    with patch("httpx.Client", return_value=mock_client):
        up.best_effort_post({"version": "v0", "run": {}}, cfg)

    posted_url = mock_client.__enter__.return_value.post.call_args[0][0]
    assert posted_url == "http://stub:9090/observability/evals/v0"


# ── _flusher_loop (drains queue, posts partial payloads) ───────────────────


def test_flusher_loop_exits_immediately_on_stop_event(monkeypatch):
    """Stop event already set → loop returns without posting."""
    cfg = _make_config()
    q: "queue.Queue[col.CaseRecord]" = queue.Queue()
    stop = threading.Event()
    stop.set()

    calls = []
    monkeypatch.setattr(up, "best_effort_post", lambda *a, **kw: calls.append(a) or True)

    rc = col.RunCollector.new(started_at=0.0)
    pl._flusher_loop(q, stop, cfg, rc, None, None, None, None)
    assert calls == []


def test_flusher_loop_drains_queue_and_posts_partial(monkeypatch):
    """Enqueue a case, run the loop until stop, verify a partial POST
    fired with that case in the payload."""
    # Tighten the drain timeout so the test stays fast.
    monkeypatch.setattr(pl, "_FLUSHER_DRAIN_TIMEOUT_S", 0.05)

    cfg = _make_config()
    q: "queue.Queue[col.CaseRecord]" = queue.Queue()
    stop = threading.Event()

    case = col.CaseRecord(
        case_id="case-streamed", name="t", file=None, status="passed",
        duration_ms=10, user_input=None, events=[], judgments=[], failure=None,
    )
    q.put(case)

    captured: list = []

    def fake_post(payload, _cfg):
        captured.append(payload)
        # Stop after the first post so the loop exits.
        stop.set()
        return True

    monkeypatch.setattr(up, "best_effort_post", fake_post)

    rc = col.RunCollector.new(started_at=0.0)
    pl._flusher_loop(q, stop, cfg, rc, "bot", "Bot", "acct", "Nightly")

    assert len(captured) == 1
    payload = captured[0]
    assert payload["run"]["status"] == "running"
    assert payload["run"]["finished_at"] is None
    assert payload["run"]["name"] == "Nightly"
    assert payload["run"]["agent_id"] == "bot"
    assert len(payload["cases"]) == 1
    assert payload["cases"][0]["case_id"] == "case-streamed"


def test_flusher_loop_batches_burst_of_cases(monkeypatch):
    """Multiple cases queued in a burst should drain into a single
    payload (drain_timeout blocks for the first; then queue.get_nowait
    sweeps the rest without blocking)."""
    monkeypatch.setattr(pl, "_FLUSHER_DRAIN_TIMEOUT_S", 0.05)

    cfg = _make_config()
    q: "queue.Queue[col.CaseRecord]" = queue.Queue()
    stop = threading.Event()

    for i in range(3):
        q.put(col.CaseRecord(
            case_id=f"c-{i}", name=f"t{i}", file=None, status="passed",
            duration_ms=5, user_input=None, events=[], judgments=[], failure=None,
        ))

    captured: list = []

    def fake_post(payload, _cfg):
        captured.append(payload)
        stop.set()
        return True

    monkeypatch.setattr(up, "best_effort_post", fake_post)

    pl._flusher_loop(q, stop, cfg, col.RunCollector.new(started_at=0.0),
                    None, None, None, None)

    assert len(captured) == 1
    assert len(captured[0]["cases"]) == 3


def test_flusher_loop_no_post_when_idle(monkeypatch):
    """If the queue stays empty across the drain timeout, the loop
    shouldn't post anything (no heartbeat traffic). It just loops back
    around and checks stop again."""
    monkeypatch.setattr(pl, "_FLUSHER_DRAIN_TIMEOUT_S", 0.02)

    cfg = _make_config()
    q: "queue.Queue[col.CaseRecord]" = queue.Queue()
    stop = threading.Event()

    posts = []
    monkeypatch.setattr(up, "best_effort_post", lambda p, c: posts.append(p) or True)

    # Stop after a few drain windows so the loop has spun without
    # finding cases.
    def stop_after_delay():
        time.sleep(0.1)
        stop.set()

    t = threading.Thread(target=stop_after_delay, daemon=True)
    t.start()

    pl._flusher_loop(q, stop, cfg, col.RunCollector.new(started_at=0.0),
                    None, None, None, None)
    t.join(timeout=1.0)

    assert posts == []


# ── pytest_runtest_makereport enqueues when streaming is on ────────────────


def test_runtest_makereport_enqueues_when_streaming_enabled(monkeypatch):
    """When the flusher queue exists, completed cases should be
    enqueued in addition to being added to collector.cases."""
    # Stub out the LiveKit-y bits that pytest_runtest_makereport
    # would normally touch.
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.live_streaming = True
    pl._state.collector = col.RunCollector.new(started_at=0.0)
    pl._state._case_queue = queue.Queue()

    # Stub the helpers the hook calls into.
    monkeypatch.setattr(col, "pop_state", lambda nodeid: None)
    monkeypatch.setattr(pl, "_derive_status", lambda *a, **kw: ("passed", None))

    # Fake report + item.
    report = MagicMock()
    report.when = "call"
    report.outcome = "passed"
    report.duration = 0.1
    report.longrepr = None
    item = MagicMock()
    item.nodeid = "tests/test_x.py::test_y"
    item.name = "test_y"

    call_info = MagicMock()
    call_info.excinfo = None

    # Wrap pytest_runtest_makereport (it's a hookwrapper). Send the
    # report through outcome.get_result().
    outcome = MagicMock()
    outcome.get_result.return_value = report
    gen = pl.pytest_runtest_makereport(item, call_info)
    next(gen)  # advance to yield
    try:
        gen.send(outcome)
    except StopIteration:
        pass

    try:
        assert len(pl._state.collector.cases) == 1
        # Queue should also have the case.
        assert pl._state._case_queue.qsize() == 1
        queued = pl._state._case_queue.get_nowait()
        assert queued.name == "test_y"
    finally:
        _reset_plugin_state()


def test_runtest_makereport_no_enqueue_when_streaming_disabled(monkeypatch):
    """live_streaming=False → no queue is set up, so the hook just
    adds to collector.cases and skips the enqueue branch."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.live_streaming = False
    pl._state.collector = col.RunCollector.new(started_at=0.0)
    pl._state._case_queue = None  # not started when streaming disabled

    monkeypatch.setattr(col, "pop_state", lambda nodeid: None)
    monkeypatch.setattr(pl, "_derive_status", lambda *a, **kw: ("passed", None))

    report = MagicMock()
    report.when = "call"
    report.outcome = "passed"
    report.duration = 0.1
    report.longrepr = None
    item = MagicMock()
    item.nodeid = "tests/test_x.py::test_y"
    item.name = "test_y"
    call_info = MagicMock()
    call_info.excinfo = None
    outcome = MagicMock()
    outcome.get_result.return_value = report

    gen = pl.pytest_runtest_makereport(item, call_info)
    next(gen)
    try:
        gen.send(outcome)
    except StopIteration:
        pass

    try:
        assert len(pl._state.collector.cases) == 1
        assert pl._state._case_queue is None
    finally:
        _reset_plugin_state()


# ── pytest_sessionstart spins up the flusher when streaming enabled ──────


def test_session_start_starts_flusher_when_streaming_enabled(monkeypatch):
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.live_streaming = True

    monkeypatch.setattr(up, "upload", lambda *a, **kw: True)

    try:
        pl.pytest_sessionstart(MagicMock())
        assert pl._state._flusher_thread is not None
        assert pl._state._flusher_thread.is_alive()
        assert pl._state._case_queue is not None
        assert pl._state._stop_event is not None
    finally:
        _reset_plugin_state()


def test_session_start_skips_flusher_when_streaming_disabled(monkeypatch):
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.live_streaming = False

    monkeypatch.setattr(up, "upload", lambda *a, **kw: True)

    try:
        pl.pytest_sessionstart(MagicMock())
        assert pl._state._flusher_thread is None
        assert pl._state._case_queue is None
        assert pl._state._stop_event is None
    finally:
        _reset_plugin_state()


# ── _extract_session_usage (S6.5: usage from AgentSession.usage) ───────────


class _FakeModelUsage:
    """Minimal stand-in for LiveKit's ModelUsageCollector entries."""
    def __init__(
        self,
        *,
        type: str = "llm_usage",
        input_tokens: int = 0,
        output_tokens: int = 0,
        input_cached_tokens: int = 0,
        provider: str | None = None,
        model: str | None = None,
    ):
        self.type = type
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.input_cached_tokens = input_cached_tokens
        self.provider = provider
        self.model = model


class _FakeAgentUsage:
    def __init__(self, model_usage: list):
        self.model_usage = model_usage


class _FakeAgentSession:
    def __init__(self, usage):
        self.usage = usage


def test_extract_session_usage_emits_one_per_llm_provider_model():
    """One synthetic `type: 'usage'` event per (provider, model) — these
    are what the server consumes for tokens + cost computation."""
    session = _FakeAgentSession(
        _FakeAgentUsage([
            _FakeModelUsage(
                input_tokens=1000, output_tokens=200,
                provider="openai", model="gpt-4o-mini",
            ),
            _FakeModelUsage(
                input_tokens=500, output_tokens=100,
                provider="anthropic", model="claude-haiku-4-5",
            ),
        ])
    )

    events = pl._extract_session_usage(session)
    assert len(events) == 2

    by_model = {ev["model"]: ev for ev in events}
    assert by_model["gpt-4o-mini"]["type"] == "usage"
    assert by_model["gpt-4o-mini"]["prompt_tokens"] == 1000
    assert by_model["gpt-4o-mini"]["completion_tokens"] == 200
    assert by_model["gpt-4o-mini"]["provider"] == "openai"
    assert by_model["claude-haiku-4-5"]["prompt_tokens"] == 500


def test_extract_session_usage_skips_non_llm_collectors():
    """STT/TTS collectors don't carry the input/output split we need —
    skip them so we don't emit garbage `usage` events."""
    session = _FakeAgentSession(
        _FakeAgentUsage([
            _FakeModelUsage(
                type="stt_usage", input_tokens=0, output_tokens=0,
                provider="openai", model="whisper-1",
            ),
            _FakeModelUsage(
                type="llm_usage", input_tokens=100, output_tokens=20,
                provider="openai", model="gpt-4o-mini",
            ),
            _FakeModelUsage(
                type="tts_usage", input_tokens=0, output_tokens=0,
                provider="elevenlabs", model="rachel",
            ),
        ])
    )

    events = pl._extract_session_usage(session)
    assert len(events) == 1
    assert events[0]["model"] == "gpt-4o-mini"


def test_extract_session_usage_skips_zero_token_entries():
    """An LLM collector with no actual calls (input=0, output=0) is a
    placeholder, not real usage — skip so we don't inflate sample
    count with empty events."""
    session = _FakeAgentSession(
        _FakeAgentUsage([
            _FakeModelUsage(
                input_tokens=0, output_tokens=0,
                provider="openai", model="gpt-4o-mini",
            ),
        ])
    )
    assert pl._extract_session_usage(session) == []


def test_extract_session_usage_includes_cached_when_present():
    """Cached prompt tokens land under `cached_prompt_tokens` so the
    server's pricing logic can apply the discounted cache_read rate."""
    session = _FakeAgentSession(
        _FakeAgentUsage([
            _FakeModelUsage(
                input_tokens=1000, output_tokens=100,
                input_cached_tokens=800,
                provider="openai", model="gpt-4o-mini",
            ),
        ])
    )
    events = pl._extract_session_usage(session)
    assert events[0]["cached_prompt_tokens"] == 800


def test_extract_session_usage_omits_cached_when_zero():
    """Cached=0 means no cache benefit. Omitting the field (rather than
    sending 0) lets the server treat absence and zero identically and
    keeps the wire payload small."""
    session = _FakeAgentSession(
        _FakeAgentUsage([
            _FakeModelUsage(
                input_tokens=100, output_tokens=20,
                input_cached_tokens=0,
                provider="openai", model="gpt-4o-mini",
            ),
        ])
    )
    events = pl._extract_session_usage(session)
    assert "cached_prompt_tokens" not in events[0]


def test_extract_session_usage_returns_empty_for_session_without_usage():
    """Older LiveKit versions may not have `.usage` — return [] rather
    than crashing. The plugin must not break tests."""
    class _Bare:
        pass  # no .usage attribute
    assert pl._extract_session_usage(_Bare()) == []


def test_extract_session_usage_returns_empty_when_usage_raises():
    """If reading `.usage` raises (mocked sessions, weird shapes), the
    extractor should swallow and return []."""
    class _Raising:
        @property
        def usage(self):
            raise RuntimeError("boom")
    assert pl._extract_session_usage(_Raising()) == []


def test_extract_session_usage_handles_missing_provider_model():
    """When the collector entry has no provider/model, the synthetic
    event still goes out — server will store the tokens but cost
    stays null (no priceFor match). Better than dropping the sample."""
    session = _FakeAgentSession(
        _FakeAgentUsage([
            _FakeModelUsage(
                input_tokens=100, output_tokens=20,
                provider=None, model=None,
            ),
        ])
    )
    events = pl._extract_session_usage(session)
    assert len(events) == 1
    assert events[0]["provider"] is None
    assert events[0]["model"] is None
    assert events[0]["prompt_tokens"] == 100


# ── collector._record_session ──────────────────────────────────────────────


def test_record_session_appends_to_current_test_state():
    """The autocapture wrapper calls _record_session(self) after every
    AgentSession.run() — we need to confirm the session reference lands
    on the per-test CaseState so pytest_runtest_makereport can read it
    later."""
    test_id = "test-x"
    token = col._set_current_test(test_id)
    try:
        s1 = _FakeAgentSession(None)
        col._record_session(s1)
        state = col.pop_state(test_id)
        assert state is not None
        assert len(state.sessions) == 1
        assert state.sessions[0] is s1
    finally:
        col._reset_current_test(token)


def test_record_session_is_idempotent_for_same_instance():
    """Multi-turn tests call AgentSession.run() multiple times on the
    same session — the wrapper would invoke _record_session repeatedly,
    but we only want one reference per instance (so _extract_session_usage
    doesn't double-count tokens)."""
    test_id = "test-y"
    token = col._set_current_test(test_id)
    try:
        s = _FakeAgentSession(None)
        col._record_session(s)
        col._record_session(s)
        col._record_session(s)
        state = col.pop_state(test_id)
        assert state is not None
        assert len(state.sessions) == 1
    finally:
        col._reset_current_test(token)


def test_record_session_no_op_outside_test_context():
    """Without an active test (e.g. plugin loaded but no test running),
    _record_session is a silent no-op rather than crashing."""
    # No _set_current_test → contextvar default is None.
    s = _FakeAgentSession(None)
    col._record_session(s)  # must not raise


def test_session_finish_stops_flusher_before_terminal_post(monkeypatch):
    """The terminal POST is the source of truth — flusher must be
    stopped + joined before sessionfinish dispatches it so a stray
    streaming write can't race the final write."""
    pl._state.enabled = True
    pl._state.upload_config = _make_config()
    pl._state.live_streaming = True
    pl._state.collector = col.RunCollector.new(started_at=0.0)

    # Spin a real flusher with a fast drain so we can verify it joins.
    monkeypatch.setattr(pl, "_FLUSHER_DRAIN_TIMEOUT_S", 0.02)
    pl._state._case_queue = queue.Queue()
    pl._state._stop_event = threading.Event()
    pl._state._flusher_thread = threading.Thread(
        target=pl._flusher_loop,
        args=(
            pl._state._case_queue, pl._state._stop_event,
            pl._state.upload_config, pl._state.collector,
            None, None, None, None,
        ),
        daemon=True,
    )
    pl._state._flusher_thread.start()
    flusher_ref = pl._state._flusher_thread

    monkeypatch.setattr(up, "upload", lambda *a, **kw: True)
    monkeypatch.setattr(up, "best_effort_post", lambda *a, **kw: True)

    try:
        pl.pytest_sessionfinish(MagicMock(), 0)
        # After sessionfinish, flusher must be cleaned up.
        assert pl._state._flusher_thread is None
        assert pl._state._stop_event is None
        assert pl._state._case_queue is None
        # And the thread itself must actually have stopped.
        assert not flusher_ref.is_alive()
    finally:
        _reset_plugin_state()
