from __future__ import annotations

import uuid
from typing import Any, Generic, Type, TypeVar

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.core.models import Base

TModel = TypeVar("TModel", bound=Base)
TCreate = TypeVar("TCreate", bound=BaseModel)
TUpdate = TypeVar("TUpdate", bound=BaseModel)


class CrudService(Generic[TModel, TCreate, TUpdate]):
    def __init__(self, model: Type[TModel]) -> None:
        self.model = model

    async def list(self, session: AsyncSession, org_id: uuid.UUID) -> list[TModel]:
        result = await session.execute(
            select(self.model)
            .where(self.model.org_id == org_id)
            .order_by(self.model.id.desc() if not hasattr(self.model, "created_at") else self.model.created_at.desc())
        )
        return list(result.scalars().all())

    async def get(
        self, session: AsyncSession, org_id: uuid.UUID, obj_id: uuid.UUID
    ) -> TModel:
        result = await session.execute(
            select(self.model).where(
                self.model.id == obj_id, self.model.org_id == org_id
            )
        )
        obj = result.scalar_one_or_none()
        if obj is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{self.model.__tablename__[:-1]} not found")
        return obj

    async def create(
        self, session: AsyncSession, org_id: uuid.UUID, payload: TCreate
    ) -> TModel:
        data = payload.model_dump()
        obj = self.model(org_id=org_id, **data)
        session.add(obj)
        await session.commit()
        await session.refresh(obj)
        return obj

    async def update(
        self,
        session: AsyncSession,
        org_id: uuid.UUID,
        obj_id: uuid.UUID,
        payload: TUpdate,
    ) -> TModel:
        obj = await self.get(session, org_id, obj_id)
        data: dict[str, Any] = payload.model_dump(exclude_unset=True)
        for key, value in data.items():
            setattr(obj, key, value)
        await session.commit()
        await session.refresh(obj)
        return obj

    async def delete(
        self, session: AsyncSession, org_id: uuid.UUID, obj_id: uuid.UUID
    ) -> None:
        obj = await self.get(session, org_id, obj_id)
        await session.delete(obj)
        await session.commit()
