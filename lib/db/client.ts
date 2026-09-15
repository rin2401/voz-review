// Shared MongoDB client for Next.js route handlers and server components.
// globalThis cache survives hot reload in dev and keeps a single connection
// pool per serverless function instance in production.

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || process.env.MONGO_DB || "voz_crawler";

type MongoGlobal = typeof globalThis & {
  __vozReviewMongo?: Promise<MongoClient>;
};

const globalWithMongo = globalThis as MongoGlobal;

export async function getMongoClient(): Promise<MongoClient> {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }
  if (!globalWithMongo.__vozReviewMongo) {
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
    });
    globalWithMongo.__vozReviewMongo = client.connect();
  }
  return globalWithMongo.__vozReviewMongo;
}

export async function getDb() {
  const client = await getMongoClient();
  return client.db(MONGODB_DB);
}
