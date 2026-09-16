// Read query helpers for the apartment (chung cư) collections, mirroring
// lib/db/queries.ts (company side) but reading `apartments`/`apartment_reviews`.
// The apartment collections are written by the Cloudflare Worker crawler only.

import { normalizeAliases as normalizeAliasesJs } from "../../workers/crawler/aliases.js";
import { asciiSlug } from "../format";
import { buildApartmentEntityMap, type EntityMap } from "../entity-links";
import { getDb } from "./client";

export type Dict = Record<string, any>;

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============== apartment match helpers ==============

export function buildApartmentMatch(apartment: string): Dict {
  const apartmentRegex = { $regex: `^${escapeRegex(apartment)}$`, $options: "i" };
  return { apartments: apartmentRegex };
}

// ============== apartments ==============

export async function getAllApartments(sortBy = "recent_review"): Promise<Dict[]> {
  const db = await getDb();
  const docs = (await db.collection("apartments").find({}).toArray()).map(
    (doc) => ({ ...doc, _id: undefined }) as Dict,
  );
  if (!docs.length) return [];

  const apartmentNames = docs.map((doc) => doc.name).filter(Boolean);
  const aggregatesByApartment: Record<string, Dict> = {};
  for (const name of apartmentNames) {
    aggregatesByApartment[name] = { review_count: 0, latest_post_date: null };
  }

  const pipeline = [
    {
      $project: {
        apartments: 1,
        effective_post_date: {
          $ifNull: [
            { $convert: { input: "$post_date", to: "date", onError: null, onNull: null } },
            { $convert: { input: "$created_at", to: "date", onError: null, onNull: null } },
          ],
        },
      },
    },
    { $unwind: "$apartments" },
    {
      $group: {
        _id: "$apartments",
        review_count: { $sum: 1 },
        latest_review: { $max: "$effective_post_date" },
      },
    },
    { $match: { _id: { $in: apartmentNames } } },
  ];
  for (const row of await db.collection("apartment_reviews").aggregate(pipeline).toArray()) {
    const name = coerceString(row._id);
    if (!name) continue;
    aggregatesByApartment[name] = {
      review_count: Number(row.review_count || 0),
      latest_post_date: coerceDatetime(row.latest_review),
    };
  }

  const apartments: Dict[] = [];
  for (const doc of docs) {
    const apartmentName = doc.name;
    const aggregate = aggregatesByApartment[apartmentName] || {};
    doc.aliases = normalizeAliases(doc.aliases || [], apartmentName);
    doc.review_count = Number(aggregate.review_count || 0);
    doc.latest_post_date = aggregate.latest_post_date ?? null;
    apartments.push(doc);
  }

  // Python sorts by tuple key with reverse=True, which reverses EVERY tuple
  // component including the name tie-break. Replicate that exactly.
  const nameLower = (a: Dict) => String(a.name || "").toLowerCase();
  const cmpDesc = (a: string, b: string) => (a > b ? -1 : a < b ? 1 : 0);
  const dateMs = (value: any) => {
    const date = coerceDatetime(value);
    return date ? date.getTime() : 0;
  };
  if (sortBy === "most_review") {
    apartments.sort((a, b) => (b.review_count || 0) - (a.review_count || 0) || cmpDesc(nameLower(a), nameLower(b)));
  } else if (sortBy === "recent_review") {
    apartments.sort((a, b) => {
      const aDate = dateMs(a.latest_post_date);
      const bDate = dateMs(b.latest_post_date);
      if (Boolean(aDate) !== Boolean(bDate)) return aDate ? -1 : 1;
      if (aDate && bDate && aDate !== bDate) return bDate - aDate;
      return cmpDesc(nameLower(a), nameLower(b));
    });
  } else {
    apartments.sort((a, b) => (nameLower(a) < nameLower(b) ? -1 : nameLower(a) > nameLower(b) ? 1 : 0));
  }

  return apartments;
}

export async function resolveApartmentName(slugOrName: string): Promise<string> {
  const apartments = await getAllApartments("az");
  const names = apartments.map((apartment) => apartment.name || "");

  if (names.includes(slugOrName)) return slugOrName;

  const normalized = (slugOrName || "").replace(/-/g, " ");
  if (names.includes(normalized)) return normalized;

  const lowerMap = new Map(names.map((name) => [name.toLowerCase(), name]));
  if (lowerMap.has(normalized.toLowerCase())) {
    return lowerMap.get(normalized.toLowerCase()) as string;
  }

  const asciiMap = new Map(names.map((name) => [asciiSlug(name).toLowerCase(), name]));
  return asciiMap.get(asciiSlug(slugOrName).toLowerCase()) ?? slugOrName;
}

// ============== apartment metadata (info + summary) ==============

export type ApartmentInfo = {
  location: string | null;
  price_per_m2: string | null;
  developer: string | null;
  status: string | null;
  status_note: string | null;
  bds_url: string | null;
};

