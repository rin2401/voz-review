// Formatting helpers ported from main.py Jinja globals.

const VN_TZ = "Asia/Ho_Chi_Minh";

export function formatDtVn(value: unknown, fmt: string = "%Y-%m-%d %H:%M"): string {
  if (!value) return "-";
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string") {
    date = new Date(value);
  } else {
    return "-";
  }
  if (isNaN(date.getTime())) return "-";

  // strftime-style tokens used by the templates.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const pad = (n: number) => String(n).padStart(2, "0");

  return fmt
    .replace("%Y", get("year"))
    .replace("%m", get("month"))
    .replace("%d", get("day"))
    .replace("%H", get("hour") === "24" ? "00" : get("hour"))
    .replace("%M", get("minute"));
}

export function formatSalaryMillion(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const numeric = typeof value === "number" ? value : Number(value);
  if (isNaN(numeric)) return String(value);
  if (Number.isInteger(numeric)) return `${numeric}M`;
  return `${numeric}M`;
}

export function companyToSlug(name: string): string {
  return (name || "").replace(/ /g, "-");
}

/**
 * URL-safe ASCII slug: strips Vietnamese diacritics (NFD + drop combining
 * marks, with explicit đ/Đ mapping) and joins words with dashes.
 * "Vin Làng Vân" → "Vin-Lang-Van".
 */
export function asciiSlug(name: string): string {
  return (name || "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Decode a dynamic-route slug. Next.js App Router delivers params values
 * still percent-encoded (e.g. "Vin-L%C3%A0ng-V%C3%A2n"), which breaks
 * resolving any name containing Vietnamese diacritics.
 */
export function decodeSlug(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function schedulerStatusLabel(state: Record<string, any> | null | undefined): string {
  if (!state) return "not_configured";
  if (state.enabled === false) return "disabled";
  return state.last_status || "idle";
}
