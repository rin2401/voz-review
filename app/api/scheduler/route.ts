import { NextRequest, NextResponse } from "next/server";

import { THREADS_AUTH_COOKIE, isThreadsAuthed } from "@/lib/auth";
import { getHourlySchedulerStatus } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isThreadsAuthed(request.cookies.get(THREADS_AUTH_COOKIE)?.value)) {
    return NextResponse.json({ detail: "Threads authentication required" }, { status: 401 });
  }
  return NextResponse.json(await getHourlySchedulerStatus());
}
