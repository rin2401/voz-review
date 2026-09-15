import Link from "next/link";

import { ReviewCard } from "@/components/review-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { searchReviews } from "@/lib/db/queries";
import { buildReplyContext } from "@/lib/replies";
import { normalizeReviewCompanies } from "../../workers/crawler/mongo.js";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

export const dynamic = "force-dynamic";

type SearchParams = { q?: string; company?: string; sort?: string };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q = "", company = "", sort = "recent_review" } = await searchParams;
  const activeSort = sort === "likes_desc" ? "likes_desc" : "recent_review";

  let results: Record<string, any>[] = [];
  let replyChildrenByPostId: Record<string, any[]> = {};

  if (q) {
    results = await searchReviews(q, 50);
    if (company) {
      const keyword = company.toLowerCase().trim();
      results = results.filter((result) =>
        normalizeReviewCompanies(result).some((name) => name.toLowerCase().includes(keyword)),
      );
    }
    if (activeSort === "likes_desc") {
      results.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    } else {
      results.sort((a, b) => {
        const key = (item: Record<string, any>) => {
          const value = item.post_date || item.created_at;
          const date = value instanceof Date ? value : new Date(String(value));
          return isNaN(date.getTime()) ? 0 : date.getTime();
        };
        return key(b) - key(a);
      });
    }
    ({ replyChildrenByPostId } = await buildReplyContext(results));
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <form action="/search" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <label htmlFor="search-q" className="text-sm text-muted-foreground">
                Search reviews
              </label>
              <Input
                id="search-q"
                name="q"
                required
                pattern=".*\S.*"
                title="Query không được để trống"
                className="h-10"
                placeholder="Ví dụ: Zalo, Fsoft, CMC, lương, backend..."
                defaultValue={q}
              />
            </div>
            <Button type="submit" className="h-10 px-6">
              Search
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <form action="/search" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="q" value={q} />
            <div className="flex-1 space-y-1.5">
              <label htmlFor="company" className="text-sm text-muted-foreground">
                Filter company
              </label>
              <Input id="company" name="company" placeholder="Ví dụ: Fsoft, Zalo, CMC..." defaultValue={company} />
            </div>
            <div className="w-full space-y-1.5 sm:w-48">
              <label htmlFor="sort" className="text-sm text-muted-foreground">
                Sort by
              </label>
              <select id="sort" name="sort" defaultValue={activeSort} className={selectClass}>
                <option value="recent_review">Recent review</option>
                <option value="likes_desc">Most likes</option>
              </select>
            </div>
            <Button type="submit">Apply</Button>
          </form>
        </CardContent>
      </Card>

      {q && (
        <p className="text-sm text-muted-foreground">
          {results.length > 0
            ? `Tìm thấy ${results.length} kết quả cho "${q}"`
            : `Không tìm thấy kết quả nào cho "${q}"`}
        </p>
      )}

      <div className="space-y-3">
        {results.map((result) => (
          <ReviewCard
            key={String(result.voz_post_id ?? result._id ?? Math.random())}
            review={result}
            replyChildrenByPostId={replyChildrenByPostId}
          />
        ))}
      </div>
    </div>
  );
}
