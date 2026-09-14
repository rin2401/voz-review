import {
  continueManualCrawl,
  runManualCrawlAfterStart,
  runScheduledCrawl,
  startCrawlRun,
} from "./crawler/crawl.js";

const DEFAULT_ORIGIN = "https://voz-review.vercel.app";

function buildOriginUrl(request, origin) {
  const requestUrl = new URL(request.url);
  const originUrl = new URL(origin);

  originUrl.pathname = requestUrl.pathname;
  originUrl.search = requestUrl.search;

  return originUrl;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Manual crawl trigger for the web app: POST /__crawl with
 * "Authorization: Bearer <CRAWL_TRIGGER_TOKEN>" and an optional JSON body
 * { url, max_pages }. Acquires the same scheduler lock as the hourly cron,
 * then crawls in short self-chained waitUntil slices (fetch-handler
 * waitUntil slots are cancelled shortly after the response returns, so one
 * long background crawl cannot run there). Chain links POST back with
 * { chain: true, skip } to continue an in-flight run.
 */
async function handleCrawlTrigger(request, env, ctx) {
  const expectedToken = env.CRAWL_TRIGGER_TOKEN;
  if (!expectedToken) {
    return json({ detail: "crawl trigger not configured" }, 503);
  }
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || token !== expectedToken) {
    return json({ detail: "unauthorized" }, 401);
  }

  let payload = {};
  if (request.method === "POST") {
    try {
      const text = await request.text();
      if (text) payload = JSON.parse(text);
    } catch {
      return json({ detail: "invalid JSON body" }, 400);
    }
  }

  const url = new URL(request.url);
  const threadUrl = typeof payload.url === "string" && payload.url.trim() ? payload.url.trim() : url.searchParams.get("url");
  const rawMaxPages = payload.max_pages ?? url.searchParams.get("max_pages");
  const maxPages = rawMaxPages === null || rawMaxPages === undefined ? null : Number(rawMaxPages);
  const rawSkip = payload.skip ?? url.searchParams.get("skip");
  const skip = rawSkip === null || rawSkip === undefined || !Number.isFinite(Number(rawSkip)) ? 0 : Number(rawSkip);

  if (payload.chain) {
    // Continuation of an in-flight manual run; its first slice already holds
    // the scheduler lock for the whole chain.
    ctx.waitUntil(
      continueManualCrawl(env, {
        selfUrl: request.url,
        url: threadUrl,
        maxPages: Number.isFinite(maxPages) ? maxPages : null,
        skip,
      }),
    );
    return json({ status: "chained" }, 202);
  }

  const started = await startCrawlRun(env, {
    reason: "manual",
    url: threadUrl,
    maxPages: Number.isFinite(maxPages) ? maxPages : null,
  });
  if (started.status !== "started") {
    return json({ status: "already_running" }, 200);
  }
  ctx.waitUntil(runManualCrawlAfterStart(env, started, { selfUrl: request.url }));
  return json({ status: "started" }, 202);
}

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/__crawl") {
      return handleCrawlTrigger(request, env, ctx);
    }

    const origin = env.ORIGIN_URL || DEFAULT_ORIGIN;
    const originUrl = buildOriginUrl(request, origin);
    const headers = new Headers(request.headers);

    headers.set("host", originUrl.host);
    headers.set("x-forwarded-host", requestUrl.host);
    headers.set("x-forwarded-proto", "https");

    return fetch(originUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  },

  // Hourly cron trigger: crawl voz.vn threads and write to MongoDB Atlas.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCrawl(env));
  },
};
