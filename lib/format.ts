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
  "Khánh Hòa": "KH",
  "Bà Rịa Vũng Tàu": "BRVT",
  "Bà Rịa - Vũng Tàu": "BRVT",
};

/**
 * Short district label for the apartments list table, extracted from the
 * full info location string. "…, Quận 12, Hồ Chí Minh" → "Q.12",
 * "Thành phố Dĩ An, Bình Dương" → "Dĩ An (BD)", bare "Bình Tân" → "Bình Tân".
 */
export function districtLabel(location: string | null | undefined): string {
  if (!location) return "";
  // bds addresses sometimes come NFD-decomposed ("quận Thủ Đức") — recompose.
  const text = location.trim().normalize("NFC");

  const quan = text.match(/quận\s+([^,()]+)/i);
  if (quan) {
    // "Quận 9 / Đồng Nai (Novaland)" → keep only the first part.
    const name = quan[1].split("/")[0].trim();
    // Pre-2021 "quận Thủ Đức" — Thủ Đức is its own city-level unit now.
    if (/thủ đức/i.test(name)) return "Thủ Đức";
    // Named HCMC districts read better bare: "quận Bình Thạnh" → "Bình Thạnh".
    if (HCMC_DISTRICTS.some((d) => d.toLowerCase() === name.toLowerCase())) return name;
    return `Q.${name}`;
  }

  // Abbreviated "Q9" / "Q.9" style, e.g. "TP.HCM (Q9, Q7)".
  const qAbbr = text.match(/\bQ\.?\s*(\d+)\b/);
  if (qAbbr) return `Q.${qAbbr[1]}`;

  const huyen = text.match(/huyện\s+([^,()]+)/i);
  if (huyen) {
    const name = huyen[1].trim();
    // "Huyện Bến Lức, Long An" → "Bến Lức (LA)"; HCMC huyện stay bare.
    const province = Object.entries(PROVINCE_ABBR).find(([p]) =>
      new RegExp(`,\\s*(?:tỉnh\\s+)?${p}\\b`, "i").test(text),
    );
    return province ? `${name} (${province[1]})` : name;
  }

  if (/thành phố\s+thủ đức/i.test(text)) return "Thủ Đức";

  // "…, TP. Dĩ An, tỉnh Bình Dương" → the segment right before the province.
  for (const [province, abbr] of Object.entries(PROVINCE_ABBR)) {
    const before = new RegExp(`([^,()]+),\\s*(?:tỉnh\\s+|TP\\.?\\s*)?${province}`, "i").exec(text);
    if (before) {
      const name = before[1]
        .trim()
        .replace(/^(?:thành phố|thị xã|TP\.?)\s+/i, "")
        .trim();
      if (name) return `${name} (${abbr})`;
    }
  }

  const segments = text.split(/[,()/]/).map((part) => part.trim());
  const district = HCMC_DISTRICTS.find((name) =>
    segments.some((part) => part.toLowerCase() === name.toLowerCase()),
  );
  return district || "";
}

