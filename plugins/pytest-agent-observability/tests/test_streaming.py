"""Tests for live streaming: start POST, heartbeat, case streaming, final POST."""

from __future__ import annotations

import json
import queue
import threading
import time
from unittest.mock import MagicMock, call, patch

import pytest

from pytest_agent_observability import uploader as up
from pytest_agent_observability import collector as col
from pytest_agent_observability import payload as pl
from pytest_agent_observability.plugin import _flusher_loop


pytest_plugins = ["pytester"]


# ── helpers ─────────────────────────────────────────────────────────────────


def _cfg():
    return up.UploadConfig(url="http://stub:9090", timeout_s=0.5, max_retries=1)


def _make_case(name="t") -> col.CaseRecord:
    return col.CaseRecord(
        case_id="c-" + name,
        name=name,
        file="test_file.py",
        status="passed",
        duration_ms=1,
        user_input=None,
        events=[],
        judgments=[],
        failure=None,
    )


def _make_collector() -> col.RunCollector:
    return col.RunCollector(run_id="run-1", started_at=time.time())


# ── unit: flusher posts cases and heartbeats ─────────────────────────────────


def test_flusher_posts_cases():
    """Flusher drains a case from the queue and POSTs it."""
    q: queue.Queue = queue.Queue()
    stop = threading.Event()
    cfg = _cfg()
    collector = _make_collector()
    posted: list[dict] = []

    def fake_post(payload, config):
        posted.append(payload)
        return True

    q.put(_make_case("t1"))
    # Stop after first drain cycle completes.
    stop_after = threading.Timer(0.5, stop.set)
    stop_after.start()

    with patch.object(up, "best_effort_post", side_effect=fake_post):
        _flusher_loop(q, stop, cfg, collector, None, None, None, heartbeat_interval=60.0)

    stop_after.cancel()
    assert any(len(p["cases"]) > 0 for p in posted), "expected at least one case POST"
    case_names = [c["name"] for p in posted for c in p["cases"]]
    assert "t1" in case_names


def test_flusher_sends_heartbeat_when_idle():
    """Flusher sends an empty-cases POST when idle past heartbeat_interval."""
    q: queue.Queue = queue.Queue()
    stop = threading.Event()
    cfg = _cfg()
    collector = _make_collector()
    posted: list[dict] = []

    def fake_post(payload, config):
        posted.append(payload)
        return True

    # Use a very short heartbeat interval so we don't wait long.
    stop_after = threading.Timer(0.8, stop.set)
    stop_after.start()

    with patch.object(up, "best_effort_post", side_effect=fake_post):
        _flusher_loop(q, stop, cfg, collector, None, None, None, heartbeat_interval=0.1)

    stop_after.cancel()
    heartbeats = [p for p in posted if p["cases"] == []]
    assert len(heartbeats) >= 1, "expected at least one heartbeat"
    for hb in heartbeats:
        assert hb["run"]["finished_at"] is None
        assert hb["run"].get("status") == "running"


def test_flusher_cases_not_cumulative():
    """Each flush POST contains only the new cases since last flush, not all."""
    q: queue.Queue = queue.Queue()
    stop = threading.Event()
    cfg = _cfg()
    collector = _make_collector()
    posted: list[dict] = []

    def fake_post(payload, config):
        posted.append(payload)
        return True

    q.put(_make_case("a"))
    # Let first flush happen, then put second case.
    def enqueue_second():
        time.sleep(0.15)
        q.put(_make_case("b"))

    t = threading.Thread(target=enqueue_second)
    t.start()

    stop_after = threading.Timer(0.6, stop.set)
    stop_after.start()

    with patch.object(up, "best_effort_post", side_effect=fake_post):
        _flusher_loop(q, stop, cfg, collector, None, None, None, heartbeat_interval=60.0)

    stop_after.cancel()
    t.join()

    # Collect all case names per POST batch.
    batches = [[c["name"] for c in p["cases"]] for p in posted if p["cases"]]
    all_names = [n for batch in batches for n in batch]
    assert "a" in all_names
    assert "b" in all_names
    # No single batch should contain both (they were enqueued separately).
    for batch in batches:
        assert not ("a" in batch and "b" in batch), "cases should not be cumulative"


# ── integration: start POST and final POST via pytester ──────────────────────


def test_start_post_fires_before_any_case(pytester: pytest.Pytester, monkeypatch, tmp_path):
    """Start-of-run POST must fire at sessionstart, before any case is finalized."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.setenv("AGENT_OBSERVABILITY_LIVE_STREAMING", "false")  # isolate start POST

    start_file = tmp_path / "start.json"
    final_file = tmp_path / "final.json"

    pytester.makeconftest(
        f"""
        import json
        from pathlib import Path
        from pytest_agent_observability import uploader as up

        def _stub_best_effort(payload, config):
            # Only write the first best_effort call (the start POST).
            p = Path({str(start_file)!r})
            if not p.exists():
                p.write_text(json.dumps({{"status": payload.get("run", {{}}).get("status"), "finished_at": payload.get("run", {{}}).get("finished_at"), "cases_count": len(payload.get("cases", []))}}))
            return True

        def _stub_upload(payload, config, *, fallback_dir=None):
            Path({str(final_file)!r}).write_text(json.dumps({{"finished_at": payload.get("run", {{}}).get("finished_at"), "cases_count": len(payload.get("cases", []))}}))
            return True

        up.best_effort_post = _stub_best_effort
        up.upload = _stub_upload
        """
    )
    pytester.makepyfile("def test_one(): pass")
    pytester.runpytest("-p", "agent_observability").assert_outcomes(passed=1)

    assert start_file.exists(), "start POST stub should have written start.json"
    assert final_file.exists(), "final upload stub should have written final.json"

    start = json.loads(start_file.read_text())
    assert start["status"] == "running"
    assert start["finished_at"] is None
    assert start["cases_count"] == 0

    final = json.loads(final_file.read_text())
    assert final["finished_at"] is not None


def test_final_post_has_all_cases_and_status_completed(
    pytester: pytest.Pytester, monkeypatch, tmp_path
):
    """Final POST at sessionfinish has all cases and status='completed'."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.setenv("AGENT_OBSERVABILITY_LIVE_STREAMING", "false")

    captured = tmp_path / "payload.json"
    pytester.makeconftest(
        f"""
        from pytest_agent_observability import uploader as up

        def _stub_best_effort(payload, config):
            return True

        def _stub_upload(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured)!r}).write_text(json.dumps(payload))
            return True

        up.best_effort_post = _stub_best_effort
        up.upload = _stub_upload
        """
    )
    pytester.makepyfile(
        """
        def test_a(): pass
        def test_b(): pass
        """
    )
    pytester.runpytest("-p", "agent_observability").assert_outcomes(passed=2)

    assert captured.exists()
    payload = json.loads(captured.read_text())
    assert len(payload["cases"]) == 2
    assert payload["run"]["status"] == "completed"
    assert payload["run"]["finished_at"] is not None


def test_live_post_failure_does_not_abort_session(pytester: pytest.Pytester, monkeypatch):
    """best_effort_post raising must not kill the test session."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")

    pytester.makeconftest(
        """
        from pytest_agent_observability import uploader as up

        def _exploding(payload, config):
            raise RuntimeError("server down")

        up.best_effort_post = _exploding
        up.upload = lambda p, c, *, fallback_dir=None: True
        """
    )
    pytester.makepyfile("def test_fine(): assert True")
    result = pytester.runpytest("-p", "agent_observability")
    result.assert_outcomes(passed=1)
