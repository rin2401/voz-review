import { describe, expect, it } from "vitest";

import { buildCompanyMatch, escapeRegex } from "../lib/db/queries";
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
