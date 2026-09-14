// MongoDB operations ported from database/mongodb.py (Beanie/motor helpers used
// by the crawler). Field lists and update semantics must stay compatible with
// the Python app since both write to the same Atlas collections.

import { MongoClient } from "mongodb";
import { companyAliasesForName, normalizeAliases, resolveCanonicalCompany } from "./aliases.js";

export const SCHEDULER_JOB_NAME = "crawl_all_threads";

let client = null;
let db = null;

export async function connect(uri, dbName) {
  if (client && db) return db;
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 30000 });
  await client.connect();
  db = client.db(dbName);
  return db;
}

export async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

export function getDb() {
  return db;
}

function isDuplicateKeyError(error) {
  return Boolean(error && (error.code === 11000 || String(error.message || "").includes("E11000")));
}

/** normalize_review_companies: companies list, falling back to legacy company. */
export function normalizeReviewCompanies(reviewDoc, { allowLegacyFallback = true } = {}) {
  const rawCompanies = reviewDoc.companies;
  const companies = Array.isArray(rawCompanies) ? rawCompanies : rawCompanies == null ? [] : [rawCompanies];
  const normalized = [];
  const seen = new Set();
  for (const rawCompany of companies) {
    const company = (rawCompany == null ? "" : String(rawCompany)).trim();
    if (!company || company === "Unknown") continue;
    const key = company.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(company);
  }
  if (normalized.length) return normalized;

  if (allowLegacyFallback) {
    const fallback = (reviewDoc.company || "").trim();
    if (fallback && fallback !== "Unknown") return [fallback];
  }
  return [];
}

export function primaryReviewCompany(reviewDoc, { default: defaultCompany = "Unknown", allowLegacyFallback = true } = {}) {
  const companies = normalizeReviewCompanies(reviewDoc, { allowLegacyFallback });
  return companies.length ? companies[0] : defaultCompany;
}

export function prepareReviewDocument(reviewDoc) {
  reviewDoc.companies = normalizeReviewCompanies(reviewDoc, { allowLegacyFallback: true });
  delete reviewDoc.company;
  return reviewDoc;
}

function normalizedCompanyAliasesForName(name) {
  return normalizeAliases(companyAliasesForName(name), name);
}

export async function upsertCompany(name) {
  const now = new Date();
  const companies = db.collection("companies");
  const existing = await companies.findOne({ name });
  if (existing) {
    await companies.updateOne(
      { _id: existing._id },
      { $set: { aliases: normalizedCompanyAliasesForName(name), updated_at: now } },
    );
    return { ...existing, aliases: normalizedCompanyAliasesForName(name), updated_at: now };
  }

  const payload = {
    name,
    aliases: normalizedCompanyAliasesForName(name),
    created_at: now,
    updated_at: now,
  };
  try {
    await companies.insertOne(payload);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const refetched = await companies.findOne({ name });
    if (refetched === null) throw error;
    await companies.updateOne(
      { _id: refetched._id },
      { $set: { aliases: normalizedCompanyAliasesForName(name), updated_at: now } },
    );
    return { ...refetched, aliases: normalizedCompanyAliasesForName(name), updated_at: now };
  }
  return payload;
}

export async function ensureCompaniesExist(companyNames) {
  const normalizedNames = [];
  const seen = new Set();
  for (const rawName of companyNames || []) {
    const name = (rawName || "").trim();
    if (!name || name === "Unknown") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedNames.push(name);
  }
  for (const companyName of normalizedNames) {
    await upsertCompany(companyName);
  }
  return normalizedNames;
}

export async function incrementCompanyReviewCount(companyName) {
  await upsertCompany(companyName);
}

export async function insertReview(reviewData) {
  const reviews = db.collection("reviews");
  prepareReviewDocument(reviewData);
  await ensureCompaniesExist(reviewData.companies || []);
  reviewData.created_at = new Date();
  reviewData.status = reviewData.status || "pending";
  try {
    const result = await reviews.insertOne(reviewData);
    return { insertedId: result.insertedId, inserted: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) return { insertedId: null, inserted: false };
    throw error;
  }
}

export async function upsertOffer(offerData) {
  const offers = db.collection("offers");
  const vozPostId = offerData.voz_post_id;
  const offerIndex = offerData.offer_index;
  const company = offerData.company;
  if (!vozPostId || offerIndex === null || offerIndex === undefined || !company || company === "Unknown") {
    return { vozPostId: null, created: false };
  }

  const now = new Date();
  let document = await offers.findOne({ voz_post_id: vozPostId, offer_index: offerIndex });
  let created = document === null;
  if (document === null) {
    const payload = { ...offerData };
    delete payload.created_at;
    payload.created_at = now;
    payload.updated_at = now;
    try {
      await offers.insertOne(payload);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      document = await offers.findOne({ voz_post_id: vozPostId, offer_index: offerIndex });
      created = false;
    }
  }
  if (document === null) return { vozPostId: null, created: false };

  const updateSet = {};
  for (const [key, value] of Object.entries(offerData)) {
    if (key === "created_at") continue;
    updateSet[key] = value;
  }
  updateSet.updated_at = now;
  if (!created) {
    await offers.updateOne({ _id: document._id }, { $set: updateSet });
  }
  return { vozPostId, created };
}

