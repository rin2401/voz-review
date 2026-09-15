import { NextRequest, NextResponse } from "next/server";

import { THREADS_AUTH_COOKIE, isThreadsAuthed } from "@/lib/auth";
import { getAllThreads, refreshThreadJobStatuses, upsertThread } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isThreadsAuthed(request.cookies.get(THREADS_AUTH_COOKIE)?.value)) {
    return NextResponse.json({ detail: "Threads authentication required" }, { status: 401 });
  }
  await refreshThreadJobStatuses();
  return NextResponse.json(await getAllThreads());
}

export async function POST(request: NextRequest) {
  if (!isThreadsAuthed(request.cookies.get(THREADS_AUTH_COOKIE)?.value)) {
    return NextResponse.json({ detail: "Threads authentication required" }, { status: 401 });
  }
  const payload = await request.json();
  const normalizedUrl = String(payload.url || "").trim();
  if (!normalizedUrl) {
    return NextResponse.json({ detail: "URL is required" }, { status: 400 });
  }
  const threadIdMatch = normalizedUrl.match(/\/t(?:\/[^/]*?)?\.(\d+)(?:\/|$)/);
  const threadId = threadIdMatch ? threadIdMatch[1] : null;
  await upsertThread(normalizedUrl, { threadId });
  return NextResponse.json({ status: "created", url: normalizedUrl, thread_id: threadId });
}
