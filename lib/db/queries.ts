// Read/write query helpers ported 1:1 from database/mongodb.py (motor/Beanie)
// to the npm mongodb driver. Aggregation pipelines and sort semantics must
// stay identical because the Python app and the Cloudflare Worker crawler
// share the same Atlas collections.

import type { Db } from "mongodb";
import { normalizeAliases as normalizeAliasesJs } from "../../workers/crawler/aliases.js";
import {
  normalizeReviewCompanies,
  prepareReviewDocument,
} from "../../workers/crawler/mongo.js";
import { getDb } from "./client";

export const SCHEDULER_JOB_NAME = "crawl_all_threads";

export type Dict = Record<string, any>;

// The crawler helpers are plain JS; give the alias normalizer a typed wrapper.
const normalizeAliases = (rawAliases: any, canonicalName: string | null = null): string[] =>
  normalizeAliasesJs(rawAliases, canonicalName as any);

function coerceString(value: any): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function coerceDatetime(value: any): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const parsed = new Date(value.replace(/Z$/, "+00:00").replace(/Z$/, ""));
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============== company match helpers ==============

export function buildCompanyMatch(company: string): Dict {
  const escaped = escapeRegex(company);
  const companyRegex = { $regex: `^${escaped}$`, $options: "i" };
  return {
    $or: [
      { companies: companyRegex },
      {
        $and: [
          { $or: [{ companies: { $exists: false } }, { companies: { $size: 0 } }] },
          { company: companyRegex },
        ],
      },
    ],
  };
}

export function buildKnownCompanyQuery(): Dict {
  return {
    $or: [
      { "companies.0": { $exists: true } },
      {
        $and: [
          { $or: [{ companies: { $exists: false } }, { companies: { $size: 0 } }] },
          { company: { $exists: true, $nin: [null, "", "Unknown"] } },
        ],
      },
    ],
  };
}

// ============== company aggregation ==============

export function buildCompanyAggregationPipeline(): Dict[] {
  return [
    {
      $project: {
        created_at: {
          $convert: { input: "$created_at", to: "date", onError: null, onNull: null },
        },
        effective_post_date: {
          $ifNull: [
            { $convert: { input: "$post_date", to: "date", onError: null, onNull: null } },
            { $convert: { input: "$created_at", to: "date", onError: null, onNull: null } },
          ],
        },
        monthly_salary_million: {
          $convert: { input: "$monthly_salary_million", to: "double", onError: null, onNull: null },
        },
        companies_for_aggregation: {
          $let: {
            vars: {
              legacy_company: {
                $trim: {
                  input: { $convert: { input: "$company", to: "string", onError: "", onNull: "" } },
                },
              },
              normalized_companies: {
                $cond: [
                  { $isArray: "$companies" },
                  {
                    $filter: {
                      input: {
                        $map: {
                          input: "$companies",
                          as: "company",
                          in: {
                            $trim: {
                              input: {
                                $convert: { input: "$$company", to: "string", onError: "", onNull: "" },
                              },
                            },
                          },
                        },
                      },
                      as: "company",
                      cond: {
                        $and: [
                          { $ne: ["$$company", ""] },
                          { $ne: ["$$company", "Unknown"] },
                        ],
                      },
                    },
                  },
                  [],
                ],
              },
            },
            in: {
              $cond: [
                { $gt: [{ $size: "$$normalized_companies" }, 0] },
                { $setUnion: ["$$normalized_companies", []] },
                {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$$legacy_company", ""] },
                        { $ne: ["$$legacy_company", "Unknown"] },
                      ],
                    },
                    ["$$legacy_company"],
                    [],
                  ],
                },
              ],
            },
          },
        },
      },
    },
    { $unwind: "$companies_for_aggregation" },
    {
      $group: {
        _id: "$companies_for_aggregation",
        review_count: { $sum: 1 },
        latest_review: { $max: "$effective_post_date" },
        created_at: { $min: "$created_at" },
        max_monthly_salary_million: { $max: "$monthly_salary_million" },
      },
    },
  ];
}

