"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

type Filters = { district: string; price: string; developer: string; status: string };

const PRICE_BUCKETS: { value: string; label: string; test: (min: number) => boolean }[] = [
  { value: "lt40", label: "< 40 triệu/m2", test: (min) => min < 40 },
  { value: "40-60", label: "40 - 60 triệu/m2", test: (min) => min >= 40 && min < 60 },
  { value: "60-80", label: "60 - 80 triệu/m2", test: (min) => min >= 60 && min < 80 },
  { value: "80-100", label: "80 - 100 triệu/m2", test: (min) => min >= 80 && min < 100 },
  { value: "gt100", label: "> 100 triệu/m2", test: (min) => min >= 100 },
];

function minPricePerM2(apartment: ApartmentRow): number | null {
  const match = (apartment.info?.price_per_m2 || "").match(/(\d+(?:[.,]\d+)?)/);
  return match ? Number(match[1].replace(",", ".")) : null;
}

export function ApartmentsTable({ apartments }: { apartments: ApartmentRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Filters>({
    district: "all",
    price: "all",
    developer: "all",
    status: "all",
  });

  const districts = useMemo(() => {
    const set = new Set<string>();
    for (const apartment of apartments) {
      const label = districtLabel(apartment.info?.location);
      if (label) set.add(label);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "vi"));
  }, [apartments]);

  const developers = useMemo(() => {
    const set = new Set<string>();
    for (const apartment of apartments) {
      const label = shortDeveloper(apartment.info?.developer);
      if (label) set.add(label);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "vi"));
  }, [apartments]);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const apartment of apartments) {
      if (apartment.info?.status) set.add(apartment.info.status);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "vi"));
  }, [apartments]);

  const filtered = useMemo(() => {
    return apartments.filter((apartment) => {
      if (filters.district !== "all") {
        if ((districtLabel(apartment.info?.location) || "-") !== filters.district) return false;
      }
      if (filters.price !== "all") {
        const min = minPricePerM2(apartment);
        const bucket = PRICE_BUCKETS.find((b) => b.value === filters.price);
        if (!bucket || min == null || !bucket.test(min)) return false;
      }
      if (filters.developer !== "all") {
        if ((shortDeveloper(apartment.info?.developer) || "-") !== filters.developer) return false;
      }
      if (filters.status !== "all") {
        if ((apartment.info?.status || "-") !== filters.status) return false;
      }
      return true;
    });
  }, [apartments, filters]);

  const hasFilters = Object.values(filters).some((value) => value !== "all");

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const { key, dir } = sort;
    return [...filtered].sort((a, b) => {
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
  }, [filtered, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }

  function setFilter(key: keyof Filters, value: string | null) {
    if (value == null) return;
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 px-4 pt-4">
        <FilterSelect
          label="Quận"
          value={filters.district}
          options={districts.map((d) => ({ value: d, label: d }))}
          onChange={(value) => setFilter("district", value)}
        />
        <FilterSelect
          label="Mức giá"
          value={filters.price}
          options={PRICE_BUCKETS.map((b) => ({ value: b.value, label: b.label }))}
          onChange={(value) => setFilter("price", value)}
        />
        <FilterSelect
          label="CĐT"
          value={filters.developer}
          options={developers.map((d) => ({ value: d, label: d }))}
          onChange={(value) => setFilter("developer", value)}
        />
        <FilterSelect
          label="Trạng thái"
          value={filters.status}
          options={statuses.map((s) => ({ value: s, label: s }))}
          onChange={(value) => setFilter("status", value)}
        />
        {hasFilters && (
          <div className="flex items-center gap-2 pb-0.5">
            <span className="text-xs text-muted-foreground">
              {sorted.length}/{apartments.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setFilters({ district: "all", price: "all", developer: "all", status: "all" })
              }
            >
              Xóa lọc
            </Button>
          </div>
        )}
      </div>
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
              {hasFilters
                ? "Không có chung cư nào khớp bộ lọc."
                : 'Chưa có chung cư nào. Vào tab Threads để thêm thread kind "apartment" và bắt đầu crawl!'}
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
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <div className="w-full space-y-1.5 sm:w-44">
      <label className="text-sm text-muted-foreground">{label}</label>
      {/* Wrapper div: Base UI appends a hidden input after the trigger (see SortSelect) */}
      <div>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue>{value === "all" ? "Tất cả" : (current?.label ?? value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
