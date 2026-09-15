import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mongo = vi.hoisted(() => ({
  threads: [],
  threadStates: new Map(),
  completeCalls: [],
  fetchHtml: "<html><body></body></html>",
  fetchDelayMs: 5,
}));

vi.mock("../mongo.js", () => ({
  SCHEDULER_JOB_NAME: "crawl_all_threads",
  close: vi.fn(),
  connect: vi.fn(),
  ensureApartmentIndexes: vi.fn(),
  ensureSchedulerState: vi.fn(),
  tryAcquireSchedulerLock: vi.fn(),
  completeSchedulerRun: vi.fn(async (args) => {
    mongo.completeCalls.push(args);
  }),
  getAllThreads: vi.fn(async () => mongo.threads),
  getThreadState: vi.fn(async ({ url }) => mongo.threadStates.get(url) ?? null),
  setThreadCrawlStatus: vi.fn(),
  updateThreadState: vi.fn(),
  insertReview: vi.fn(async () => ({ inserted: true, insertedId: "id" })),
  insertApartmentReview: vi.fn(async () => ({ inserted: true, insertedId: "id" })),
  incrementCompanyReviewCount: vi.fn(),
  syncOffersForPost: vi.fn(),
  primaryReviewCompany: vi.fn(() => null),
}));

import {
  crawlAllForums,
  crawlThread,
  continueManualCrawl,
  runManualCrawlAfterStart,
  runManualCrawlSlice,
  runScheduledCrawl,
  startCrawlRun,
} from "../crawl.js";

const ONE_PAGE_HTML = "<html><body></body></html>";
const THREE_PAGE_HTML = '<html><body><a href="/t/x.1/page-3/">3</a></body></html>';

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

let fetchMock;

