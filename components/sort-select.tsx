"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * URL-driven shadcn Select: picking an option navigates with the updated
 * query param, preserving every other param. The surrounding GET form keeps
 * a hidden input with the same param so its Apply button stays in sync.
 */
export function SortSelect({
  options,
  param = "sort",
  defaultValue,
  id,
  className,
}: {
  options: { value: string; label: string }[];
  param?: string;
  defaultValue: string;
  id?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get(param) ?? defaultValue;
  const label = options.find((option) => option.value === current)?.label ?? current;

  function handleChange(value: string | null) {
    if (!value) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(param, value);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <Select value={current} onValueChange={handleChange}>
      <SelectTrigger id={id} className={className}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
