import Link from "next/link";

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
import { getAllCompanies } from "@/lib/db/queries";
import { companyToSlug, formatDtVn, formatSalaryMillion } from "@/lib/format";

export const revalidate = 300;

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

const SORT_OPTIONS = [
  { value: "az", label: "A-Z" },
  { value: "most_review", label: "Most review" },
  { value: "recent_review", label: "Recent review" },
  { value: "salary_desc", label: "Salary high to low" },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const { q = "", sort = "recent_review" } = await searchParams;
  const sortKey = SORT_OPTIONS.some((option) => option.value === sort) ? sort : "recent_review";

  let companies = await getAllCompanies(sortKey);
  if (q) {
    const keyword = q.toLowerCase().trim();
    companies = companies.filter((company) =>
      String(company.name || "").toLowerCase().includes(keyword),
    );
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
          <form action="/" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <label htmlFor="q" className="text-sm text-muted-foreground">
                Filter company
              </label>
              <Input id="q" name="q" placeholder="Ví dụ: Fsoft, Zalo, CMC..." defaultValue={q} />
            </div>
            <div className="w-full space-y-1.5 sm:w-48">
              <label htmlFor="sort" className="text-sm text-muted-foreground">
                Sort by
              </label>
              <select id="sort" name="sort" defaultValue={sortKey} className={selectClass}>
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit">Apply</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <h2 className="text-lg font-semibold">🏢 Company</h2>
          <span className="text-sm text-muted-foreground">{companies.length} results</span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Reviews</TableHead>
                <TableHead>Monthly Salary</TableHead>
                <TableHead>Last</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    Chưa có công ty nào. Vào tab Threads để bắt đầu crawl!
                  </TableCell>
                </TableRow>
              ) : (
                companies.map((company) => (
                  <TableRow key={String(company.name)}>
                    <TableCell>
                      <Link
                        href={`/company/${companyToSlug(String(company.name))}`}
                        className="font-semibold text-orange-500 hover:underline"
                      >
                        {company.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-primary/90 px-2 py-0.5 text-xs font-medium text-primary-foreground">
                        {company.review_count}
                      </span>
                    </TableCell>
                    <TableCell>{formatSalaryMillion(company.max_monthly_salary_million)}</TableCell>
                    <TableCell>
                      {company.latest_post_date ? formatDtVn(company.latest_post_date) : "-"}
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
