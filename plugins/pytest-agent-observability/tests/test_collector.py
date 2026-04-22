from __future__ import annotations

from pytest_agent_observability import collector as col


def test_capture_without_active_test_is_noop():
    # No active test → calling capture() should not throw or store.
    col.clear_all_state()
    result = object()
    assert col.capture(result) is result


def test_capture_attaches_to_active_test():
    col.clear_all_state()
    token = col._set_current_test("test::foo")
    try:
        r1, r2 = object(), object()
        col.capture(r1)
        col.capture(r2)
        state = col.pop_state("test::foo")
        assert state is not None
        assert state.run_results == [r1, r2]
    finally:
        col._reset_current_test(token)


def test_capture_is_idempotent_for_same_object():
    col.clear_all_state()
    token = col._set_current_test("test::dedup")
    try:
        r = object()
        col.capture(r)
        col.capture(r)  # second call should no-op
        col.capture(r)
        state = col.pop_state("test::dedup")
        assert state is not None
        assert state.run_results == [r]
    finally:
        col._reset_current_test(token)


def test_record_judgment_stores_per_test():
    col.clear_all_state()
    token = col._set_current_test("test::bar")
    try:
        col._record_judgment(intent="greets politely", verdict="pass", reasoning="ok")
        col._record_judgment(intent="grounded", verdict="fail", reasoning="hallucinated")
        state = col.pop_state("test::bar")
        assert state is not None
        assert len(state.judgments) == 2
        assert state.judgments[0]["verdict"] == "pass"
        assert state.judgments[1]["reasoning"] == "hallucinated"
    finally:
        col._reset_current_test(token)


def test_record_judgment_without_active_test_is_noop():
    col.clear_all_state()
    col._record_judgment(intent="x", verdict="pass", reasoning="")
    # Nothing should be stored.
    assert col.pop_state("nonexistent") is None


def test_run_collector_factory():
    rc = col.RunCollector.new(started_at=1.0, ci={"provider": "github"})
    assert rc.run_id
    assert rc.started_at == 1.0
    assert rc.ci == {"provider": "github"}
    assert rc.cases == []
