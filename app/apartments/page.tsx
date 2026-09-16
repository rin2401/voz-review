import { SortSelect } from "@/components/sort-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { ApartmentsTable } from "./apartments-table";
import { getAllApartments } from "@/lib/db/apartment-queries";

export const revalidate = 300;

const SORT_OPTIONS = [
  { value: "az", label: "A-Z" },
  { value: "most_review", label: "Most review" },
  { value: "recent_review", label: "Recent review" },
];

export default async function ApartmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const { q = "", sort = "recent_review" } = await searchParams;
  const sortKey = SORT_OPTIONS.some((option) => option.value === sort) ? sort : "recent_review";

  let apartments = await getAllApartments(sortKey);
  if (q) {
    const keyword = q.toLowerCase().trim();
    apartments = apartments.filter((apartment) =>
      String(apartment.name || "").toLowerCase().includes(keyword),
    );
  }
  const rows = apartments.map((apartment) => ({
    name: String(apartment.name || ""),
    info: apartment.info ?? null,
    review_count: Number(apartment.review_count || 0),
    latest_post_date: apartment.latest_post_date
      ? new Date(apartment.latest_post_date).toISOString()
      : null,
  }));

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
          <form action="/apartments" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="sort" value={sortKey} />
            <div className="flex-1 space-y-1.5">
              <label htmlFor="q" className="text-sm text-muted-foreground">
                Filter apartment
              </label>
              <Input id="q" name="q" placeholder="Ví dụ: Vinhomes, Akari, The Global City..." defaultValue={q} />
            </div>
            <div className="w-full space-y-1.5 sm:w-48">
              <label htmlFor="sort" className="text-sm text-muted-foreground">
                Sort by
              </label>
              <SortSelect
                id="sort"
                options={SORT_OPTIONS}
                defaultValue="recent_review"
                className="w-full"
              />
            </div>
            <Button type="submit">Apply</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <h2 className="text-lg font-semibold">🏘️ Apartments</h2>
          <span className="text-sm text-muted-foreground">{apartments.length} results</span>
        </CardHeader>
        <CardContent className="p-0">
          <ApartmentsTable apartments={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
