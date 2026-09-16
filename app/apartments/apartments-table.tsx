"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { asciiSlug, districtLabel, formatDtVn, shortDeveloper } from "@/lib/format";

type ApartmentRow = {
  name: string;
  info: {
    location: string | null;
    price_per_m2: string | null;
    developer: string | null;
    status: string | null;
    status_note: string | null;
    handover: string | null;
  } | null;
  review_count: number;
  latest_post_date: string | null;
};

type SortKey =
  | "name"
  | "district"
  | "price"
  | "developer"
  | "status"
  | "reviews"
  | "last";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "district", label: "Quận" },
  { key: "price", label: "Giá/m2" },
  { key: "developer", label: "CĐT" },
  { key: "status", label: "Trạng thái" },
  { key: "reviews", label: "Reviews" },
  { key: "last", label: "Last" },
];

function sortValue(apartment: ApartmentRow, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return apartment.name;
    case "district":
      return districtLabel(apartment.info?.location) || null;
    case "price": {
      const match = (apartment.info?.price_per_m2 || "").match(/(\d+(?:[.,]\d+)?)/);
      return match ? Number(match[1].replace(",", ".")) : null;
    }
    case "developer":
      return shortDeveloper(apartment.info?.developer) || null;
    case "status":
      return apartment.info?.status || null;
    case "reviews":
      return apartment.review_count;
    case "last":
      return apartment.latest_post_date || null;
  }
}

export function ApartmentsTable({ apartments }: { apartments: ApartmentRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return apartments;
    const { key, dir } = sort;
    return [...apartments].sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      // missing values always sink to the bottom
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb), "vi");
      return dir === "asc" ? cmp : -cmp;
    });
  }, [apartments, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map((column) => (
            <TableHead key={column.key}>
              <button
                type="button"
                onClick={() => toggleSort(column.key)}
                className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
                title={`Sort by ${column.label}`}
              >
                {column.label}
                {sort?.key === column.key && (
                  <span className="text-xs">{sort.dir === "asc" ? "▲" : "▼"}</span>
                )}
              </button>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
              Chưa có chung cư nào. Vào tab Threads để thêm thread kind &quot;apartment&quot; và bắt đầu
              crawl!
            </TableCell>
          </TableRow>
        ) : (
          sorted.map((apartment) => (
            <TableRow key={apartment.name}>
              <TableCell>
                <Link
                  href={`/apartments/${asciiSlug(apartment.name)}`}
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
                <span
                  className="block max-w-44 truncate text-sm text-foreground/80"
                  title={apartment.info?.developer || undefined}
                >
                  {shortDeveloper(apartment.info?.developer) || "-"}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className={
                    "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
                    (apartment.info?.status === "Đã bàn giao"
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : apartment.info?.status === "Đang mở bán"
                        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                        : "bg-muted text-foreground/80")
                  }
                  title={apartment.info?.status_note || apartment.info?.status || undefined}
                >
                  {apartment.info?.status || "-"}
                  {apartment.info?.handover ? ` · ${apartment.info.handover}` : ""}
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
  );
}
