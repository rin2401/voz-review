import { describe, expect, it } from "vitest";

import { buildCompanyMatch, escapeRegex } from "../lib/db/queries";
import { buildApartmentEntityMap, createEntityLinker } from "../lib/entity-links";
import { companyToSlug, formatDtVn, formatSalaryMillion, schedulerStatusLabel } from "../lib/format";

describe("formatSalaryMillion", () => {
  it("renders integers without decimals", () => {
    expect(formatSalaryMillion(24)).toBe("24M");
    expect(formatSalaryMillion(24.0)).toBe("24M");
  });

  it("renders floats compactly", () => {
    expect(formatSalaryMillion(1.5)).toBe("1.5M");
  });

  it("passes through null and non-numeric values", () => {
    expect(formatSalaryMillion(null)).toBe("-");
    expect(formatSalaryMillion(undefined)).toBe("-");
    expect(formatSalaryMillion("abc")).toBe("abc");
  });
});

describe("formatDtVn", () => {
  it("converts UTC to Asia/Ho_Chi_Minh (+07)", () => {
    expect(formatDtVn("2026-09-14T04:43:18Z")).toBe("2026-09-14 11:43");
  });

  it("returns dash for empty values", () => {
    expect(formatDtVn(null)).toBe("-");
    expect(formatDtVn("")).toBe("-");
  });
});

describe("companyToSlug", () => {
  it("replaces spaces with dashes", () => {
    expect(companyToSlug("CMC Global")).toBe("CMC-Global");
    expect(companyToSlug("")).toBe("");
  });
});

describe("schedulerStatusLabel", () => {
  it("maps state to labels like the Python helper", () => {
    expect(schedulerStatusLabel(null)).toBe("not_configured");
    expect(schedulerStatusLabel({ enabled: false, last_status: "running" })).toBe("disabled");
    expect(schedulerStatusLabel({ enabled: true, last_status: "success" })).toBe("success");
    expect(schedulerStatusLabel({ enabled: true })).toBe("idle");
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("C++ (Viet Nam)")).toBe("C\\+\\+ \\(Viet Nam\\)");
  });
});

describe("buildCompanyMatch", () => {
  it("matches companies list exactly and legacy company fallback", () => {
    const query = buildCompanyMatch("CMC Global");
    const companyRegex = query.$or[0].companies;
    // Python 3.7+ re.escape leaves spaces alone, only special chars escaped.
    expect(companyRegex.$regex).toBe("^CMC Global$");
    expect(companyRegex.$options).toBe("i");
    const legacyBranch = query.$or[1];
    expect(legacyBranch.$and[1].company.$regex).toBe("^CMC Global$");
  });
});

describe("entity links", () => {
  const entityMap = {
    "vinhomes grand park": "/apartments/Vinhomes-Grand-Park",
    "grand park": "/apartments/Vinhomes-Grand-Park",
    "q7 riverside": "/apartments/Q7-Riverside",
    "bcons miền đông": "/apartments/Bcons-Mien-Dong",
  };

  it("builds the map from names and aliases", () => {
    const map = buildApartmentEntityMap([
      { name: "Vinhomes Grand Park", aliases: ["Grand Park", "VGP"] },
      { name: "Q7 Riverside", aliases: [] },
    ]);
    expect(map["vinhomes grand park"]).toBe("/apartments/Vinhomes-Grand-Park");
    expect(map["grand park"]).toBe("/apartments/Vinhomes-Grand-Park");
    expect(map["vgp"]).toBe("/apartments/Vinhomes-Grand-Park");
    expect(map["q7 riverside"]).toBe("/apartments/Q7-Riverside");
  });

  it("links known entity mentions and keeps the rest as plain text", () => {
    const segments = createEntityLinker(entityMap).split(
      "Mình đang ở Q7 Riverside, định chuyển sang Vinhomes Grand Park.",
    );
    expect(segments).toEqual([
      { text: "Mình đang ở " },
      { text: "Q7 Riverside", href: "/apartments/Q7-Riverside" },
      { text: ", định chuyển sang " },
      { text: "Vinhomes Grand Park", href: "/apartments/Vinhomes-Grand-Park" },
      { text: "." },
    ]);
  });

  it("prefers the longest match (canonical over alias)", () => {
    const segments = createEntityLinker(entityMap).split("Grand Park gần Q7");
    expect(segments[0]).toEqual({ text: "Grand Park", href: "/apartments/Vinhomes-Grand-Park" });
  });

  it("does not link partial words or mentions inside URLs", () => {
    const segments = createEntityLinker(entityMap).split(
      "Xem https://voz.vn/t/q7-riverside-abc và q7riverside nhé",
    );
    expect(segments).toEqual([
      { text: "Xem " },
      { text: "https://voz.vn/t/q7-riverside-abc" },
      { text: " và q7riverside nhé" },
    ]);
  });

  it("matches Vietnamese diacritics case-insensitively", () => {
    const segments = createEntityLinker(entityMap).split("bcons miền đông ở đâu");
    expect(segments[0]).toEqual({ text: "bcons miền đông", href: "/apartments/Bcons-Mien-Dong" });
  });

  it("returns plain text when the map is empty", () => {
    const segments = createEntityLinker({}).split("Q7 Riverside ở đâu");
    expect(segments).toEqual([{ text: "Q7 Riverside ở đâu" }]);
  });
});
