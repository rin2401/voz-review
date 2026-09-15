// Hourly crawl orchestration for the Cloudflare Worker, ported from main.py
// (crawl_thread / process_thread_page / crawl_all_forums) and scheduler.py
// (CrawlAllRunManager lock flow). Writes directly to MongoDB Atlas.

import { defaultApartmentExtractor } from "./apartment-extract.js";
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
  insertApartmentReviews,
  insertReview,
  primaryReviewCompany,
  setThreadCrawlStatus,
  syncOffersForPost,
  tryAcquireSchedulerLock,
  updateThreadState,
  SCHEDULER_JOB_NAME,
} from "./mongo.js";

const extractor = defaultCompanyExtractor;
const apartmentExtractor = defaultApartmentExtractor;

/** Thread kinds: "thread" (company reviews) or "apartment" (chung cư). */
export const THREAD_KINDS = ["thread", "apartment"];

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

/** Insert all apartment reviews from one thread page (kind: "apartment"). */
export async function processApartmentThreadPage(pageUrl, html) {
  const posts = parseThreadPage(html, pageUrl);
  for (const postData of posts) {
    // The parser fills company-specific fields on every post; apartment
    // reviews must not carry them.
    delete postData.company;
    delete postData.companies;
    delete postData.monthly_salary_million;
    postData.apartments = apartmentExtractor.extractApartments(postData.content || "");
  }
  // One batched insertMany per page: per-post roundtrips made slices exceed
  // the Worker CPU/wall budget (dup re-crawls of the saved last_page alone
  // cost ~18 Atlas roundtrips per slice).
  const { inserted, skipped } = await insertApartmentReviews(posts);
  console.log(`  Page: ${inserted} inserted, ${skipped} skipped duplicates`);
  return { inserted, skipped };
}

/** Insert all reviews from one thread page, dispatching on the thread kind. */
export async function processThreadPage(pageUrl, html, { kind = "thread" } = {}) {
  if (kind === "apartment") {
    return processApartmentThreadPage(pageUrl, html);
  }

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
export async function crawlThread(url, maxPages, config, deadline = null, { kind = null } = {}) {
  const threadId = extractThreadId(url) || null;
  let pagesCrawled = 0;
  try {
    const firstPageUrl = url.endsWith("/") ? url : `${url}/`;
    const firstHtml = await fetchPageHtml(firstPageUrl, {
      timeoutSeconds: config.fetchTimeoutSeconds,
    });

    const totalPages = detectTotalPages(firstHtml);

    const threadState = await getThreadState({ threadId, url });
    // Threads not registered in DB default to the company-review flow.
    const effectiveKind = kind ?? (threadState && threadState.kind) ?? "thread";
    let startPage = 1;
    if (threadState && threadState.last_page) {
      startPage = Math.max(1, parseInt(threadState.last_page, 10));
    }

    const endPage = maxPages === 0 ? totalPages : Math.min(totalPages, startPage + maxPages - 1);
    console.log(
      `Thread: ${totalPages} pages detected, resume from page ${startPage}, crawl until ${endPage} (kind: ${effectiveKind})`,
    );

    let budgetStopped = false;
    for (let page = startPage; page <= endPage; page++) {
      if (deadline !== null && Date.now() > deadline) {
        console.log("Run budget exceeded, stopping this thread early");
        budgetStopped = true;
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

      await processThreadPage(pageUrl, html, { kind: effectiveKind });
      await updateThreadState({ threadId, url, lastPage: page });
      pagesCrawled += 1;
      await sleep(config.crawlDelaySeconds);
    }

    await setThreadCrawlStatus(url, "idle");
    console.log(budgetStopped ? `Thread crawl paused early (budget): ${url}` : `Thread crawl complete: ${url}`);
    // completed=false means the budget stopped this thread mid-crawl; the
    // next slice must resume it (page state is saved in threads.last_page).
    return { status: "success", url, pages_crawled: pagesCrawled, completed: !budgetStopped };
  } catch (error) {
    await setThreadCrawlStatus(url, "error", String(error));
    console.error(`Thread crawl failed: ${error}`);
    return { status: "error", url, pages_crawled: pagesCrawled, error: String(error) };
  }
}

/**
 * Crawl all configured threads from DB sequentially, mirroring crawl_all_forums.
 * Returns { summary, complete, nextSkip }; when complete=false the caller can
 * resume from nextSkip (threads are indexed by the created_at-desc list, and
 * each thread resumes from its saved last_page).
 */
export async function crawlAllForums(maxPages, config, deadline = null, { skip = 0 } = {}) {
  const threads = await getAllThreads();
  const summary = {
    threads_total: threads.length,
    threads_started: 0,
    threads_skipped_running: 0,
    threads_failed: 0,
  };
  for (let i = skip; i < threads.length; i++) {
    const url = threads[i].url;
    if (!url) continue;

    if (deadline !== null && Date.now() > deadline) {
      console.log("Run budget exceeded, resuming remaining threads in the next slice");
      return { summary, complete: false, nextSkip: i };
    }

    const currentState = await getThreadState({ url });
    if (currentState && currentState.crawl_status === "running") {
      // A previous run crashed mid-crawl; the scheduler lock we hold proves no
      // other run is active, so reset the stale status and proceed.
      await setThreadCrawlStatus(url, "idle");
    }

    await setThreadCrawlStatus(url, "running");
    summary.threads_started += 1;
    const result = await crawlThread(url, maxPages, config, deadline, { kind: threads[i].kind ?? null });
    if (result.status === "error") {
      summary.threads_failed += 1;
    }
    if (result.completed === false) {
      // Budget hit mid-thread; the next slice resumes this same thread from
      // its saved last_page.
      return { summary, complete: false, nextSkip: i };
    }
    await sleep(config.threadDelaySeconds);
  }
  return { summary, complete: true, nextSkip: threads.length };
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
  // Lease only needs to outlive the run budget; a killed run then ghosts the
  // lock for minutes, not for the full 180-minute configured lease.
  const leaseSeconds = Math.min(
    config.schedulerLeaseMinutes * 60,
    config.runBudgetSeconds + 120,
  );
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);

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
    // Do not close(): with self service bindings the chain link shares this
    // isolate (and this module-level client) with the lock-holding run.
    return { status: "already_running" };
  }
  return { status: "started", config, nextRunAt, url, maxPages };
}

