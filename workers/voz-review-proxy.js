import { runScheduledCrawl } from "./crawler/crawl.js";

const DEFAULT_ORIGIN = "https://voz-review.vercel.app";

function buildOriginUrl(request, origin) {
  const requestUrl = new URL(request.url);
  const originUrl = new URL(origin);

  originUrl.pathname = requestUrl.pathname;
  originUrl.search = requestUrl.search;

  return originUrl;
}

export default {
  async fetch(request, env) {
    const origin = env.ORIGIN_URL || DEFAULT_ORIGIN;
    const originUrl = buildOriginUrl(request, origin);
    const headers = new Headers(request.headers);

    headers.set("host", originUrl.host);
    headers.set("x-forwarded-host", new URL(request.url).host);
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
