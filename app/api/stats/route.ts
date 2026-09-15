import { NextResponse } from "next/server";

import { getAllCompanies, getAllThreads, getReviewCount } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const companies = await getAllCompanies();
  const totalReviews = await getReviewCount();
  const threads = await getAllThreads();
  return NextResponse.json({
    total_companies: companies.length,
    total_reviews: totalReviews,
    threads: threads.length,
  });
}
