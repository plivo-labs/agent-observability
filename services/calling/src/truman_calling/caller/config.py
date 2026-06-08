from __future__ import annotations

from pathlib import Path

from pydantic import Field, field_validator

from truman_calling.core.settings import PROJECT_ROOT, CoreSettings

_PROJECT_ROOT = PROJECT_ROOT

AUDIO_SAMPLE_RATE = 8000


class Settings(CoreSettings):
    """Caller-process settings.

    Extends the shared ``CoreSettings`` (DB, Redis, Azure OpenAI, ElevenLabs,
    API token, log level) with the telephony + media fields only the outbound
    caller needs — Plivo creds, public callback URLs, Deepgram, and the local
    recording/transcript/eval directories. Shared fields are inherited, not
    re-declared, so there's a single source of truth for them.
    """

    plivo_auth_id: str
    plivo_auth_token: str
    plivo_from_number: str
    target_number: str
    # Verify X-Plivo-Signature-V3 on the public webhooks (/answer, /hangup,
    # /recording-callback). On by default; can be disabled (e.g. local testing
    # without a public-URL match) via PLIVO_VERIFY_SIGNATURE=false.
    plivo_verify_signature: bool = True

    public_base_url: str
    public_ws_base_url: str = ""

    http_host: str = "0.0.0.0"
    http_port: int = 9080
    audio_stream_port: int = 9766

    deepgram_base_url: str
    deepgram_api_key: str = "self-hosted"
    deepgram_model: str = "nova-2-phonecall"

    recordings_dir: Path = Field(default=_PROJECT_ROOT / "data" / "recordings")
    transcripts_dir: Path = Field(default=_PROJECT_ROOT / "data" / "transcripts")
    evals_dir: Path = Field(default=_PROJECT_ROOT / "data" / "evals")

    @field_validator("recordings_dir", "transcripts_dir", "evals_dir", mode="after")
    @classmethod
    def _resolve_against_project_root(cls, v: Path) -> Path:
        p = Path(v)
        if not p.is_absolute():
            p = _PROJECT_ROOT / p
        return p.resolve()

    @property
    def public_ws_url(self) -> str:
        if self.public_ws_base_url:
            base = self.public_ws_base_url.rstrip("/")
            if base.startswith("https://"):
                base = "wss://" + base[len("https://") :]
            elif base.startswith("http://"):
                base = "ws://" + base[len("http://") :]
            elif not (base.startswith("wss://") or base.startswith("ws://")):
                base = "wss://" + base
            return base + "/"
        host = self.public_base_url.removeprefix("https://").removeprefix("http://").rstrip("/")
        return f"wss://{host}/"

    @property
    def public_recording_callback_url(self) -> str:
        return f"{self.public_base_url.rstrip('/')}/recording-callback"

    @property
    def public_answer_url(self) -> str:
        return f"{self.public_base_url.rstrip('/')}/answer"


settings = Settings()

settings.recordings_dir.mkdir(parents=True, exist_ok=True)
settings.transcripts_dir.mkdir(parents=True, exist_ok=True)
settings.evals_dir.mkdir(parents=True, exist_ok=True)
