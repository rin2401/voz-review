"""Beanie-first compatibility shim for environments without the package installed."""
from __future__ import annotations

from typing import Any

try:
    from beanie import Document, init_beanie  # type: ignore
except ModuleNotFoundError:
    from pydantic import BaseModel, ConfigDict, Field

    class _Query:
        def __init__(self, model_cls, query: dict | None = None):
            self.model_cls = model_cls
            self.query = query or {}
            self.sort_spec = None

        def sort(self, *args):
            if len(args) == 1:
                self.sort_spec = args[0]
            else:
                self.sort_spec = list(args)
            return self

        async def count(self) -> int:
            return await self.model_cls.get_motor_collection().count_documents(self.query)

        async def to_list(self) -> list[Any]:
            cursor = self.model_cls.get_motor_collection().find(self.query)
            if self.sort_spec:
                sort_spec = self.sort_spec
                if isinstance(sort_spec, str):
                    direction = -1 if sort_spec.startswith("-") else 1
                    sort_spec = [(sort_spec.lstrip("-"), direction)]
                cursor = cursor.sort(sort_spec)
            docs = await cursor.to_list(length=None)
            return [self.model_cls._from_mongo(doc) for doc in docs]

    class Document(BaseModel):
        id: Any = Field(default=None)
        model_config = ConfigDict(arbitrary_types_allowed=True, extra="allow")
        _motor_database = None

        @classmethod
        def get_settings_name(cls) -> str:
            settings = getattr(cls, "Settings", None)
            return getattr(settings, "name", cls.__name__.lower())

        @classmethod
        def get_motor_collection(cls):
            return cls._motor_database[cls.get_settings_name()]

        @classmethod
        def get_motor_database(cls):
            return cls._motor_database

        @classmethod
        async def find_one(cls, query: dict):
            doc = await cls.get_motor_collection().find_one(query)
            if doc is None:
                return None
            return cls._from_mongo(doc)

        @classmethod
        def find(cls, query: dict):
            return _Query(cls, query)

        @classmethod
        def find_all(cls):
            return _Query(cls, {})

        @classmethod
        def _from_mongo(cls, doc: dict):
            payload = dict(doc)
            payload["id"] = payload.pop("_id", None)
            return cls.model_validate(payload)

        def _to_mongo(self) -> dict:
            payload = self.model_dump(mode="python")
            mongo_id = payload.pop("id", None)
            if mongo_id is not None:
                payload["_id"] = mongo_id
            return payload

        async def insert(self):
            payload = self._to_mongo()
            payload.pop("_id", None)
            result = await self.get_motor_collection().insert_one(payload)
            self.id = result.inserted_id
            return self

        async def save(self):
            payload = self._to_mongo()
            mongo_id = payload.pop("_id", None)
            if mongo_id is None:
                result = await self.get_motor_collection().insert_one(payload)
                self.id = result.inserted_id
                return self
            await self.get_motor_collection().replace_one({"_id": mongo_id}, payload, upsert=True)
            return self

    async def init_beanie(database, document_models):
        for model in document_models:
            model._motor_database = database
