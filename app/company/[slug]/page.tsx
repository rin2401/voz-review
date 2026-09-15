import Link from "next/link";

import { ReviewCard } from "@/components/review-card";
import { SortSelect } from "@/components/sort-select";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getCompanyThreadIds,
  getOfferCount,
  getOffersByCompany,
  getReviewCount,
  getReviewsByCompany,
  resolveCompanyName,
} from "@/lib/db/queries";
import { buildReplyContext } from "@/lib/replies";
import { companyToSlug, formatSalaryMillion } from "@/lib/format";
import { cn } from "@/lib/utils";

export const revalidate = 300;

const LIMIT = 20;
const VIEWS = ["all", "salary", "interview", "offer"] as const;
const OFFER_SORTS = ["recent", "year_desc", "year_asc", "salary_desc", "salary_asc", "position_az"];

const OFFER_SORT_OPTIONS = [
  { value: "recent", label: "Recent review" },
  { value: "year_desc", label: "Year ↓" },
  { value: "year_asc", label: "Year ↑" },
  { value: "salary_desc", label: "Salary ↓" },
  { value: "salary_asc", label: "Salary ↑" },
  { value: "position_az", label: "Position A-Z" },
];

type SearchParams = {
  page?: string;
  thread_id?: string;
  view?: string;
  position?: string;
  sort?: string;
};

