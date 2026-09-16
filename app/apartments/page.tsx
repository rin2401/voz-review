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
    <ApartmentsTable
      apartments={rows}
      q={q}
      initialSort={sortKey}
      sortOptions={SORT_OPTIONS}
    />
  );
}
