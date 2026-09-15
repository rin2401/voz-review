// Seed apartment (chung cư) crawl threads into the `threads` collection with
// kind=apartment so the hourly Worker crawl routes their posts into the
// apartment collections.
//
// Usage: node --env-file=.env scripts/seed_apartment_threads.mjs

import { MongoClient } from "mongodb";

const APARTMENT_THREAD_URLS = [
  "https://voz.vn/t/review-cac-du-an-chung-cu-o-sai-gon.189881/",
  "https://voz.vn/t/thao-luan-tong-hop-thong-tin-bds-mien-nam.1000443/",
  "https://voz.vn/t/cung-review-ve-chung-cu-can-ho-ma-cac-thim-dang-sinh-song.162980/",
];

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || "voz_crawler";
if (!uri) {
  console.error("MONGODB_URI (or MONGO_URI) is required");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 30000 });
await client.connect();
const db = client.db(dbName);
const now = new Date();

for (const url of APARTMENT_THREAD_URLS) {
  const threadId = url.match(/\/t(?:\/[^/]*?)?\.(\d+)(?:\/|$)/)?.[1] ?? null;
  const existing = await db.collection("threads").findOne({ url });
  if (existing) {
    await db.collection("threads").updateOne(
      { _id: existing._id },
      {
        $set: {
          kind: "apartment",
          thread_id: threadId ?? existing.thread_id ?? null,
          updated_at: now,
        },
      },
    );
    console.log(`updated: ${url} (kind=apartment)`);
  } else {
    await db.collection("threads").insertOne({
      url,
      title: url,
      thread_id: threadId,
      kind: "apartment",
      crawl_status: "idle",
      created_at: now,
      updated_at: now,
    });
    console.log(`inserted: ${url} (kind=apartment)`);
  }
}

await client.close();