export async function getAllCompanies(sortBy = "recent_review"): Promise<Dict[]> {
  const db = await getDb();
  const docs = (await db.collection("companies").find({}).toArray()).map(
    (doc) => ({ ...doc, _id: undefined }) as Dict,
  );
  if (!docs.length) return [];

  const companyNames = docs.map((doc) => doc.name).filter(Boolean);
  const aggregatesByCompany: Record<string, Dict> = {};
  for (const name of companyNames) {
    aggregatesByCompany[name] = {
      review_count: 0,
      latest_post_date: null,
      max_monthly_salary_million: null,
    };
  }

  const reviewPipeline = [
    ...buildCompanyAggregationPipeline(),
    { $match: { _id: { $in: companyNames } } },
    { $project: { _id: 1, review_count: 1, latest_review: 1 } },
  ];
  for (const row of await db.collection("reviews").aggregate(reviewPipeline).toArray()) {
    const name = coerceString(row._id);
    if (!name) continue;
    aggregatesByCompany[name] = {
      review_count: Number(row.review_count || 0),
      latest_post_date: coerceDatetime(row.latest_review),
      max_monthly_salary_million: null,
    };
  }

  const offersPipeline = [
    { $match: { company: { $in: companyNames } } },
    { $group: { _id: "$company", max_monthly_salary_million: { $max: "$monthly_salary_million" } } },
  ];
  for (const row of await db.collection("offers").aggregate(offersPipeline).toArray()) {
    const name = coerceString(row._id);
    if (name in aggregatesByCompany) {
      aggregatesByCompany[name].max_monthly_salary_million = row.max_monthly_salary_million;
    }
  }

  const companies: Dict[] = [];
  for (const company of docs) {
    const companyName = company.name;
    const aggregate = aggregatesByCompany[companyName] || {};
    company.aliases = normalizeAliases(company.aliases || [], companyName);
    company.review_count = Number(aggregate.review_count || 0);
    company.latest_post_date = aggregate.latest_post_date ?? null;
    company.max_monthly_salary_million = aggregate.max_monthly_salary_million ?? null;
    companies.push(company);
  }

  // Python sorts by tuple key with reverse=True, which reverses EVERY tuple
  // component including the name tie-break. Replicate that exactly.
  const nameLower = (c: Dict) => String(c.name || "").toLowerCase();
  // Python compares strings by codepoint, not locale collation.
  const cmpDesc = (a: string, b: string) => (a > b ? -1 : a < b ? 1 : 0);
  const dateMs = (value: any) => {
    const date = coerceDatetime(value);
    return date ? date.getTime() : 0;
  };
  if (sortBy === "most_review") {
    companies.sort((a, b) => (b.review_count || 0) - (a.review_count || 0) || cmpDesc(nameLower(a), nameLower(b)));
  } else if (sortBy === "recent_review") {
    companies.sort((a, b) => {
      const aDate = dateMs(a.latest_post_date);
      const bDate = dateMs(b.latest_post_date);
      if (Boolean(aDate) !== Boolean(bDate)) return aDate ? -1 : 1;
      if (aDate && bDate && aDate !== bDate) return bDate - aDate;
      return cmpDesc(nameLower(a), nameLower(b));
    });
  } else if (sortBy === "salary_desc") {
    companies.sort((a, b) => {
      const aSalary = a.max_monthly_salary_million;
      const bSalary = b.max_monthly_salary_million;
      if (Boolean(aSalary) !== Boolean(bSalary)) return aSalary ? -1 : 1;
      if (aSalary && bSalary && aSalary !== bSalary) return bSalary - aSalary;
      if ((a.review_count || 0) !== (b.review_count || 0)) {
        return (b.review_count || 0) - (a.review_count || 0);
      }
      return cmpDesc(nameLower(a), nameLower(b));
    });
  } else {
    companies.sort((a, b) => (nameLower(a) < nameLower(b) ? -1 : nameLower(a) > nameLower(b) ? 1 : 0));
  }

  return companies;
}

export async function resolveCompanyName(slugOrName: string): Promise<string> {
  const companies = await getAllCompanies("az");
  const names = companies.map((company) => company.name || "");

  if (names.includes(slugOrName)) return slugOrName;

  const normalized = (slugOrName || "").replace(/-/g, " ");
  if (names.includes(normalized)) return normalized;

  const lowerMap = new Map(names.map((name) => [name.toLowerCase(), name]));
  return lowerMap.get(normalized.toLowerCase()) ?? slugOrName;
}

// ============== reviews ==============

