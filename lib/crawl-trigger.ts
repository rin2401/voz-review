// Forward manual crawl triggers to the Cloudflare Worker crawl endpoint.
// The Next.js app has no in-process crawler: long crawls must run on the
// Worker (or locally via the Python scripts).

export type CrawlPayload = { max_pages?: number; url?: string };

export async function triggerWorkerCrawl(payload: CrawlPayload): Promise<Record<string, any> | null> {
  const workerCrawlUrl = process.env.WORKER_CRAWL_URL || "";
  if (!workerCrawlUrl) return null;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.CRAWL_TRIGGER_TOKEN || "";
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(workerCrawlUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`worker crawl trigger failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return response.json();
}
