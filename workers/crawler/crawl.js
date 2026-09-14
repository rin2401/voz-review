// Hourly crawl orchestration for the Cloudflare Worker, ported from main.py
// (crawl_thread / process_thread_page / crawl_all_forums) and scheduler.py
// (CrawlAllRunManager lock flow). Writes directly to MongoDB Atlas.

import { defaultCompanyExtractor } from "./extract.js";
import { extractThreadId, parseThreadPage, VOZ_USER_AGENT } from "./parser.js";
import {
  close,
  completeSchedulerRun,
  connect,
  ensureSchedulerState,
  getAllThreads,
  getThreadState,
  incrementCompanyReviewCount,
  insertReview,
  primaryReviewCompany,
  setThreadCrawlStatus,
  syncOffersForPost,
  tryAcquireSchedulerLock,
  updateThreadState,
  SCHEDULER_JOB_NAME,
} from "./mongo.js";

const extractor = defaultCompanyExtractor;

export function loadConfig(env = {}) {
  return {
    mongoUri: env.MONGODB_URI || "",
    mongoDb: env.MONGODB_DB || "voz_crawler",
    vozBaseUrl: env.VOZ_BASE_URL || "https://voz.vn",
    crawlDelaySeconds: Number(env.CRAWL_DELAY_SECONDS ?? 2),
    threadDelaySeconds: Number(env.THREAD_DELAY_SECONDS ?? 5),
    maxPagesPerThread: Number(env.MAX_PAGES_PER_THREAD ?? 20),
    fetchTimeoutSeconds: Number(env.FETCH_TIMEOUT_SECONDS ?? 30),
    // Wall-clock budget for one scheduled run; cron handlers are killed at
    // 15 min, so stay well under it to release the lock cleanly.
    runBudgetSeconds: Number(env.RUN_BUDGET_SECONDS ?? 780),
    schedulerTimezone: env.HOURLY_CRAWL_SCHEDULER_TIMEZONE || "Asia/Ho_Chi_Minh",
    schedulerLeaseMinutes: Number(env.HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES ?? 180),
  };
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Fetch a voz.vn page. XenForo pages are server-rendered; no browser needed. */
export async function fetchPageHtml(url, { timeoutSeconds = 30 } = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": VOZ_USER_AGENT },
    redirect: "follow",
    // voz.vn (behind Cloudflare) can hang Worker fetches; never wait forever.
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!response.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  }
  return response.text();
}

function detectTotalPages(firstHtml) {
  const pageNumbers = [...firstHtml.matchAll(/\/page-(\d+)/g)].map((match) => parseInt(match[1], 10));
  return pageNumbers.length ? Math.max(...pageNumbers) : 1;
}

/** Insert all reviews from one thread page, mirroring process_thread_page. */
export async function processThreadPage(pageUrl, html) {
  const posts = parseThreadPage(html, pageUrl);
  let insertedCount = 0;
  let skippedCount = 0;

  for (const postData of posts) {
    try {
      const { inserted } = await insertReview(postData);
      if (inserted) {
        insertedCount += 1;
        for (const companyName of postData.companies || []) {
          await incrementCompanyReviewCount(companyName);
        }
      } else {
        skippedCount += 1;
      }

      const offerDocs = extractor.extractOffers(
        postData.content || "",
        primaryReviewCompany(postData, { allowLegacyFallback: true }),
        postData.voz_thread_id || "",
        postData.voz_post_id,
        postData.companies || [],
      );
      if (postData.voz_post_id) {
        await syncOffersForPost(postData.voz_post_id, offerDocs);
      }
    } catch (error) {
      console.error("Error inserting review:", error);
    }
  }
  console.log(`  Page: ${insertedCount} inserted, ${skippedCount} skipped duplicates`);
  return { inserted: insertedCount, skipped: skippedCount };
}

/** Crawl a specific thread - resume from threads.last_page when available. */
export async function crawlThread(url, maxPages, config, deadline = null) {
  const threadId = extractThreadId(url) || null;
  let pagesCrawled = 0;
  try {
    const firstPageUrl = url.endsWith("/") ? url : `${url}/`;
    const firstHtml = await fetchPageHtml(firstPageUrl, {
      timeoutSeconds: config.fetchTimeoutSeconds,
    });

    const totalPages = detectTotalPages(firstHtml);

    const threadState = await getThreadState({ threadId, url });
    let startPage = 1;
    if (threadState && threadState.last_page) {
      startPage = Math.max(1, parseInt(threadState.last_page, 10));
    }

    const endPage = maxPages === 0 ? totalPages : Math.min(totalPages, startPage + maxPages - 1);
    console.log(
      `Thread: ${totalPages} pages detected, resume from page ${startPage}, crawl until ${endPage}`,
    );

    for (let page = startPage; page <= endPage; page++) {
      if (deadline !== null && Date.now() > deadline) {
        console.log("Run budget exceeded, stopping this thread early");
        break;
      }
      let pageUrl;
      let html;
      if (page === 1) {
        pageUrl = firstPageUrl;
        html = firstHtml;
      } else {
        pageUrl = `${firstPageUrl}page-${page}/`;
        console.log(`Crawling page ${page}/${endPage}`);
        html = await fetchPageHtml(pageUrl, { timeoutSeconds: config.fetchTimeoutSeconds });
      }

      await processThreadPage(pageUrl, html);
      await updateThreadState({ threadId, url, lastPage: page });
      pagesCrawled += 1;
      await sleep(config.crawlDelaySeconds);
    }

    await setThreadCrawlStatus(url, "idle");
    console.log(`Thread crawl complete: ${url}`);
    return { status: "success", url, pages_crawled: pagesCrawled };
  } catch (error) {
    await setThreadCrawlStatus(url, "error", String(error));
    console.error(`Thread crawl failed: ${error}`);
    return { status: "error", url, pages_crawled: pagesCrawled, error: String(error) };
  }
}

