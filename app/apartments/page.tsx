import Link from "next/link";

import { SortSelect } from "@/components/sort-select";
import { Button } from "@/components/ui/button";
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
import { getAllApartments } from "@/lib/db/apartment-queries";
import { asciiSlug, districtLabel, formatDtVn } from "@/lib/format";

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Quận</TableHead>
                <TableHead>Giá/m2</TableHead>
                <TableHead>Reviews</TableHead>
                <TableHead>Last</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apartments.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Chưa có chung cư nào. Vào tab Threads để thêm thread kind &quot;apartment&quot; và bắt đầu crawl!
                  </TableCell>
                </TableRow>
              ) : (
                apartments.map((apartment) => (
                  <TableRow key={String(apartment.name)}>
                    <TableCell>
                      <Link
                        href={`/apartments/${asciiSlug(String(apartment.name))}`}
                        className="font-semibold text-orange-500 hover:underline"
                      >
                        {apartment.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-foreground/80">
                        {districtLabel(apartment.info?.location) || "-"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-foreground/80">
                        {apartment.info?.price_per_m2 || "-"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-primary/90 px-2 py-0.5 text-xs font-medium text-primary-foreground">
                        {apartment.review_count}
                      </span>
                    </TableCell>
                    <TableCell>
                      {apartment.latest_post_date ? formatDtVn(apartment.latest_post_date) : "-"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
