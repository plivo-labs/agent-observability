from __future__ import annotations

from pydantic import BaseModel

from truman_calling.api.schemas.common import StampedRead


class AgentCreate(BaseModel):
    name: str
    phone_number: str
    description: str | None = None
    provider: str = "custom"
    connection_type: str = "telephony_inbound"
    language: str = "en"
    external_assistant_id: str | None = None
    post_conversation_metadata: bool = False


class AgentUpdate(BaseModel):
    name: str | None = None
    phone_number: str | None = None
    description: str | None = None
    provider: str | None = None
    connection_type: str | None = None
    language: str | None = None
    external_assistant_id: str | None = None
    post_conversation_metadata: bool | None = None


class AgentRead(StampedRead):
    name: str
    phone_number: str
    description: str | None = None
    provider: str
    connection_type: str
    language: str
    external_assistant_id: str | None = None
    post_conversation_metadata: bool