function buildPageHref(
  slug: string,
  page: number,
  params: {
    view: string;
    threadId: string;
    position: string;
    offerSort: string;
  },
): string {
  const search = new URLSearchParams();
  search.set("page", String(page));
  search.set("view", params.view);
  if (params.threadId) search.set("thread_id", params.threadId);
  if (params.view === "offer") {
    if (params.position) search.set("position", params.position);
    search.set("sort", params.offerSort);
  }
  return `/company/${slug}?${search.toString()}`;
}

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const { page: rawPage, thread_id: threadIdParam, view, position, sort } = await searchParams;

  const page = Math.max(1, Number(rawPage ?? 1) || 1);
  const skip = (page - 1) * LIMIT;

  const companyName = await resolveCompanyName(slug);
  const companySlug = companyToSlug(companyName);

  const availableThreadIds = await getCompanyThreadIds(companyName);
  const activeThreadId = threadIdParam && availableThreadIds.includes(threadIdParam) ? threadIdParam : "";
  const activeView = VIEWS.includes(view as (typeof VIEWS)[number]) ? view! : "all";
  const salaryOnly = activeView === "salary";
  const interviewOnly = activeView === "interview";
  const offerOnly = activeView === "offer";
  const activeOfferSort = OFFER_SORTS.includes(sort ?? "") ? sort! : "year_desc";
  const offerPositionQuery = (position || "").trim();

  let reviews: Record<string, any>[] = [];
  let offers: Record<string, any>[] = [];
  let replyChildrenByPostId: Record<string, any[]> = {};
  let total = 0;

  if (offerOnly) {
    offers = await getOffersByCompany(companyName, {
      limit: LIMIT,
      skip,
      threadId: activeThreadId || undefined,
      positionKeyword: offerPositionQuery,
      sortBy: activeOfferSort,
    });
    total = await getOfferCount({
      company: companyName,
      threadId: activeThreadId || undefined,
      positionKeyword: offerPositionQuery,
    });
  } else {
    reviews = await getReviewsByCompany(companyName, {
      limit: LIMIT,
      skip,
      threadId: activeThreadId || undefined,
      salaryOnly,
      interviewOnly,
    });
    total = await getReviewCount({
      company: companyName,
      threadId: activeThreadId || undefined,
      salaryOnly,
      interviewOnly,
    });
    ({ replyChildrenByPostId } = await buildReplyContext(reviews));
  }

  const pages = Math.ceil(total / LIMIT);
  const startPage = Math.max(1, page - 2);
  const endPage = Math.min(pages, page + 2);
  const pageNumbers: number[] = [];
  for (let p = startPage; p <= endPage; p++) pageNumbers.push(p);
  const pageParams = {
    view: activeView,
    threadId: activeThreadId,
    position: offerPositionQuery,
    offerSort: activeOfferSort,
  };

  const hrefFor = (overrides: Record<string, string>) => {
    const search = new URLSearchParams();
    const merged = {
      view: activeView,
      thread_id: activeThreadId,
      position: offerPositionQuery,
      sort: activeOfferSort,
      ...overrides,
    };
    if (merged.view !== "all") search.set("view", merged.view);
    if (merged.thread_id) search.set("thread_id", merged.thread_id);
    if (merged.view === "offer") {
      if (merged.position) search.set("position", merged.position);
      search.set("sort", merged.sort);
    }
    const query = search.toString();
    return `/company/${companySlug}${query ? `?${query}` : ""}`;
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
          <h1 className="text-2xl font-bold">🏢 {companyName}</h1>
          <Badge variant="secondary">
            {total} {offerOnly ? "offers" : "reviews"}
          </Badge>
        </div>
        <Link href="/" className={cn(buttonVariants({ variant: "secondary" }))}>
          ← Back
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href={hrefFor({ view: "all" })} className={pillClass(activeView === "all")}>
          All
        </Link>
        <Link href={hrefFor({ view: "salary" })} className={pillClass(activeView === "salary")}>
          Salary
        </Link>
        <Link href={hrefFor({ view: "interview" })} className={pillClass(activeView === "interview")}>
          Interview
        </Link>
        <Link href={hrefFor({ view: "offer" })} className={pillClass(activeView === "offer")}>
          Offer
        </Link>
        {availableThreadIds.map((tid) => (
          <Link
            key={tid}
            href={hrefFor({ view: "all", thread_id: tid })}
            className={pillClass(activeThreadId === tid)}
          >
            {tid}
          </Link>
        ))}
      </div>

      {offerOnly ? (
        <>
          <Card>
            <CardContent className="pt-6">
              <form action={`/company/${companySlug}`} method="get" className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <input type="hidden" name="view" value="offer" />
                {activeThreadId && <input type="hidden" name="thread_id" value={activeThreadId} />}
                <input type="hidden" name="sort" value={activeOfferSort} />
                <div className="flex-1 space-y-1.5">
                  <label htmlFor="offer-position-search" className="text-sm text-muted-foreground">
                    Filter position
                  </label>
                  <Input
                    id="offer-position-search"
                    name="position"
                    defaultValue={offerPositionQuery}
                    placeholder="Ví dụ: Backend, Frontend, Data..."
                  />
                </div>
                <div className="w-full space-y-1.5 sm:w-48">
                  <label htmlFor="offer-sort" className="text-sm text-muted-foreground">
                    Sort by
                  </label>
                  <SortSelect
                    id="offer-sort"
                    options={OFFER_SORT_OPTIONS}
                    defaultValue="year_desc"
                    className="w-full"
                  />
                </div>
                <Button type="submit">Apply</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between space-y-0 gap-2">
              <span className="font-semibold">Offer board</span>
              <span className="text-sm text-muted-foreground">
                {activeThreadId ? `Thread ${activeThreadId} • ` : ""}
                {total} offer{total !== 1 ? "s" : ""}
              </span>
            </CardHeader>
            {offers.length > 0 ? (
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Position</TableHead>
                        <TableHead>YoE</TableHead>
                        <TableHead>Year</TableHead>
                        <TableHead>Salary</TableHead>
                        <TableHead>Bonus</TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {offers.map((offer, index) => (
                        <TableRow key={`${offer.voz_post_id}-${offer.offer_index}-${index}`}>
                          <TableCell className="min-w-40 font-semibold">{offer.position || "-"}</TableCell>
                          <TableCell>{offer.years_of_experience ?? "-"}</TableCell>
                          <TableCell>{offer.offer_year || "-"}</TableCell>
                          <TableCell className="min-w-40">
                            <div>{offer.salary || formatSalaryMillion(offer.monthly_salary_million)}</div>
                            {offer.salary && offer.monthly_salary_million != null && (
                              <div className="text-xs text-muted-foreground">
                                ≈ {formatSalaryMillion(offer.monthly_salary_million)}/month
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="min-w-40">{offer.bonus || "-"}</TableCell>
                          <TableCell>
                            {offer.url ? (
                              <a href={offer.url} target="_blank" rel="noreferrer" className="hover:underline">
                                View on Voz
                              </a>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            ) : (
              <CardContent className="py-8 text-center text-muted-foreground">
                Không có offer nào khớp filter hiện tại.
              </CardContent>
            )}
          </Card>
        </>
      ) : reviews.length > 0 ? (
        <div className="space-y-3">
          {reviews.map((review) => (
            <ReviewCard key={String(review.voz_post_id ?? review._id ?? Math.random())} review={review} replyChildrenByPostId={replyChildrenByPostId} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Chưa có review cho công ty này.
          </CardContent>
        </Card>
      )}

      {pages > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1">
          <Link
            href={buildPageHref(companySlug, Math.max(1, page - 1), pageParams)}
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
              href={buildPageHref(companySlug, 1, pageParams)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              1
            </Link>
          )}
          {startPage > 2 && <span className="px-2 text-sm text-muted-foreground">...</span>}
          {pageNumbers.map((p) => (
            <Link
              key={p}
              href={buildPageHref(companySlug, p, pageParams)}
              className={buttonVariants({ variant: p === page ? "default" : "outline", size: "sm" })}
            >
              {p}
            </Link>
          ))}
          {endPage < pages - 1 && <span className="px-2 text-sm text-muted-foreground">...</span>}
          {endPage < pages && (
            <Link
              href={buildPageHref(companySlug, pages, pageParams)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {pages}
            </Link>
          )}
          <Link
            href={buildPageHref(companySlug, Math.min(pages, page + 1), pageParams)}
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
