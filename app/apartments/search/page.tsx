import { ReviewCard } from "@/components/review-card";
import { SortSelect } from "@/components/sort-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  getApartmentPostsByIds,
  getApartmentRepliesForPosts,
  searchApartmentReviews,
} from "@/lib/db/apartment-queries";
import { getEntityMap } from "@/lib/db/entity-map";
import { buildReplyContext } from "@/lib/replies";
import type { EntityMap } from "@/lib/entity-links";

export const dynamic = "force-dynamic";

type SearchParams = { q?: string; apartment?: string; sort?: string };

export default async function ApartmentSearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q = "", apartment = "", sort = "recent_review" } = await searchParams;
  const activeSort = sort === "likes_desc" ? "likes_desc" : "recent_review";

  let results: Record<string, any>[] = [];
  let topLevelResults: Record<string, any>[] = [];
  let replyChildrenByPostId: Record<string, any[]> = {};
  let entityMap: EntityMap = {};

  if (q) {
    results = await searchApartmentReviews(q, 50);
    if (apartment) {
      const keyword = apartment.toLowerCase().trim();
      results = results.filter((result) =>
        (result.apartments || []).some((name: string) =>
          String(name || "").toLowerCase().includes(keyword),
        ),
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
    ({ replyChildrenByPostId, topLevelReviews: topLevelResults } = await buildReplyContext(results, {
      getPostsByIds: getApartmentPostsByIds,
      getRepliesForPosts: getApartmentRepliesForPosts,
    }));
    entityMap = await getEntityMap();
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <form
            action="/apartments/search"
            method="get"
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1 space-y-1.5">
              <label htmlFor="search-q" className="text-sm text-muted-foreground">
                Search apartment reviews
              </label>
              <Input
                id="search-q"
                name="q"
                required
                pattern=".*\S.*"
                title="Query không được để trống"
                className="h-10"
                placeholder="Ví dụ: bàn giao, giá, Q2, Vinhomes, chung cư..."
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
          <form
            action="/apartments/search"
            method="get"
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <input type="hidden" name="q" value={q} />
            <input type="hidden" name="sort" value={activeSort} />
            <div className="flex-1 space-y-1.5">
              <label htmlFor="apartment" className="text-sm text-muted-foreground">
                Filter apartment
              </label>
              <Input
                id="apartment"
                name="apartment"
                placeholder="Ví dụ: Vinhomes, Akari, The Global City..."
                defaultValue={apartment}
              />
            </div>
            <div className="w-full space-y-1.5 sm:w-48">
              <label htmlFor="sort" className="text-sm text-muted-foreground">
                Sort by
              </label>
              <SortSelect
                id="sort"
                options={[
                  { value: "recent_review", label: "Recent review" },
                  { value: "likes_desc", label: "Most likes" },
                ]}
                defaultValue="recent_review"
                className="w-full"
              />
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
        {topLevelResults.map((result) => (
          <ReviewCard
            key={String(result.voz_post_id ?? result._id ?? Math.random())}
            review={result}
            replyChildrenByPostId={replyChildrenByPostId}
            entityMap={entityMap}
          />
        ))}
      </div>
    </div>
  );
}
