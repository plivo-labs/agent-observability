from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

orm_config = ConfigDict(from_attributes=True)


class StampedRead(BaseModel):
    model_config = orm_config
    id: UUID
    created_at: datetime
    updated_at: datetime
