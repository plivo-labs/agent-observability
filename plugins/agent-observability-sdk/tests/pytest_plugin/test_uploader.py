from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import httpx

from pytest_agent_observability.uploader import (
    UploadConfig,
    upload,
    config_from_env,
)


def _cfg(**kwargs) -> UploadConfig:
    return UploadConfig(url="http://localhost:9090", timeout_s=0.5, max_retries=1, **kwargs)


class _FakeClient:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        r = self._responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _resp(status, text=""):
    m = MagicMock()
    m.status_code = status
    m.text = text
    return m


def test_upload_success_returns_true(monkeypatch):
    fake = _FakeClient([_resp(201)])
    monkeypatch.setattr("httpx.Client", lambda **kw: fake)
    ok = upload({"run": {"run_id": "r1"}}, _cfg())
    assert ok is True
    url, _ = fake.calls[0]
    assert url == "http://localhost:9090/observability/evals/v0"


def test_upload_retries_on_5xx(monkeypatch, tmp_path):
    fake = _FakeClient([_resp(502, "bad gateway"), _resp(201)])
    monkeypatch.setattr("httpx.Client", lambda **kw: fake)
    monkeypatch.setattr("time.sleep", lambda _s: None)
    cfg = UploadConfig(url="http://x", timeout_s=0.5, max_retries=3)
    ok = upload({"run": {"run_id": "r1"}}, cfg)
    assert ok is True
    assert len(fake.calls) == 2


def test_upload_gives_up_on_4xx_no_retry(monkeypatch, tmp_path):
    fake = _FakeClient([_resp(400, "bad request")])
    monkeypatch.setattr("httpx.Client", lambda **kw: fake)
    monkeypatch.setattr("time.sleep", lambda _s: None)
    cfg = UploadConfig(url="http://x", timeout_s=0.5, max_retries=3)
    ok = upload(
        {"run": {"run_id": "r1"}},
        cfg,
        fallback_dir=tmp_path,
    )
    assert ok is False
    assert len(fake.calls) == 1  # no retries on 4xx
    # Fallback should have been written.
    assert (tmp_path / "r1.json").exists()


def test_upload_fallback_on_total_failure(monkeypatch, tmp_path):
    fake = _FakeClient([httpx.ConnectError("down"), httpx.ConnectError("still down"), httpx.ConnectError("nope")])
    monkeypatch.setattr("httpx.Client", lambda **kw: fake)
    monkeypatch.setattr("time.sleep", lambda _s: None)
    cfg = UploadConfig(url="http://x", timeout_s=0.5, max_retries=3)
    payload = {"run": {"run_id": "r99"}}

    ok = upload(payload, cfg, fallback_dir=tmp_path)
    assert ok is False
    fallback = tmp_path / "r99.json"
    assert fallback.exists()
    assert json.loads(fallback.read_text())["run"]["run_id"] == "r99"


def test_config_from_env_noop_without_url(monkeypatch):
    monkeypatch.delenv("AGENT_OBSERVABILITY_URL", raising=False)
    assert config_from_env() is None


def test_config_from_env_with_auth(monkeypatch):
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://x/")
    monkeypatch.setenv("AGENT_OBSERVABILITY_USER", "u")
    monkeypatch.setenv("AGENT_OBSERVABILITY_PASS", "p")
    cfg = config_from_env()
    assert cfg is not None
    assert cfg.url == "http://x"  # trailing slash stripped
    assert cfg.basic_auth == ("u", "p")
