from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_project_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".env").exists() or (parent / ".env.example").exists():
            return parent
    return here.parent


_PROJECT_ROOT = _find_project_root()


class CoreSettings(BaseSettings):
    """Settings shared between api, caller, and migrations. Other apps may extend."""

    model_config = SettingsConfigDict(
        env_file=_PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    database_url: str
    redis_url: str = "redis://localhost:6479/0"
    truman_api_token: str = ""

    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_api_version: str = "2024-12-01-preview"
    azure_openai_persona_deployment: str = "gpt-4.1-mini"
    azure_openai_judge_deployment: str = "gpt-4.1-mini"

    # ElevenLabs — TTS for the synthetic caller. The voices library route
    # proxies through the REST endpoint derived from this base URL (wss→https).
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = ""
    elevenlabs_model_id: str = "eleven_turbo_v2_5"
    elevenlabs_base_url: str = "wss://api.elevenlabs.io/v1"

    log_level: str = "INFO"

    @property
    def elevenlabs_rest_base_url(self) -> str:
        """Derive the REST base URL from the WebSocket base URL. The voices
        listing endpoint requires HTTPS, but caller config exposes the
        WSS form for TTS streaming — we translate scheme here."""
        base = self.elevenlabs_base_url
        if base.startswith("wss://"):
            return "https://" + base[len("wss://") :]
        if base.startswith("ws://"):
            return "http://" + base[len("ws://") :]
        return base

    @property
    def sync_database_url(self) -> str:
        """psycopg3 uses the same URL scheme for sync + async — picked by
        create_engine vs create_async_engine. Returned as-is."""
        return self.database_url

    @property
    def async_database_url(self) -> str:
        return self.database_url


settings = CoreSettings()
PROJECT_ROOT = _PROJECT_ROOT
