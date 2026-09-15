// Backfill apartment names for apartment_reviews inserted before the
// numbered-label extractor fix: re-run the extractor over stored content and
// $set the apartments field, upserting matching `apartments` docs.
//
// Usage: node --env-file=.env scripts/backfill_apartment_names.mjs [--dry-run]

import { MongoClient } from "mongodb";
import { defaultApartmentExtractor } from "../workers/crawler/apartment-extract.js";
import { apartmentAliasesForName } from "../workers/crawler/aliases.js";

const dryRun = process.argv.includes("--dry-run");
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || "voz_crawler";
if (!uri) {
  console.error("MONGODB_URI (or MONGO_URI) is required");
  process.exit(1);
}

const extractor = defaultApartmentExtractor;

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 30000 });
await client.connect();
const db = client.db(dbName);

async function upsertApartment(name) {
  const now = new Date();
  const existing = await db.collection("apartments").findOne({ name });
  const aliases = apartmentAliasesForName(name);
  if (existing) {
    await db
      .collection("apartments")
      .updateOne({ _id: existing._id }, { $set: { aliases, updated_at: now } });
    return;
  }
  await db.collection("apartments").insertOne({
    name,
    aliases,
    created_at: now,
    updated_at: now,
  });
}

const docs = await db
  .collection("apartment_reviews")
  .find({ $or: [{ apartments: { $exists: false } }, { apartments: { $size: 0 } }] })
  .toArray();
console.log(`reviews without apartment name: ${docs.length}`);

let updated = 0;
for (const doc of docs) {
  const apartments = extractor.extractApartments(String(doc.content || ""));
  if (!apartments.length) continue;
  if (!dryRun) {
    await db.collection("apartment_reviews").updateOne(
      { _id: doc._id },
      { $set: { apartments } },
    );
    for (const name of apartments) await upsertApartment(name);
  }
  updated += 1;
  console.log(`  ${doc.voz_post_id}: ${apartments.join(", ")}`);
}

console.log(`${dryRun ? "[dry-run] " : ""}updated: ${updated}/${docs.length}`);
await client.close();
