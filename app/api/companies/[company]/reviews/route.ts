import { NextRequest, NextResponse } from "next/server";

import { getReviewCount, getReviewsByCompany } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ company: string }> },
) {
  const { company } = await params;
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") ?? 20) || 20;
  const skip = Number(searchParams.get("skip") ?? 0) || 0;

  const reviews = await getReviewsByCompany(company, { limit, skip });
  const total = await getReviewCount({ company });
  return NextResponse.json({ reviews, total });
}
