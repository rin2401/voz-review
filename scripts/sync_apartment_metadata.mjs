// Sync apartment metadata (info + summary) from data/*.json into MongoDB.
// JSON stays the seed/source of truth; run this after editing the JSONs to
// publish changes without a full app rebuild.
//
// Usage: node --env-file=.env scripts/sync_apartment_metadata.mjs [--dry-run]

import { MongoClient } from "mongodb";
import rawInfo from "../data/apartment_info.json" with { type: "json" };
import rawSummaries from "../data/apartment_summaries.json" with { type: "json" };

const dryRun = process.argv.includes("--dry-run");
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || "voz_crawler";
if (!uri) {
  console.error("MONGODB_URI (or MONGO_URI) is required");
  process.exit(1);
}

const info = rawInfo;
const summaries = rawSummaries;

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 30000 });
await client.connect();
const db = client.db(dbName);

const names = new Set([...Object.keys(info), ...Object.keys(summaries)]);
let updated = 0;
let created = 0;
const now = new Date();

for (const name of names) {
  const existing = await db.collection("apartments").findOne({ name });
  const metadata = {
    info: info[name] ?? null,
    summary: summaries[name] ?? null,
    updated_at: now,
  };
  if (dryRun) {
    console.log("[dry-run] " + name + ": info=" + Boolean(metadata.info) + " summary=" + Boolean(metadata.summary) + (existing ? " update" : " create"));
    continue;
  }
  if (existing) {
    await db.collection("apartments").updateOne(
      { _id: existing._id },
      { $set: metadata },
    );
    updated += 1;
  } else {
    await db.collection("apartments").insertOne({
      name,
      aliases: [],
      ...metadata,
      created_at: now,
    });
    created += 1;
  }
}

console.log((dryRun ? "[dry-run] " : "") + "apartments: " + updated + " updated, " + created + " created");
await client.close();
