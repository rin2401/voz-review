import { NextRequest, NextResponse } from "next/server";

import { THREADS_AUTH_COOKIE, isThreadsAuthed } from "@/lib/auth";
import { triggerWorkerCrawl } from "@/lib/crawl-trigger";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isThreadsAuthed(request.cookies.get(THREADS_AUTH_COOKIE)?.value)) {
    return NextResponse.json({ detail: "Threads authentication required" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url") || "";
  const maxPages = Number(searchParams.get("max_pages") ?? 0) || 0;
  if (!url) {
    return NextResponse.json({ detail: "url is required" }, { status: 400 });
  }

  const workerResult = await triggerWorkerCrawl({ url, max_pages: maxPages });
  if (workerResult === null) {
    return NextResponse.json(
      { detail: "WORKER_CRAWL_URL is not configured; run the crawl on the Cloudflare Worker" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    status: workerResult.status || "started",
    url,
    max_pages: maxPages === 0 ? "all" : maxPages,
  });
}
