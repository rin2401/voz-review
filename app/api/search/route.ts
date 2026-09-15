import { NextRequest, NextResponse } from "next/server";

import { searchReviews } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || "";
  const limit = Number(searchParams.get("limit") ?? 20) || 20;
  const skip = Number(searchParams.get("skip") ?? 0) || 0;
  if (!q) {
    return NextResponse.json({ results: [], query: q }, { status: 400 });
  }
  const results = await searchReviews(q, limit, skip);
  return NextResponse.json({ results, query: q });
}
