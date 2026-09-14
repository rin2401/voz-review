import { describe, expect, it } from "vitest";

import { formatRunResult, loadConfig, nextTopOfHourUtc } from "../crawl.js";

describe("loadConfig", () => {
  it("applies defaults for missing env vars", () => {
    const config = loadConfig({});
    expect(config.mongoDb).toBe("voz_crawler");
    expect(config.crawlDelaySeconds).toBe(2);
    expect(config.threadDelaySeconds).toBe(5);
    expect(config.maxPagesPerThread).toBe(20);
    expect(config.schedulerTimezone).toBe("Asia/Ho_Chi_Minh");
    expect(config.schedulerLeaseMinutes).toBe(180);
  });

  it("reads overrides from env", () => {
    const config = loadConfig({
      MONGODB_URI: "mongodb://example",
      MONGODB_DB: "other",
      MAX_PAGES_PER_THREAD: "5",
      HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES: "60",
    });
    expect(config.mongoUri).toBe("mongodb://example");
    expect(config.mongoDb).toBe("other");
    expect(config.maxPagesPerThread).toBe(5);
    expect(config.schedulerLeaseMinutes).toBe(60);
  });
});

describe("nextTopOfHourUtc", () => {
  it("returns the next top of hour in the configured timezone", () => {
    // 10:30 UTC = 17:30 ICT -> next top of hour is 18:00 ICT = 11:00 UTC
    const now = new Date("2026-09-14T10:30:00Z");
    expect(nextTopOfHourUtc(now, "Asia/Ho_Chi_Minh").toISOString()).toBe(
      "2026-09-14T11:00:00.000Z",
    );
  });

  it("rolls to the next day at the last hour of the day", () => {
    // 17:05 UTC = 00:05 ICT next day -> next top of hour 01:00 ICT = 18:00 UTC same day
    const now = new Date("2026-09-14T17:05:00Z");
    expect(nextTopOfHourUtc(now, "Asia/Ho_Chi_Minh").toISOString()).toBe(
      "2026-09-14T18:00:00.000Z",
    );
  });

  it("returns an exact hour boundary", () => {
    const next = nextTopOfHourUtc(new Date("2026-09-14T10:30:00Z"), "Asia/Ho_Chi_Minh");
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCSeconds()).toBe(0);
  });
});

describe("formatRunResult", () => {
  it("formats the crawl summary", () => {
    expect(
      formatRunResult({
        threads_total: 6,
        threads_started: 6,
        threads_skipped_running: 0,
        threads_failed: 1,
      }),
    ).toBe("threads=6, started=6, skipped=0, failed=1");
  });
});
