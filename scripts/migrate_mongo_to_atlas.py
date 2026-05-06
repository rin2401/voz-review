"""Copy MongoDB collections from a source database to MongoDB Atlas.

Required destination can be supplied with --dest-uri, ATLAS_MONGO_URI,
MONGODB_ATLAS_URI, or DEST_MONGO_URI.
"""
from __future__ import annotations

import argparse
import os
from collections.abc import Iterable

from pymongo import MongoClient, UpdateOne
from pymongo.database import Database


DEFAULT_COLLECTIONS = [
    "reviews",
    "companies",
    "threads",
    "scheduler_states",
    "offers",
]


def _env_first(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


def _copy_indexes(source: Database, dest: Database, collection_name: str) -> None:
    existing_dest_indexes = set(dest[collection_name].index_information())
    for index in source[collection_name].list_indexes():
        index_doc = dict(index)
        name = index_doc.pop("name", None)
        key = index_doc.pop("key", None)
        index_doc.pop("v", None)
        if not name or name == "_id_" or name in existing_dest_indexes:
            continue
        dest[collection_name].create_index(list(key.items()), name=name, **index_doc)


def _copy_collection(
    source: Database,
    dest: Database,
    collection_name: str,
    batch_size: int,
    drop_dest: bool,
) -> int:
    if drop_dest:
        dest[collection_name].drop()

    copied_count = 0
    batch: list[UpdateOne] = []
    print(f"Copying {collection_name}...", flush=True)
    cursor = source[collection_name].find({}, no_cursor_timeout=True).batch_size(batch_size)
    try:
        for document in cursor:
            batch.append(_upsert_operation(collection_name, document))
            if len(batch) >= batch_size:
                dest[collection_name].bulk_write(batch, ordered=False)
                copied_count += len(batch)
                print(f"Copied {copied_count} documents from {collection_name}", flush=True)
                batch.clear()
        if batch:
            dest[collection_name].bulk_write(batch, ordered=False)
            copied_count += len(batch)
            print(f"Copied {copied_count} documents from {collection_name}", flush=True)
    finally:
        cursor.close()

    _copy_indexes(source, dest, collection_name)
    return copied_count


def _parse_collections(raw_collections: str | None, source_db: Database) -> list[str]:
    if raw_collections:
        return [name.strip() for name in raw_collections.split(",") if name.strip()]
    existing = set(source_db.list_collection_names())
    return [name for name in DEFAULT_COLLECTIONS if name in existing]


def _document_match_filter(collection_name: str, document: dict) -> dict:
    if collection_name == "reviews" and document.get("voz_post_id"):
        return {"voz_post_id": document["voz_post_id"]}
    if collection_name == "companies" and document.get("name"):
        return {"name": document["name"]}
    if collection_name == "threads" and document.get("url"):
        return {"url": document["url"]}
    if collection_name == "scheduler_states" and document.get("job_name"):
        return {"job_name": document["job_name"]}
    if collection_name == "offers" and document.get("voz_post_id") and document.get("offer_index") is not None:
        return {
            "voz_post_id": document["voz_post_id"],
            "offer_index": document["offer_index"],
        }
    return {"_id": document["_id"]}


def _upsert_operation(collection_name: str, document: dict) -> UpdateOne:
    update_fields = dict(document)
    document_id = update_fields.pop("_id")
    return UpdateOne(
        _document_match_filter(collection_name, document),
        {
            "$set": update_fields,
            "$setOnInsert": {"_id": document_id},
        },
        upsert=True,
    )


def migrate(
    source_uri: str,
    source_db_name: str,
    dest_uri: str,
    dest_db_name: str,
    collections: Iterable[str],
    batch_size: int,
    drop_dest: bool,
    server_selection_timeout_ms: int,
) -> None:
    source_client = MongoClient(source_uri, serverSelectionTimeoutMS=server_selection_timeout_ms)
    dest_client = MongoClient(dest_uri, serverSelectionTimeoutMS=server_selection_timeout_ms)
    try:
        print("Checking source MongoDB connection...", flush=True)
        source_client.admin.command("ping")
        print("Checking destination MongoDB Atlas connection...", flush=True)
        dest_client.admin.command("ping")
        source_db = source_client[source_db_name]
        dest_db = dest_client[dest_db_name]

        for collection_name in collections:
            count = _copy_collection(source_db, dest_db, collection_name, batch_size, drop_dest)
            print(f"Copied {count} documents from {source_db_name}.{collection_name} to {dest_db_name}.{collection_name}")
    finally:
        source_client.close()
        dest_client.close()


def verify_counts(
    source_uri: str,
    source_db_name: str,
    dest_uri: str,
    dest_db_name: str,
    collections: Iterable[str],
    server_selection_timeout_ms: int,
) -> None:
    source_client = MongoClient(source_uri, serverSelectionTimeoutMS=server_selection_timeout_ms)
    dest_client = MongoClient(dest_uri, serverSelectionTimeoutMS=server_selection_timeout_ms)
    try:
        source_db = source_client[source_db_name]
        dest_db = dest_client[dest_db_name]
        print("collection,source_count,destination_count,match", flush=True)
        for collection_name in collections:
            source_count = source_db[collection_name].count_documents({})
            dest_count = dest_db[collection_name].count_documents({})
            print(
                f"{collection_name},{source_count},{dest_count},{source_count == dest_count}",
                flush=True,
            )
    finally:
        source_client.close()
        dest_client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Copy local MongoDB data to MongoDB Atlas.")
    parser.add_argument("--source-uri", default=_env_first("SOURCE_MONGO_URI", "LOCAL_MONGO_URI") or "mongodb://localhost:27017")
    parser.add_argument("--source-db", default=_env_first("SOURCE_MONGO_DB", "MONGO_DB", "MONGODB_DB") or "voz_crawler")
    parser.add_argument("--dest-uri", default=_env_first("ATLAS_MONGO_URI", "MONGODB_ATLAS_URI", "DEST_MONGO_URI"))
    parser.add_argument("--dest-db", default=_env_first("ATLAS_MONGO_DB", "DEST_MONGO_DB", "MONGO_DB", "MONGODB_DB") or "voz_crawler")
    parser.add_argument("--collections", help="Comma-separated collection names. Defaults to app collections present in source.")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--drop-dest", action="store_true", help="Drop destination collections before copying.")
    parser.add_argument("--server-selection-timeout-ms", type=int, default=10000)
    parser.add_argument("--verify-only", action="store_true", help="Only compare source and destination document counts.")
    args = parser.parse_args()

    if not args.dest_uri:
        parser.error("destination URI is required via --dest-uri, ATLAS_MONGO_URI, MONGODB_ATLAS_URI, or DEST_MONGO_URI")

    source_client = MongoClient(args.source_uri)
    try:
        source_db = source_client[args.source_db]
        collections = _parse_collections(args.collections, source_db)
    finally:
        source_client.close()

    if args.verify_only:
        verify_counts(
            source_uri=args.source_uri,
            source_db_name=args.source_db,
            dest_uri=args.dest_uri,
            dest_db_name=args.dest_db,
            collections=collections,
            server_selection_timeout_ms=args.server_selection_timeout_ms,
        )
        return

    migrate(
        source_uri=args.source_uri,
        source_db_name=args.source_db,
        dest_uri=args.dest_uri,
        dest_db_name=args.dest_db,
        collections=collections,
        batch_size=args.batch_size,
        drop_dest=args.drop_dest,
        server_selection_timeout_ms=args.server_selection_timeout_ms,
    )


if __name__ == "__main__":
    main()