beforeEach(() => {
  mongo.threads = [];
  mongo.threadStates = new Map();
  mongo.completeCalls = [];
  mongo.fetchHtml = ONE_PAGE_HTML;
  fetchMock = vi.fn(async (input) => {
    const url = String(input);
    if (url.includes("self.example")) {
      return new Response(JSON.stringify({ status: "chained" }), { status: 202 });
    }
    await new Promise((resolve) => setTimeout(resolve, mongo.fetchDelayMs));
    return new Response(mongo.fetchHtml, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("crawlThread", () => {
  it("marks a fully crawled thread as completed", async () => {
    const result = await crawlThread("https://voz.vn/t/x.1/", 0, testConfig(), Date.now() + 60000);
    expect(result.status).toBe("success");
    expect(result.completed).toBe(true);
    expect(result.pages_crawled).toBe(1);
  });

  it("reports completed=false when the budget stops it mid-thread", async () => {
    mongo.fetchHtml = THREE_PAGE_HTML;
    mongo.threadStates.set("https://voz.vn/t/x.1/", { last_page: 1 });
    const result = await crawlThread("https://voz.vn/t/x.1/", 0, testConfig(), Date.now() - 1);
    expect(result.status).toBe("success");
    expect(result.completed).toBe(false);
    expect(result.pages_crawled).toBe(0);
  });
});

describe("crawlAllForums", () => {
  it("crawls every thread and reports completion", async () => {
    mongo.threads = [{ url: "https://voz.vn/t/a.1/" }, { url: "https://voz.vn/t/b.1/" }];
    const outcome = await crawlAllForums(0, testConfig(), Date.now() + 60000);
    expect(outcome.complete).toBe(true);
    expect(outcome.nextSkip).toBe(2);
    expect(outcome.summary).toEqual({
      threads_total: 2,
      threads_started: 2,
      threads_skipped_running: 0,
      threads_failed: 0,
    });
  });

  it("stops at the budget and reports the thread index to resume from", async () => {
    mongo.threads = [
      { url: "https://voz.vn/t/a.1/" },
      { url: "https://voz.vn/t/b.1/" },
      { url: "https://voz.vn/t/c.1/" },
    ];
    // Thread a finishes (its page-1 check passes under the budget), then the
    // budget expires during the inter-thread delay so the next slice
    // resumes from thread b.
    const outcome = await crawlAllForums(0, testConfig({ threadDelaySeconds: 0.05 }), Date.now() + 15);
    expect(outcome.complete).toBe(false);
    expect(outcome.nextSkip).toBe(1);
    expect(outcome.summary.threads_started).toBe(1);
  });

  it("resumes from the given skip index", async () => {
    mongo.threads = [
      { url: "https://voz.vn/t/a.1/" },
      { url: "https://voz.vn/t/b.1/" },
    ];
    const outcome = await crawlAllForums(0, testConfig(), Date.now() + 60000, { skip: 1 });
    expect(outcome.complete).toBe(true);
    expect(outcome.nextSkip).toBe(2);
    expect(outcome.summary.threads_started).toBe(1);
  });
});

describe("runManualCrawlSlice", () => {
  it("chains the next slice when the crawl is unfinished", async () => {
    mongo.fetchHtml = THREE_PAGE_HTML;
    mongo.threadStates.set("https://voz.vn/t/x.1/", { last_page: 1 });
    const started = {
      status: "started",
      config: testConfig(),
      nextRunAt: new Date("2026-09-14T20:00:00Z"),
      url: "https://voz.vn/t/x.1/",
      maxPages: 0,
    };
    const result = await runManualCrawlSlice(
      { CRAWL_TRIGGER_TOKEN: "test-token", SELF: { fetch: fetchMock } },
      started,
      { selfUrl: "https://self.example/__crawl", sliceSeconds: -1 },
    );
    expect(result.status).toBe("chained");
    expect(result.nextSkip).toBe(0);
    expect(mongo.completeCalls).toEqual([]);

    const chainCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("self.example"));
    expect(chainCall).toBeDefined();
    const [chainUrl, chainInit] = chainCall;
    expect(String(chainUrl)).toBe("https://self.example/__crawl");
    expect(chainInit.method).toBe("POST");
    expect(chainInit.headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(chainInit.body)).toEqual({
      url: "https://voz.vn/t/x.1/",
      max_pages: 0,
      skip: 0,
      chain: true,
    });
  });

  it("completes the run and releases the lock when the crawl finishes", async () => {
    const started = {
      status: "started",
      config: testConfig(),
      nextRunAt: new Date("2026-09-14T20:00:00Z"),
      url: "https://voz.vn/t/x.1/",
      maxPages: 0,
    };
    const result = await runManualCrawlSlice(
      { CRAWL_TRIGGER_TOKEN: "test-token" },
      started,
      { selfUrl: "https://self.example/__crawl" },
    );
    expect(result.status).toBe("success");
    expect(mongo.completeCalls).toHaveLength(1);
    expect(mongo.completeCalls[0].status).toBe("success");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("self.example"))).toBe(false);
  });
});

describe("continueManualCrawl", () => {
  it("runs a slice without re-acquiring the scheduler lock", async () => {
    const result = await continueManualCrawl(
      { MONGODB_URI: "mongodb://test", CRAWL_TRIGGER_TOKEN: "test-token" },
      { selfUrl: "https://self.example/__crawl", url: "https://voz.vn/t/x.1/", maxPages: 0, skip: 0 },
    );
    expect(result.status).toBe("success");
    expect(mongo.completeCalls).toHaveLength(1);
    expect(mongo.completeCalls[0].status).toBe("success");

    const { tryAcquireSchedulerLock } = await import("../mongo.js");
    expect(tryAcquireSchedulerLock).not.toHaveBeenCalled();
  });
});

describe("runManualCrawlAfterStart", () => {
  it("keeps the connection open when the slice chains the next one", async () => {
    mongo.fetchHtml = THREE_PAGE_HTML;
    mongo.threadStates.set("https://voz.vn/t/x.1/", { last_page: 1 });
    const started = {
      status: "started",
      config: testConfig(),
      nextRunAt: new Date("2026-09-14T20:00:00Z"),
      url: "https://voz.vn/t/x.1/",
      maxPages: 0,
    };
    const result = await runManualCrawlAfterStart(
      { CRAWL_TRIGGER_TOKEN: "test-token", SELF: { fetch: fetchMock } },
      started,
      { selfUrl: "https://self.example/__crawl", sliceSeconds: -1 },
    );
    expect(result.status).toBe("chained");
    expect(mongo.completeCalls).toEqual([]);

    const { close } = await import("../mongo.js");
    expect(close).not.toHaveBeenCalled();
  });

  it("releases the lock with an error when the chain link fails", async () => {
    mongo.fetchHtml = THREE_PAGE_HTML;
    mongo.threadStates.set("https://voz.vn/t/x.1/", { last_page: 1 });
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("self.example")) {
        return new Response("not found", { status: 404 });
      }
      await new Promise((resolve) => setTimeout(resolve, mongo.fetchDelayMs));
      return new Response(mongo.fetchHtml, { status: 200 });
    });

    const started = {
      status: "started",
      config: testConfig(),
      nextRunAt: new Date("2026-09-14T20:00:00Z"),
      url: "https://voz.vn/t/x.1/",
      maxPages: 0,
    };
    const result = await runManualCrawlAfterStart(
      { CRAWL_TRIGGER_TOKEN: "test-token", SELF: { fetch: fetchMock } },
      started,
      { selfUrl: "https://self.example/__crawl", sliceSeconds: -1 },
    );
    expect(result.status).toBe("error");
    expect(mongo.completeCalls).toHaveLength(1);
    expect(mongo.completeCalls[0].status).toBe("error");
    expect(mongo.completeCalls[0].error).toContain("HTTP 404");

    const { close } = await import("../mongo.js");
    expect(close).toHaveBeenCalled();
  });
});

describe("startCrawlRun", () => {
  it("does not close the shared connection when the lock is held", async () => {
    const { tryAcquireSchedulerLock, close } = await import("../mongo.js");
    tryAcquireSchedulerLock.mockReturnValueOnce(null);

    const result = await startCrawlRun(
      { MONGODB_URI: "mongodb://test", CRAWL_TRIGGER_TOKEN: "test-token" },
      { reason: "manual", url: "https://voz.vn/t/x.1/", maxPages: 0 },
    );
    expect(result).toEqual({ status: "already_running" });
    expect(close).not.toHaveBeenCalled();
  });
});

describe("runScheduledCrawl", () => {
  it("acquires the lock and completes through the slice chain", async () => {
    mongo.threads = [{ url: "https://voz.vn/t/x.1/" }];
    const result = await runScheduledCrawl(
      {
        MONGODB_URI: "mongodb://test",
        CRAWL_TRIGGER_TOKEN: "test-token",
        CRAWL_DELAY_SECONDS: "0",
        THREAD_DELAY_SECONDS: "0",
        SELF: { fetch: fetchMock },
      },
      {},
    );
    expect(result.status).toBe("success");
    expect(mongo.completeCalls).toHaveLength(1);
    expect(mongo.completeCalls[0].status).toBe("success");

    const { tryAcquireSchedulerLock } = await import("../mongo.js");
    expect(tryAcquireSchedulerLock).toHaveBeenCalled();
  });
});
