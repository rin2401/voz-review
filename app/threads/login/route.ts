import { NextRequest, NextResponse } from "next/server";

import { THREADS_AUTH_COOKIE, threadsPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const password = String(formData.get("password") || "").trim();

  if (password !== threadsPassword()) {
    const url = new URL("/threads", request.url);
    url.searchParams.set("error", "1");
    return NextResponse.redirect(url, { status: 303 });
  }

  const response = NextResponse.redirect(new URL("/threads", request.url), { status: 303 });
  response.cookies.set(THREADS_AUTH_COOKIE, threadsPassword(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return response;
}