export async function getReviewsByCompany(
  company: string,
  options: {
    limit?: number;
    skip?: number;
    status?: string;
    threadId?: string;
    salaryOnly?: boolean;
    interviewOnly?: boolean;
  } = {},
): Promise<Dict[]> {
  const { limit = 50, skip = 0, status, threadId, salaryOnly, interviewOnly } = options;
  const db = await getDb();
  const query: Dict = buildCompanyMatch(company);
  if (status) query.status = status;
  if (threadId) query.voz_thread_id = threadId;
  if (salaryOnly) query.content = { $regex: "lương", $options: "i" };
  if (interviewOnly) query.content = { $regex: "phỏng vấn", $options: "i" };

  const documents = await db
    .collection("reviews")
    .find(query)
    .sort({ post_date: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  return documents.map((doc) => prepareReviewDocument({ ...doc, _id: undefined }));
}

export async function getReviewCount(
  options: { company?: string; status?: string; threadId?: string; salaryOnly?: boolean; interviewOnly?: boolean } = {},
): Promise<number> {
  const db = await getDb();
  const query: Dict = options.company ? buildCompanyMatch(options.company) : {};
  if (options.status) query.status = options.status;
  if (options.threadId) query.voz_thread_id = options.threadId;
  if (options.salaryOnly) query.content = { $regex: "lương", $options: "i" };
  if (options.interviewOnly) query.content = { $regex: "phỏng vấn", $options: "i" };
  return db.collection("reviews").countDocuments(query);
}

export async function getCompanyReviewCount(): Promise<number> {
  const db = await getDb();
  return db.collection("reviews").countDocuments(buildKnownCompanyQuery());
}

export async function searchReviews(keyword: string, limit = 50, skip = 0): Promise<Dict[]> {
  const db = await getDb();
  const results = await db
    .collection("reviews")
    .find({ $text: { $search: keyword } })
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  return results.map((doc) => prepareReviewDocument({ ...doc, _id: undefined }));
}

export async function insertReview(reviewData: Dict): Promise<{ insertedId: string | null; inserted: boolean }> {
  const db = await getDb();
  prepareReviewDocument(reviewData);
  const companies = normalizeReviewCompanies(reviewData, { allowLegacyFallback: true });
  await ensureCompaniesExist(companies);
  reviewData.created_at = new Date();
  reviewData.status = reviewData.status || "pending";
  try {
    const result = await db.collection("reviews").insertOne(reviewData);
    return { insertedId: String(result.insertedId), inserted: true };
  } catch (error: any) {
    if (error && (error.code === 11000 || String(error.message || "").includes("E11000"))) {
      return { insertedId: null, inserted: false };
    }
    throw error;
  }
}

async function ensureCompaniesExist(companyNames: string[]): Promise<string[]> {
  const db = await getDb();
  const normalizedNames: string[] = [];
  const seen = new Set<string>();
  for (const rawName of companyNames) {
    const name = (rawName || "").trim();
    if (!name || name === "Unknown") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedNames.push(name);
  }
  for (const companyName of normalizedNames) {
    const now = new Date();
    const existing = await db.collection("companies").findOne({ name: companyName });
    if (existing) {
      await db
        .collection("companies")
        .updateOne({ _id: existing._id }, { $set: { updated_at: now } });
    } else {
      await db.collection("companies").insertOne({
        name: companyName,
        aliases: normalizeAliases([], companyName),
        created_at: now,
        updated_at: now,
      });
    }
  }
  return normalizedNames;
}

// ============== reply tree ==============

export async function getPostsByIds(postIds: string[]): Promise<Dict[]> {
  if (!postIds.length) return [];
  const db = await getDb();
  const documents = await db.collection("reviews").find({ voz_post_id: { $in: postIds } }).toArray();
  return documents.map((doc) => prepareReviewDocument({ ...doc, _id: undefined }));
}

export async function getRepliesForPosts(postIds: string[]): Promise<Dict[]> {
  if (!postIds.length) return [];
  const db = await getDb();
  const documents = await db
    .collection("reviews")
    .find({ reply_post_id: { $in: postIds } })
    .sort({ created_at: 1 })
    .toArray();
  return documents.map((doc) => prepareReviewDocument({ ...doc, _id: undefined }));
}

export async function getCompanyThreadIds(company: string): Promise<string[]> {
  const db = await getDb();
  const ids = await db
    .collection("reviews")
    .distinct("voz_thread_id", {
      ...buildCompanyMatch(company),
      voz_thread_id: { $exists: true, $nin: [null, ""] },
    });
  return ids.filter(Boolean).map(String).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

// ============== offers ==============

export function buildOfferQuery(
  options: { company?: string; threadId?: string; positionKeyword?: string } = {},
): Dict {
  const query: Dict = {};
  if (options.company) {
    query.company = { $regex: `^${escapeRegex(options.company)}$`, $options: "i" };
  }
  if (options.threadId) query.voz_thread_id = options.threadId;
  if (options.positionKeyword) {
    query.position = { $regex: escapeRegex(options.positionKeyword.trim()), $options: "i" };
  }
  return query;
}

const OFFER_SORT_MAP: Record<string, Dict> = {
  recent: { updated_at: -1, created_at: -1 },
  year_desc: { offer_year: -1, updated_at: -1, created_at: -1 },
  year_asc: { offer_year: 1, updated_at: -1, created_at: -1 },
  salary_desc: { monthly_salary_million: -1, updated_at: -1, created_at: -1 },
  salary_asc: { monthly_salary_million: 1, updated_at: -1, created_at: -1 },
  position_az: { position: 1, updated_at: -1 },
};

export async function getOffersByCompany(
  company: string,
  options: {
    limit?: number;
    skip?: number;
    threadId?: string;
    positionKeyword?: string;
    sortBy?: string;
  } = {},
): Promise<Dict[]> {
  const { limit = 50, skip = 0, threadId, positionKeyword, sortBy = "recent" } = options;
  const db = await getDb();
  const query = buildOfferQuery({ company, threadId, positionKeyword });

  const offers = (await db
    .collection("offers")
    .find(query)
    .sort(OFFER_SORT_MAP[sortBy] || OFFER_SORT_MAP.recent)
    .skip(skip)
    .limit(limit)
    .toArray()).map((doc) => ({ ...doc, _id: undefined }) as Dict);

  const postIds = offers.map((offer) => String(offer.voz_post_id || "")).filter(Boolean);
  const reviewMap = new Map<string, Dict>();
  if (postIds.length) {
    const reviewDocs = await db.collection("reviews").find({ voz_post_id: { $in: postIds } }).toArray();
    for (const doc of reviewDocs) {
      if (doc.voz_post_id) reviewMap.set(String(doc.voz_post_id), { ...doc, _id: undefined });
    }
  }

  for (const offer of offers) {
    const linkedReview = reviewMap.get(String(offer.voz_post_id || ""));
    if (linkedReview) {
      offer.url = linkedReview.url || "";
      offer.post_date = linkedReview.post_date;
    }
  }

  return offers;
}

export async function getOfferCount(
  options: { company?: string; threadId?: string; positionKeyword?: string } = {},
): Promise<number> {
  const db = await getDb();
  return db.collection("offers").countDocuments(buildOfferQuery(options));
}

// ============== threads ==============

export async function getAllThreads(): Promise<Dict[]> {
  const db = await getDb();
  return (await db.collection("threads").find({}).sort({ created_at: -1 }).toArray()).map(
    (doc) => ({ ...doc, _id: undefined }),
  );
}

export async function getThreadState(
  options: { threadId?: string | null; url?: string | null } = {},
): Promise<Dict | null> {
  const db = await getDb();
  const query: Dict = {};
  if (options.threadId) query.thread_id = options.threadId;
  else if (options.url) query.url = options.url;
  else return null;
  const doc = await db.collection("threads").findOne(query);
  return doc ? { ...doc, _id: undefined } : null;
}

export async function setThreadCrawlStatus(url: string, status: string, error: string | null = null): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const document = await db.collection("threads").findOne({ url });
  if (!document) {
    await db.collection("threads").insertOne({
      url,
      title: url,
      crawl_status: status,
      crawl_error: status === "running" ? null : error,
      created_at: now,
      updated_at: now,
    });
    return;
  }
  const updateSet: Dict = { crawl_status: status, updated_at: now };
  if (status === "running") updateSet.crawl_error = null;
  else if (error) updateSet.crawl_error = error;
  await db.collection("threads").updateOne({ _id: document._id }, { $set: updateSet });
}

export async function upsertThread(
  url: string,
  options: { title?: string; threadId?: string | null; kind?: string } = {},
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const existing = await db.collection("threads").findOne({ url });
  if (!existing) {
    await db.collection("threads").insertOne({
      url,
      title: options.title || url,
      thread_id: options.threadId ?? null,
      kind: options.kind || "thread",
      crawl_status: "idle",
      created_at: now,
      updated_at: now,
    });
    return;
  }
  await db.collection("threads").updateOne(
    { _id: existing._id },
    {
      $set: {
        title: options.title || existing.title || url,
        thread_id: options.threadId ?? existing.thread_id ?? null,
        kind: options.kind || existing.kind || "thread",
        updated_at: now,
      },
    },
  );
}

// ============== scheduler ==============

export async function getSchedulerState(jobName: string): Promise<Dict | null> {
  const db = await getDb();
  const doc = await db.collection("scheduler_states").findOne({ job_name: jobName });
  return doc ? { ...doc, _id: undefined } : null;
}

export async function getHourlySchedulerStatus(): Promise<Dict | null> {
  return getSchedulerState(SCHEDULER_JOB_NAME);
}

/**
 * Reset stale "running" thread statuses left behind by dead crawl processes.
 * The Cloudflare Worker sets its own statuses; anything still "running" here
 * belongs to a finished or dead run.
 */
export async function refreshThreadJobStatuses(): Promise<void> {
  const threads = await getAllThreads();
  for (const thread of threads) {
    if (!thread.url) continue;
    if (thread.crawl_status === "running") {
      await setThreadCrawlStatus(thread.url, "idle");
    }
  }
}