/**
 * Scheduled entry point: acquire the shared scheduler lock and crawl all
 * threads in SELF-chained slices. A single long invocation would exceed the
 * per-invocation CPU limit (~2s on the free plan, observed 2026-09-14) on a
 * full crawl, so the cron handler uses the same slice chain as manual runs.
 */
export async function runScheduledCrawl(env, { reason = "scheduled-hourly" } = {}) {
  const started = await startCrawlRun(env, { reason });
  if (started.status !== "started") return started;
  return runManualCrawlAfterStart(env, started, { selfUrl: SCHEDULED_CHAIN_URL });
}

/**
 * Wall-clock budget for one manual crawl slice. Manual runs execute in
 * fetch-handler waitUntil slots, which Cloudflare cancels ~30s after the
 * response returns, so a slice's worst case (budget + one in-flight page
 * fetch + wrap-up) must stay under that window; slices then chain via the
 * SELF service binding to get a fresh waitUntil window each.
 */
export const MANUAL_SLICE_SECONDS = 8;

// Cap page fetches inside a manual slice so one hung voz.vn fetch cannot
// push the slice past the waitUntil window (cron slices keep the full
// configured timeout).
const MANUAL_FETCH_TIMEOUT_SECONDS = 12;

// Virtual URL for chaining slices from the scheduled handler: the SELF
// service binding routes directly to this worker's fetch handler, so the
// host never resolves; only the /__crawl path matters.
const SCHEDULED_CHAIN_URL = "https://voz-review.internal/__crawl";

/**
 * Run one manual crawl slice; when the crawl is not finished, POST /__crawl
 * back to this worker so the next slice runs in a fresh invocation. The
 * scheduler lock stays held across the whole chain; a broken chain only
 * ghosts the lock until the (short) lease expires and the next hourly cron
 * cycle resumes the crawl from each thread's saved last_page.
 */