/** Crawl all configured threads from DB sequentially, mirroring crawl_all_forums. */
export async function crawlAllForums(maxPages, config, deadline = null) {
  const threads = await getAllThreads();
  const summary = {
    threads_total: threads.length,
    threads_started: 0,
    threads_skipped_running: 0,
    threads_failed: 0,
  };
  for (const thread of threads) {
    const url = thread.url;
    if (!url) continue;

    if (deadline !== null && Date.now() > deadline) {
      console.log("Run budget exceeded, skipping remaining threads");
      break;
    }

    const currentState = await getThreadState({ url });
    if (currentState && currentState.crawl_status === "running") {
      // A previous run crashed mid-crawl; the scheduler lock we hold proves no
      // other run is active, so reset the stale status and proceed.
      await setThreadCrawlStatus(url, "idle");
    }

    await setThreadCrawlStatus(url, "running");
    summary.threads_started += 1;
    const result = await crawlThread(url, maxPages, config, deadline);
    if (result.status === "error") {
      summary.threads_failed += 1;
    }
    await sleep(config.threadDelaySeconds);
  }
  return summary;
}

export function formatRunResult(summary) {
  return (
    `threads=${summary.threads_total ?? 0}, ` +
    `started=${summary.threads_started ?? 0}, ` +
    `skipped=${summary.threads_skipped_running ?? 0}, ` +
    `failed=${summary.threads_failed ?? 0}`
  );
}

/** Next exact top-of-hour boundary in the configured timezone, as UTC Date. */
export function nextTopOfHourUtc(now, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = asUtc - now.getTime();
  const localNext = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    (Number(parts.hour) % 24) + 1,
    0,
    0,
  );
  return new Date(localNext - offset);
}

/**
 * Acquire the shared scheduler lock for a crawl run. Fast: connects to Mongo,
 * ensures scheduler state, and takes the lock. Returns "started" or
 * "already_running"; the caller must run executeCrawlRun afterwards.
 */
export async function startCrawlRun(env, { reason = "scheduled-hourly", url = null, maxPages = null } = {}) {
  const config = loadConfig(env);
  if (!config.mongoUri) {
    throw new Error("MONGODB_URI is not configured");
  }

  const now = new Date();
  const nextRunAt = nextTopOfHourUtc(now, config.schedulerTimezone);
  const leaseUntil = new Date(now.getTime() + config.schedulerLeaseMinutes * 60 * 1000);

  await connect(config.mongoUri, config.mongoDb);
  await ensureSchedulerState({
    jobName: SCHEDULER_JOB_NAME,
    timezone: config.schedulerTimezone,
    enabled: true,
    nextRunAt,
  });

  const lockState = await tryAcquireSchedulerLock({
    jobName: SCHEDULER_JOB_NAME,
    reason,
    timezone: config.schedulerTimezone,
    enabled: true,
    lockUntil: leaseUntil,
    nextRunAt,
  });
  if (lockState === null) {
    console.log("Scheduler lock held by another run, skipping this cycle");
    await close();
    return { status: "already_running" };
  }
  return { status: "started", config, nextRunAt, url, maxPages };
}

/**
 * Run the crawl started by startCrawlRun and release the lock. Long-running:
 * must run inside ctx.waitUntil, never awaited by an HTTP handler response.
 */
export async function executeCrawlRun(started) {
  const { config, nextRunAt, url, maxPages } = started;
  const effectiveMaxPages = maxPages === null ? config.maxPagesPerThread : maxPages;
  try {
    const deadline = Date.now() + config.runBudgetSeconds * 1000;
    let summary;
    if (url) {
      const result = await crawlThread(url, effectiveMaxPages, config, deadline);
      summary = {
        threads_total: 1,
        threads_started: 1,
        threads_skipped_running: 0,
        threads_failed: result.status === "error" ? 1 : 0,
      };
    } else {
      summary = await crawlAllForums(effectiveMaxPages, config, deadline);
    }
    const result = formatRunResult(summary);
    await completeSchedulerRun({
      jobName: SCHEDULER_JOB_NAME,
      status: "success",
      result,
      nextRunAt,
    });
    console.log(`Crawl complete: ${result}`);
    return { status: "success", result, summary };
  } catch (error) {
    await completeSchedulerRun({
      jobName: SCHEDULER_JOB_NAME,
      status: "error",
      error: String(error),
      nextRunAt,
    });
    console.error(`Crawl failed: ${error}`);
    return { status: "error", error: String(error) };
  } finally {
    await close();
  }
}

/** Scheduled entry point: acquire the shared scheduler lock and crawl all threads. */
export async function runScheduledCrawl(env, { reason = "scheduled-hourly", url = null, maxPages = null } = {}) {
  const started = await startCrawlRun(env, { reason, url, maxPages });
  if (started.status !== "started") return started;
  return executeCrawlRun(started);
}
