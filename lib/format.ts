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

// HCMC district names that appear bare (without a "Quận" prefix) in
// apartment info locations, e.g. "Bình Tân (Nam Long, đường Tên Lửa)".
const HCMC_DISTRICTS = [
  "Bình Thạnh", "Bình Tân", "Tân Phú", "Tân Bình", "Phú Nhuận", "Gò Vấp",
  "Bình Chánh", "Nhà Bè", "Hóc Môn", "Củ Chi", "Cần Giờ", "Thủ Đức",
];

// Province abbreviations for the non-HCMC belt (Bình Dương, Long An...).
const PROVINCE_ABBR: Record<string, string> = {
  "Bình Dương": "BD",
  "Long An": "LA",
  "Đồng Nai": "ĐN",
  "Tây Ninh": "TN",
};

/**
 * Short district label for the apartments list table, extracted from the
 * full info location string. "…, Quận 12, Hồ Chí Minh" → "Q.12",
 * "Thành phố Dĩ An, Bình Dương" → "Dĩ An (BD)", bare "Bình Tân" → "Bình Tân".
 */
export function districtLabel(location: string | null | undefined): string {
  if (!location) return "";
  const text = location.trim();

  const quan = text.match(/quận\s+([^,()]+)/i);
  if (quan) {
    const name = quan[1].trim();
    // Pre-2021 "quận Thủ Đức" — Thủ Đức is its own city-level unit now.
    return /thủ đức/i.test(name) ? "Thủ Đức" : `Q.${name}`;
  }

  // Abbreviated "Q9" / "Q.9" style, e.g. "TP.HCM (Q9, Q7)".
  const qAbbr = text.match(/\bQ\.?\s*(\d+)\b/);
  if (qAbbr) return `Q.${qAbbr[1]}`;

  const huyen = text.match(/huyện\s+([^,()]+)/i);
  if (huyen) return huyen[1].trim();

  if (/thành phố\s+thủ đức/i.test(text)) return "Thủ Đức";

  // "…, TP. Dĩ An, tỉnh Bình Dương" → the segment right before the province.
  for (const [province, abbr] of Object.entries(PROVINCE_ABBR)) {
    const before = new RegExp(`([^,()]+),\\s*(?:tỉnh\\s+|TP\\.?\\s*)?${province}`, "i").exec(text);
    if (before) {
      const name = before[1].replace(/^(?:thành phố|TP\\.?)\s+/i, "").trim();
      if (name) return `${name} (${abbr})`;
    }
  }

  const segments = text.split(/[,()/]/).map((part) => part.trim());
  const district = HCMC_DISTRICTS.find((name) =>
    segments.some((part) => part.toLowerCase() === name.toLowerCase()),
  );
  return district || "";
}

/**
 * Compact developer name for the apartments list table:
 * "Công ty Cổ phần Đầu tư Xây dựng BCONS" → "Đầu tư Xây dựng BCONS".
 */
export function shortDeveloper(developer: string | null | undefined): string {
  if (!developer) return "";
  return developer
    .replace(/^Công ty\s+(?:CP|Cổ phần|TNHH|Trách nhiệm hữu hạn)\s+/i, "")
    .replace(/^Công ty\s+/i, "")
    .replace(/^CTCP\s+|^Cty\s+CP\s+/i, "")
    .replace(/\s+Cổ phần\b/gi, " CP")
    .replace(/\s+Trách nhiệm hữu hạn\b/gi, " TNHH")
    .trim();
}

export function schedulerStatusLabel(state: Record<string, any> | null | undefined): string {
  if (!state) return "not_configured";
  if (state.enabled === false) return "disabled";
  return state.last_status || "idle";
}