export async function syncOffersForPost(vozPostId, offerDocs) {
  if (!vozPostId) return { upserted: 0, created: 0, deleted: 0 };

  const normalizedOfferDocs = [];
  const seenIndexes = new Set();
  for (let fallbackIndex = 0; fallbackIndex < (offerDocs || []).length; fallbackIndex++) {
    const offerDoc = offerDocs[fallbackIndex];
    const company = offerDoc.company;
    if (!company || company === "Unknown") continue;
    let offerIndex = offerDoc.offer_index;
    if (offerIndex === null || offerIndex === undefined) {
      offerIndex = fallbackIndex;
      offerDoc.offer_index = offerIndex;
    }
    if (seenIndexes.has(offerIndex)) continue;
    seenIndexes.add(offerIndex);
    normalizedOfferDocs.push(offerDoc);
  }

  await ensureCompaniesExist(normalizedOfferDocs.map((offerDoc) => offerDoc.company));

  let createdCount = 0;
  let upsertedCount = 0;
  for (const offerDoc of normalizedOfferDocs) {
    const { created } = await upsertOffer(offerDoc);
    upsertedCount += 1;
    if (created) createdCount += 1;
  }

  const staleOfferDocs = await db
    .collection("offers")
    .find({ voz_post_id: vozPostId, offer_index: { $nin: [...seenIndexes] } })
    .toArray();
  for (const staleOffer of staleOfferDocs) {
    await db.collection("offers").deleteOne({ _id: staleOffer._id });
  }
  return { upserted: upsertedCount, created: createdCount, deleted: staleOfferDocs.length };
}

export async function getThreadState({ threadId = null, url = null } = {}) {
  const query = {};
  if (threadId) query.thread_id = threadId;
  else if (url) query.url = url;
  else return null;
  return db.collection("threads").findOne(query);
}

export async function updateThreadState({ threadId = null, url = null, lastPostDate = null, lastPage = null } = {}) {
  const query = {};
  if (threadId) query.thread_id = threadId;
  else if (url) query.url = url;
  else return;

  const document = await db.collection("threads").findOne(query);
  if (document === null) return;
  const now = new Date();
  await db.collection("threads").updateOne(
    { _id: document._id },
    {
      $set: {
        last_crawl: now,
        last_post_date: lastPostDate,
        last_page: lastPage,
        updated_at: now,
      },
    },
  );
}

export async function setThreadCrawlStatus(url, status, error = null) {
  const threads = db.collection("threads");
  const now = new Date();
  const document = await threads.findOne({ url });
  if (document === null) {
    await threads.insertOne({
      url,
      title: url,
      crawl_status: status,
      crawl_error: status === "running" ? null : error,
      created_at: now,
      updated_at: now,
    });
    return;
  }

  const updateSet = { crawl_status: status, updated_at: now };
  if (status === "running") updateSet.crawl_error = null;
  else if (error) updateSet.crawl_error = error;
  await threads.updateOne({ _id: document._id }, { $set: updateSet });
}

export async function getAllThreads() {
  return db.collection("threads").find({}).sort({ created_at: -1 }).toArray();
}

export async function ensureSchedulerState({ jobName, timezone, enabled, nextRunAt = null }) {
  const now = new Date();
  return db.collection("scheduler_states").findOneAndUpdate(
    { job_name: jobName },
    {
      $setOnInsert: {
        job_name: jobName,
        schedule_kind: "hourly",
        schedule_minute: 0,
        created_at: now,
        last_status: "idle",
      },
      $set: {
        timezone,
        enabled,
        next_run_at: nextRunAt,
        updated_at: now,
      },
    },
    { returnDocument: "after", upsert: true },
  );
}

export async function tryAcquireSchedulerLock({
  jobName,
  reason,
  timezone,
  enabled,
  lockUntil,
  nextRunAt = null,
}) {
  const now = new Date();
  return db.collection("scheduler_states").findOneAndUpdate(
    {
      job_name: jobName,
      $or: [
        { lock_until: { $exists: false } },
        { lock_until: null },
        { lock_until: { $lte: now } },
      ],
    },
    {
      $set: {
        timezone,
        enabled,
        next_run_at: nextRunAt,
        lock_until: lockUntil,
        current_run_started_at: now,
        current_run_reason: reason,
        last_started_at: now,
        last_status: "running",
        last_result: null,
        last_error: null,
        updated_at: now,
      },
    },
    { returnDocument: "after" },
  );
}

export async function completeSchedulerRun({ jobName, status, result = null, error = null, nextRunAt = null }) {
  const now = new Date();
  return db.collection("scheduler_states").findOneAndUpdate(
    { job_name: jobName },
    {
      $set: {
        last_status: status,
        last_result: result,
        last_error: error,
        last_finished_at: now,
        next_run_at: nextRunAt,
        updated_at: now,
      },
      $unset: {
        lock_until: "",
        current_run_started_at: "",
        current_run_reason: "",
      },
    },
    { returnDocument: "after" },
  );
}

export { resolveCanonicalCompany };
