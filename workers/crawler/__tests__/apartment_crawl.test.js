import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mongo = vi.hoisted(() => ({
  threadStates: new Map(),
  insertedReviews: [],
  insertedApartmentReviews: [],
}));

vi.mock("../mongo.js", () => ({
  SCHEDULER_JOB_NAME: "crawl_all_threads",
  close: vi.fn(),
  connect: vi.fn(),
  ensureApartmentIndexes: vi.fn(),
  ensureSchedulerState: vi.fn(),
  tryAcquireSchedulerLock: vi.fn(),
  completeSchedulerRun: vi.fn(),
  getAllThreads: vi.fn(async () => []),
  getThreadState: vi.fn(async ({ url }) => mongo.threadStates.get(url) ?? null),
  setThreadCrawlStatus: vi.fn(),
  updateThreadState: vi.fn(),
  insertReview: vi.fn(async (doc) => {
    mongo.insertedReviews.push(doc);
    return { inserted: true, insertedId: "id" };
  }),
  insertApartmentReview: vi.fn(async (doc) => {
    mongo.insertedApartmentReviews.push(doc);
    return { inserted: true, insertedId: "id" };
  }),
  incrementCompanyReviewCount: vi.fn(),
  syncOffersForPost: vi.fn(),
  primaryReviewCompany: vi.fn(() => null),
}));

const posts = vi.hoisted(() => [
  {
    voz_post_id: "100",
    voz_thread_id: "1",
    content: "Tên dự án: Akari City\nĐang ở 2 năm, chung cư ổn áp.",
    author: "alice",
  },
  {
    voz_post_id: "101",
    voz_thread_id: "1",
    content: "Tên công ty: FPT Software\nVị trí: Backend\nLương tháng: 50m",
    author: "bob",
  },
]);

vi.mock("../parser.js", () => ({
  VOZ_USER_AGENT: "test-agent",
  extractThreadId: vi.fn(() => "1"),
  parseThreadPage: vi.fn(() => posts),
}));

import { crawlThread, processThreadPage } from "../crawl.js";

const PAGE_HTML = "<html><body></body></html>";

function testConfig(overrides = {}) {
  return {
    mongoUri: "mongodb://test",
    mongoDb: "test",
    crawlDelaySeconds: 0,
    threadDelaySeconds: 0,
    maxPagesPerThread: 20,
    fetchTimeoutSeconds: 1,
    runBudgetSeconds: 780,
    schedulerTimezone: "Asia/Ho_Chi_Minh",
    schedulerLeaseMinutes: 180,
    ...overrides,
  };
}

beforeEach(() => {
  mongo.threadStates = new Map();
  mongo.insertedReviews = [];
  mongo.insertedApartmentReviews = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE_HTML, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("processThreadPage kind routing", () => {
  it("writes apartment posts to apartment_reviews for kind apartment", async () => {
    const result = await processThreadPage("https://voz.vn/t/x.1/", PAGE_HTML, {
      kind: "apartment",
    });
    expect(result.inserted).toBe(2);
    expect(mongo.insertedApartmentReviews).toHaveLength(2);
    // The apartment extractor ran on the apartment post content.
    expect(mongo.insertedApartmentReviews[0].apartments).toEqual(["Akari City"]);
    // The company post has no apartment label/alias match.
    expect(mongo.insertedApartmentReviews[1].apartments).toEqual([]);
    expect(mongo.insertedReviews).toHaveLength(0);
  });

  it("writes posts to reviews for the default company kind", async () => {
    const result = await processThreadPage("https://voz.vn/t/x.1/", PAGE_HTML);
    expect(result.inserted).toBe(2);
    expect(mongo.insertedReviews).toHaveLength(2);
    expect(mongo.insertedApartmentReviews).toHaveLength(0);
  });
});

describe("crawlThread kind resolution", () => {
  it("uses the thread kind from the threads collection when kind is not passed", async () => {
    mongo.threadStates.set("https://voz.vn/t/x.1/", { kind: "apartment", last_page: 1 });
    await crawlThread("https://voz.vn/t/x.1/", 0, testConfig(), Date.now() + 60000);
    expect(mongo.insertedApartmentReviews).toHaveLength(2);
    expect(mongo.insertedReviews).toHaveLength(0);
  });

  it("defaults to the company flow for unregistered threads", async () => {
    await crawlThread("https://voz.vn/t/x.1/", 0, testConfig(), Date.now() + 60000);
    expect(mongo.insertedReviews).toHaveLength(2);
    expect(mongo.insertedApartmentReviews).toHaveLength(0);
  });
});
