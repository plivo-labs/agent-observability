from __future__ import annotations

from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

def _find_project_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".env").exists() or (parent / ".env.example").exists():
            return parent
    return here.parent


_PROJECT_ROOT = _find_project_root()

AUDIO_SAMPLE_RATE = 8000


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    plivo_auth_id: str
    plivo_auth_token: str
    plivo_from_number: str
    target_number: str

    public_base_url: str
    public_ws_base_url: str = ""

    http_host: str = "0.0.0.0"
    http_port: int = 9080
    audio_stream_port: int = 9766

    deepgram_base_url: str
    deepgram_api_key: str = "self-hosted"
    deepgram_model: str = "nova-2-phonecall"

    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    elevenlabs_model_id: str = "eleven_turbo_v2_5"
    elevenlabs_base_url: str = ""

    azure_openai_endpoint: str
    azure_openai_api_key: str
    azure_openai_api_version: str = "2024-12-01-preview"
    azure_openai_persona_deployment: str = "gpt-4o"
    azure_openai_judge_deployment: str = "gpt-4o"

    recordings_dir: Path = Field(default=_PROJECT_ROOT / "data" / "recordings")
    transcripts_dir: Path = Field(default=_PROJECT_ROOT / "data" / "transcripts")
    evals_dir: Path = Field(default=_PROJECT_ROOT / "data" / "evals")

    log_level: str = "INFO"

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
