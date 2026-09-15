import Link from "next/link";

import { ReviewCard } from "@/components/review-card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  getApartmentPostsByIds,
  getApartmentRepliesForPosts,
  getApartmentReviewCount,
  getApartmentThreadIds,
  getReviewsByApartment,
  resolveApartmentName,
} from "@/lib/db/apartment-queries";
import { buildReplyContext } from "@/lib/replies";
import { companyToSlug } from "@/lib/format";
import { cn } from "@/lib/utils";

export const revalidate = 300;

const LIMIT = 20;

type SearchParams = {
  page?: string;
  thread_id?: string;
};

function buildPageHref(slug: string, page: number, threadId: string): string {
  const search = new URLSearchParams();
  search.set("page", String(page));
  if (threadId) search.set("thread_id", threadId);
  return `/apartments/${slug}?${search.toString()}`;
}

export default async function ApartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const { page: rawPage, thread_id: threadIdParam } = await searchParams;

  const page = Math.max(1, Number(rawPage ?? 1) || 1);
  const skip = (page - 1) * LIMIT;

  const apartmentName = await resolveApartmentName(slug);
  const apartmentSlug = companyToSlug(apartmentName);

  const availableThreadIds = await getApartmentThreadIds(apartmentName);
  const activeThreadId = threadIdParam && availableThreadIds.includes(threadIdParam) ? threadIdParam : "";

  const reviews = await getReviewsByApartment(apartmentName, {
    limit: LIMIT,
    skip,
    threadId: activeThreadId || undefined,
  });
  const total = await getApartmentReviewCount({
    apartment: apartmentName,
    threadId: activeThreadId || undefined,
  });
  const { replyChildrenByPostId } = await buildReplyContext(reviews, {
    getPostsByIds: getApartmentPostsByIds,
    getRepliesForPosts: getApartmentRepliesForPosts,
  });

  const pages = Math.ceil(total / LIMIT);
  const startPage = Math.max(1, page - 2);
  const endPage = Math.min(pages, page + 2);
  const pageNumbers: number[] = [];
  for (let p = startPage; p <= endPage; p++) pageNumbers.push(p);

  const hrefFor = (overrides: Record<string, string>) => {
    const search = new URLSearchParams();
    const merged = { thread_id: activeThreadId, ...overrides };
    if (merged.thread_id) search.set("thread_id", merged.thread_id);
    const query = search.toString();
    return `/apartments/${apartmentSlug}${query ? `?${query}` : ""}`;
  };

  const pillClass = (active: boolean) =>
    cn(
      "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border bg-muted/50 text-foreground hover:bg-accent",
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">🏘️ {apartmentName}</h1>
          <Badge variant="secondary">{total} reviews</Badge>
        </div>
        <Link href="/apartments" className={cn(buttonVariants({ variant: "secondary" }))}>
          ← Back
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href={hrefFor({})} className={pillClass(!activeThreadId)}>
          All
        </Link>
        {availableThreadIds.map((tid) => (
          <Link
            key={tid}
            href={hrefFor({ thread_id: tid })}
            className={pillClass(activeThreadId === tid)}
          >
            {tid}
          </Link>
        ))}
      </div>

      {reviews.length > 0 ? (
        <div className="space-y-3">
          {reviews.map((review) => (
            <ReviewCard key={String(review.voz_post_id ?? review._id ?? Math.random())} review={review} replyChildrenByPostId={replyChildrenByPostId} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Chưa có review cho chung cư này.
          </CardContent>
        </Card>
      )}

      {pages > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1">
          <Link
            href={buildPageHref(apartmentSlug, Math.max(1, page - 1), activeThreadId)}
            aria-disabled={page <= 1}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              page <= 1 && "pointer-events-none opacity-50",
            )}
          >
            ‹ Prev
          </Link>
          {startPage > 1 && (
            <Link
              href={buildPageHref(apartmentSlug, 1, activeThreadId)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              1
            </Link>
          )}
          {startPage > 2 && <span className="px-2 text-sm text-muted-foreground">...</span>}
          {pageNumbers.map((p) => (
            <Link
              key={p}
              href={buildPageHref(apartmentSlug, p, activeThreadId)}
              className={buttonVariants({ variant: p === page ? "default" : "outline", size: "sm" })}
            >
              {p}
            </Link>
          ))}
          {endPage < pages - 1 && <span className="px-2 text-sm text-muted-foreground">...</span>}
          {endPage < pages && (
            <Link
              href={buildPageHref(apartmentSlug, pages, activeThreadId)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {pages}
            </Link>
          )}
          <Link
            href={buildPageHref(apartmentSlug, Math.min(pages, page + 1), activeThreadId)}
            aria-disabled={page >= pages}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              page >= pages && "pointer-events-none opacity-50",
            )}
          >
            Next ›
          </Link>
        </nav>
      )}
    </div>
  );
}