export type ApartmentSummary = {
  summary: string;
  pros: string[];
  cons: string[];
};

export type ApartmentMetadata = {
  info: ApartmentInfo | null;
  summary: ApartmentSummary | null;
};

/** Location/price + review summary for one apartment, synced from data/*.json. */
export async function getApartmentMetadata(apartment: string): Promise<ApartmentMetadata> {
  const db = await getDb();
  const doc = await db.collection("apartments").findOne(
    { name: apartment },
    { projection: { info: 1, summary: 1 } },
  );
  if (!doc) return { info: null, summary: null };

  const rawInfo = doc.info;
  const info: ApartmentInfo | null =
    rawInfo && (rawInfo.location != null || rawInfo.price_per_m2 != null)
      ? {
          location: coerceString(rawInfo.location) || null,
          price_per_m2: coerceString(rawInfo.price_per_m2) || null,
          developer: coerceString(rawInfo.developer) || null,
          status: coerceString(rawInfo.status) || null,
          status_note: coerceString(rawInfo.status_note) || null,
          bds_url: coerceString(rawInfo.bds_url) || null,
        }
      : null;

  const rawSummary = doc.summary;
  const summary: ApartmentSummary | null =
    rawSummary && typeof rawSummary.summary === "string" && rawSummary.summary.trim()
      ? {
          summary: String(rawSummary.summary),
          pros: Array.isArray(rawSummary.pros) ? rawSummary.pros.map(String) : [],
          cons: Array.isArray(rawSummary.cons) ? rawSummary.cons.map(String) : [],
        }
      : null;

  return { info, summary };
}

// ============== apartment reviews ==============

export async function getReviewsByApartment(
  apartment: string,
  options: { limit?: number; skip?: number; threadId?: string } = {},
): Promise<Dict[]> {
  const { limit = 50, skip = 0, threadId } = options;
  const db = await getDb();
  const query: Dict = buildApartmentMatch(apartment);
  if (threadId) query.voz_thread_id = threadId;

  return (await db
    .collection("apartment_reviews")
    .find(query)
    .sort({ post_date: -1 })
    .skip(skip)
    .limit(limit)
    .toArray()).map((doc) => ({ ...doc, _id: undefined }) as Dict);
}

export async function getApartmentReviewCount(
  options: { apartment?: string; threadId?: string } = {},
): Promise<number> {
  const db = await getDb();
  const query: Dict = options.apartment ? buildApartmentMatch(options.apartment) : {};
  if (options.threadId) query.voz_thread_id = options.threadId;
  return db.collection("apartment_reviews").countDocuments(query);
}

export async function getApartmentThreadIds(apartment: string): Promise<string[]> {
  const db = await getDb();
  const ids = await db
    .collection("apartment_reviews")
    .distinct("voz_thread_id", {
      ...buildApartmentMatch(apartment),
      voz_thread_id: { $exists: true, $nin: [null, ""] },
    });
  return ids.filter(Boolean).map(String).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Entity-linking map (name/alias -> detail href) for all known apartments. */
export async function getApartmentEntityMap(): Promise<EntityMap> {
  const db = await getDb();
  const docs = await db
    .collection("apartments")
    .find({}, { projection: { name: 1, aliases: 1 } })
    .toArray();
  return buildApartmentEntityMap(
    docs.map((doc) => ({
      name: String(doc.name || ""),
      aliases: (doc.aliases || []) as string[],
    })),
  );
}

// ============== search ==============

// Substring search over review content. Regex (not $text): the apartment
// collection has no text index, and substring matching fits partial
// Vietnamese queries ("bàn giao", "Q2") better than word tokenization.
export async function searchApartmentReviews(
  keyword: string,
  limit = 50,
  skip = 0,
): Promise<Dict[]> {
  const db = await getDb();
  const trimmed = keyword.trim();
  const query = trimmed
    ? { content: { $regex: escapeRegex(trimmed), $options: "i" } }
    : {};
  return (await db
    .collection("apartment_reviews")
    .find(query)
    .sort({ post_date: -1 })
    .skip(skip)
    .limit(limit)
    .toArray()).map((doc) => ({ ...doc, _id: undefined }) as Dict);
}

// ============== reply tree ==============

export async function getApartmentPostsByIds(postIds: string[]): Promise<Dict[]> {
  if (!postIds.length) return [];
  const db = await getDb();
  return (await db
    .collection("apartment_reviews")
    .find({ voz_post_id: { $in: postIds } })
    .toArray()).map((doc) => ({ ...doc, _id: undefined }) as Dict);
}

export async function getApartmentRepliesForPosts(postIds: string[]): Promise<Dict[]> {
  if (!postIds.length) return [];
  const db = await getDb();
  return (await db
    .collection("apartment_reviews")
    .find({ reply_post_id: { $in: postIds } })
    .sort({ created_at: 1 })
    .toArray()).map((doc) => ({ ...doc, _id: undefined }) as Dict);
}