export async function runManualCrawlSlice(env, started, { selfUrl, skip = 0, sliceSeconds = MANUAL_SLICE_SECONDS }) {
  const { config, nextRunAt, url, maxPages } = started;
  const effectiveMaxPages = maxPages === null ? config.maxPagesPerThread : maxPages;
  const deadline = Date.now() + sliceSeconds * 1000;
  const sliceConfig = {
    ...config,
    fetchTimeoutSeconds: Math.min(config.fetchTimeoutSeconds, MANUAL_FETCH_TIMEOUT_SECONDS),
  };
  console.log(`Crawl slice: url=${url ?? "all"} skip=${skip} budget=${sliceSeconds}s`);

  let outcome;
  if (url) {
    const result = await crawlThread(url, effectiveMaxPages, sliceConfig, deadline);
    outcome = {
      complete: result.completed !== false,
      nextSkip: 0,
      summary: {
        threads_total: 1,
        threads_started: 1,
        threads_skipped_running: 0,
        threads_failed: result.status === "error" ? 1 : 0,
      },
    };
  } else {
    outcome = await crawlAllForums(effectiveMaxPages, sliceConfig, deadline, { skip });
  }

  if (outcome.complete) {
    const result = formatRunResult(outcome.summary);
    await completeSchedulerRun({
      jobName: SCHEDULER_JOB_NAME,
      status: "success",
      result,
      nextRunAt,
    });
    console.log(`Crawl complete: ${result}`);
    return { status: "success", result };
  }

  // Chain through the SELF service binding (this same worker): a plain
  // fetch() to our own workers.dev URL is 404'd at the Cloudflare edge, while
  // a service binding invokes the fetch handler directly and the chained
  // slice gets a fresh waitUntil window.
  const selfFetch = env.SELF && typeof env.SELF.fetch === "function" ? env.SELF.fetch.bind(env.SELF) : fetch;
  const response = await selfFetch(selfUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CRAWL_TRIGGER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ url, max_pages: maxPages, skip: outcome.nextSkip, chain: true }),
    signal: AbortSignal.timeout(10 * 1000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`crawl chain fetch failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  console.log(`Crawl slice done, chained next slice from skip=${outcome.nextSkip}`);
  return { status: "chained", nextSkip: outcome.nextSkip };
}

/**
 * Continue an in-flight manual crawl chain (POST /__crawl with chain=true).
 * The chain's first slice already holds the scheduler lock, so this skips
 * lock acquisition and runs the next slice directly.
 */
export async function continueManualCrawl(env, { selfUrl, url = null, maxPages = null, skip = 0 }) {
  console.log(`Chain link: skip=${skip} url=${url ?? "all"}`);
  const config = loadConfig(env);
  const now = new Date();
  const nextRunAt = nextTopOfHourUtc(now, config.schedulerTimezone);
  // The previous slice shares this isolate (SELF service binding) and may
  // have left its client in an unknown state; chain links always reconnect.
  await close();
  await connect(config.mongoUri, config.mongoDb);
  console.log("Chain link: mongo connected");
  const started = { status: "started", config, nextRunAt, url, maxPages };
  return runManualCrawlAfterStart(env, started, { selfUrl, skip });
}

/**
 * Run manual crawl slices after the scheduler lock is held (by startCrawlRun
 * or a chain link). Any failure — including a broken chain link — must
 * release the lock and record the error, or the run ghosts the lock until
 * the lease expires.
 */
export async function runManualCrawlAfterStart(env, started, { selfUrl, skip = 0, sliceSeconds }) {
  let result;
  try {
    result = await runManualCrawlSlice(env, started, { selfUrl, skip, sliceSeconds });
  } catch (error) {
    await completeSchedulerRun({
      jobName: SCHEDULER_JOB_NAME,
      status: "error",
      error: String(error),
      nextRunAt: started.nextRunAt,
    });
    console.error(`Crawl failed: ${error}`);
    result = { status: "error", error: String(error) };
  }
  // Close only at terminal states: the chained slice re-enters this same
  // isolate via the SELF service binding and shares this module-level
  // client, so closing mid-chain would pull the connection out from under
  // the next slice.
  if (result.status !== "chained") {
    await close();
  }
  return result;
}
