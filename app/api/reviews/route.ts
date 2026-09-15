import { NextRequest, NextResponse } from "next/server";

import { insertReview } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const review = await request.json();
  const { insertedId } = await insertReview(review);
  return NextResponse.json({ id: insertedId, status: "created" });
}