// Canonical brand names for developers that bds lists under different legal
// entities per project (e.g. "Đầu tư Nam Long" vs "Tập đoàn Nam Long").
// Keys match the shortDeveloper() output exactly.
const DEVELOPER_CANON: Record<string, string> = {
  "Tập đoàn Hưng Thịnh": "Hưng Thịnh",
  "Novaland Group": "Novaland",
  "Đầu tư Xây dựng BCONS": "Bcons",
  "BẤT ĐỘNG SẢN BCONS PS": "Bcons",
  "Song Hỷ Quốc Tế (thuộc Tập đoàn Bcons)": "Bcons",
  "Phát Triển Phú Mỹ Hưng": "Phú Mỹ Hưng",
  "CapitaLand Development (Việt Nam)": "CapitaLand",
  "Tập đoàn Vingroup": "Vingroup",
  "Đầu Tư và Kinh Doanh nhà Khang Điền": "Khang Điền",
  "Địa ốc Sài Gòn Thương Tín (TTC Land)": "TTC Land",
  "Tập đoàn Đất Xanh": "Đất Xanh",
  "Đầu tư Nam Long": "Nam Long",
  "Tập đoàn Nam Long": "Nam Long",
  "Keppel Land Việt Nam": "Keppel Land",
  "Đầu tư & Phát triển Bất động sản An Gia": "An Gia",
  "Gamuda Land Việt Nam": "Gamuda Land",
  "Đầu tư LDG": "LDG",
  "Xây dựng và Kinh doanh Nhà Điền Phúc Thành": "Điền Phúc Thành",
  "Địa ốc Phúc Yên": "Phúc Yên",
  "Tập đoàn Phúc Yên": "Phúc Yên",
  "Tecco Sài Gòn": "Tecco",
  "Tập đoàn Tecco": "Tecco",
  "DHA Corporation": "DHA",
  "MTV Đầu tư DHA": "DHA",
  "MTV Setia Lái Thiêu": "Setia",
  "Thương mại Địa ốc Việt (Vietcomreal)": "Vietcomreal",
  "Tập đoàn Đông Dương (Indochina Group)": "Indochina Group",
  "TẬP ĐOÀN ĐỊA ỐC VẠN XUÂN": "Vạn Xuân",
  "Đầu tư TBS Land": "TBS Land",
  "Đầu tư Địa ốc Đại Quang Minh": "Đại Quang Minh",
  "Phát triển Bất động sản Refico": "Refico",
  "Đầu tư và Phát triển Nhà đất Cotec": "Cotec",
  "Phát triển Bất động sản Phát Đạt": "Phát Đạt",
  "Địa ốc Khải Hoàn Land": "Khải Hoàn",
  "Địa ốc Sacom": "Sacom",
  "Đầu tư và Xây dựng Xuân Mai": "Xuân Mai",
  "Đầu Tư Xây Dựng và Phát Triển Đô Thị Sông Đà": "Sông Đà",
  "Tập đoàn Sun Group": "Sun Group",
  "Tập đoàn Sunshine": "Sunshine",
  "Tập đoàn Ecopark": "Ecopark",
  "Tập đoàn Trung Thủy": "Trung Thủy",
  "Tập đoàn Hưng Thuận": "Hưng Thuận",
  "Tập đoàn Pi Group": "Pi Group",
  "tập đoàn S.S.G": "S.S.G",
  "ĐẦU TƯ BẤT ĐỘNG SẢN HƯNG LỘC PHÁT": "Hưng Lộc Phát",
  "ĐỊA ỐC PHÚ ĐÔNG": "Phú Đông",
  "Đầu tư - Kinh Doanh Nhà (INTRESCO)": "Intresco",
  "Tư vấn -Thương mại - Dịch vụ Địa ốc Hoàng Quân": "Hoàng Quân",
  "Xây dựng - Kinh doanh nhà Gia Hòa": "Gia Hòa",
  "Đầu tư Địa ốc Khang Nam": "Khang Nam",
  "Đầu tư Địa ốc Khang Việt": "Khang Việt",
  "Đầu tư Địa ốc Tiến Phát": "Tiến Phát",
  "Đầu tư Bất Động Sản Rio Land": "Rio Land",
  "Đầu tư Bất động sản Phúc An Gia": "Phúc An Gia",
  "Đầu tư Phát triển Thịnh Hưng Holdings": "Thịnh Hưng",
  "Gotec Việt Nam": "Gotec",
  "EZLAND Việt Nam": "EZLAND",
  "IDE Việt Nam": "IDE",
  "DCT Partner Việt Nam": "DCT Partner",
  "Kusto Home (Kusto Group)": "Kusto",
  "Bất động sản Hiền Phúc (thuộc Tập đoàn Lê Phong)": "Hiền Phúc (Lê Phong)",
  "Đầu tư Phát triển Đô thị A&T Bình Dương (thuộc A&T Group)": "A&T Group",
  "Dịch vụ thương mại - Sản xuất - Xây dựng Đông Mê Kông": "Đông Mê Kông",
  "Đầu tư Thương mại Dịch vụ Địa ôc Thái Dương": "Thái Dương",
  "Thương mại - Dịch vụ - Xây dựng - Kinh doanh Nhà Vạn Thái": "Vạn Thái",
  "Xây dựng - Giao thông - Thương mại Bảo Sơn": "Bảo Sơn",
  "Sản xuất và Thương mại Phúc Đạt": "Phúc Đạt",
  "Xây Dựng Thương mại Thuận Việt": "Thuận Việt",
  "Đầu tư và Xây dựng Số 8 - CiC 8": "CiC 8",
  "Đầu tư xây dựng Phú Sơn Thuận": "Phú Sơn Thuận",
  "Đầu tư Năm Bảy Bảy": "577",
  "PHÁT TRIỂN VSIP-SEMBCORP GATEWAY": "VSIP-SEMBCORP",
};

/**
 * Compact developer name for the apartments list table:
 * "Công ty Cổ phần Đầu tư Xây dựng BCONS" → "Bcons".
 */
export function shortDeveloper(developer: string | null | undefined): string {
  if (!developer) return "";
  const short = developer
    .normalize("NFC")
    .replace(/^Công ty\s+(?:CP|Cổ phần|TNHH|Trách nhiệm hữu hạn)\s+/i, "")
    .replace(/^Công ty\s+/i, "")
    .replace(/^CTCP\s+|^Cty\s+CP\s+/i, "")
    .replace(/\s+Cổ phần\b/gi, " CP")
    .replace(/\s+Trách nhiệm hữu hạn\b/gi, " TNHH")
    .trim();
  return DEVELOPER_CANON[short] ?? short;
}

export function schedulerStatusLabel(state: Record<string, any> | null | undefined): string {
  if (!state) return "not_configured";
  if (state.enabled === false) return "disabled";
  return state.last_status || "idle";
}
