import { NextRequest, NextResponse } from "next/server";

import { THREADS_AUTH_COOKIE, isThreadsAuthed } from "@/lib/auth";
import { triggerWorkerCrawl } from "@/lib/crawl-trigger";
import { getAllThreads } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isThreadsAuthed(request.cookies.get(THREADS_AUTH_COOKIE)?.value)) {
    return NextResponse.json({ detail: "Threads authentication required" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const maxPages = Number(searchParams.get("max_pages") ?? 0) || 0;

  const workerResult = await triggerWorkerCrawl({ max_pages: maxPages });
  if (workerResult === null) {
    return NextResponse.json(
      { detail: "WORKER_CRAWL_URL is not configured; run the crawl on the Cloudflare Worker" },
      { status: 503 },
    );
  }
  const threads = await getAllThreads();
  return NextResponse.json({
    status: workerResult.status || "started",
    reason: "manual",
    threads: threads.length,
    max_pages: maxPages === 0 ? "all" : maxPages,
  });
}
