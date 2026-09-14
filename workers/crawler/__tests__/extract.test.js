import { describe, expect, it } from "vitest";

import {
  cleanCompanyName,
  createCompanyExtractor,
  extractMonthlySalaryMillion,
  extractOffer,
  parseOfferYear,
  parseYearsOfExperience,
  splitOfferSections,
} from "../extract.js";
import { aliasMap, normalizeAliases, resolveCanonicalCompany } from "../aliases.js";

const extractor = createCompanyExtractor(aliasMap);

describe("extractMonthlySalaryMillion", () => {
  it("treats a plain monthly number as million", () => {
    expect(extractMonthlySalaryMillion("Lương tháng (gross): 46")).toBe(46);
  });

  it("expands x suffix to tens of million", () => {
    expect(extractMonthlySalaryMillion("Lương tháng/năm (gross): 9x")).toBe(90);
  });

  it("supports mil suffix", () => {
    expect(extractMonthlySalaryMillion("Lương tháng (gross): 28 mil")).toBe(28);
  });

  it("supports m separator decimal", () => {
    expect(extractMonthlySalaryMillion("Lương tháng (gross): 16m5")).toBe(16.5);
  });

  it("returns null for yearly values", () => {
    expect(extractMonthlySalaryMillion("Lương tháng/năm: 1.2 tỷ/năm")).toBeNull();
  });

  it("returns null when no monthly salary label exists", () => {
    expect(extractMonthlySalaryMillion("Bonus: 2 tháng")).toBeNull();
  });
});

describe("extractCompany", () => {
  it("reads the company after Ten cong ty label", () => {
    expect(extractor.extractCompany("Tên công ty: FPT Software\nVị trí: Dev")).toBe(
      "FPT Software",
    );
  });

  it("uses value on the next non-empty line", () => {
    expect(extractor.extractCompany("Tên công ty:\nVNG\nVị trí: Backend")).toBe("VNG");
  });

  it("skips question posts", () => {
    expect(extractor.extractCompany("Cho em hỏi công ty này thế nào ạ")).toBe("Unknown");
  });

  it("keeps single uppercase letter as lowest priority after alias match", () => {
    expect(extractor.extractCompany("Tên công ty: N mới deal xong ở ngân hàng N đỏ")).toBe("NAB");
  });

  it("returns the raw censored name; alias resolution happens in normalizeCompanies", () => {
    expect(extractor.extractCompany("Tên công ty: Bank hiển lùn S*B")).toBe(
      "Bank hiển lùn S*B",
    );
    expect(extractor.extractCompanies("Tên công ty: Bank hiển lùn S*B")).toEqual(["SHB"]);
  });

  it("falls back to alias candidates found in content", () => {
    expect(extractor.extractCompany("Em từng làm ở A*S khoảng 2 năm")).toBe("AWS");
  });
});

describe("extractCompanies", () => {
  it("extracts one company per offer section", () => {
    const content = [
      "Tên công ty: Alpha Tech",
      "Vị trí: Backend Engineer",
      "",
      "Tên công ty",
      "Beta Systems",
      "Vị trí: Data Engineer",
    ].join("\n");
    expect(extractor.extractCompanies(content)).toEqual(["Alpha Tech", "Beta Systems"]);
  });

  it("normalizes aliases and drops Unknown", () => {
    const content = "Công ty: F**\nLương tháng: 50 triệu";
    expect(extractor.extractCompanies(content)).toEqual(["FPT Software"]);
  });
});

describe("extractOffers", () => {
  it("maps sections to matching companies", () => {
    const content = [
      "Tên công ty: Alpha Tech",
      "Vị trí: Backend Engineer",
      "Thời điểm: 2024",
      "Lương tháng/năm: 40 triệu",
      "Bonus: 1 tháng",
      "",
      "Tên công ty",
      "Beta Systems",
      "Vị trí: Data Engineer",
      "Thời điểm: 2025",
      "Lương tháng/năm: 55 triệu",
      "Bonus: 2 tháng",
    ].join("\n");

    const offers = extractor.extractOffers(
      content,
      "Alpha Tech",
      "12345",
      "post-1",
      ["Alpha Tech", "Beta Systems"],
    );

    expect(offers).toHaveLength(2);
    expect(offers.map((offer) => offer.company)).toEqual(["Alpha Tech", "Beta Systems"]);
    expect(offers.map((offer) => offer.offer_index)).toEqual([0, 1]);
  });

  it("returns empty when post id is missing", () => {
    expect(extractor.extractOffers("Tên công ty: Alpha Tech", "Alpha Tech", "12345", null)).toEqual([]);
  });

  it("returns empty without enough offer signals", () => {
    const content = "Tên công ty: Alpha Tech\nGhi chú thêm vài dòng cho đủ dài.";
    expect(extractor.extractOffers(content, "Alpha Tech", "12345", "post-1", [])).toEqual([]);
  });

  it("extracts a single structured offer", () => {
    const content = [
      "Tên công ty: FPT Software",
      "Vị trí: Senior Backend",
      "Thời điểm: 2024",
      "Lương tháng (gross): 46",
      "Bonus: 1 tháng",
      "Số năm kinh nghiệm khi nhận offer: 3",
    ].join("\n");

    const offers = extractor.extractOffers(content, "FPT Software", "12345", "post-1", []);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      company: "FPT Software",
      position: "Senior Backend",
      offer_year: 2024,
      monthly_salary_million: 46,
      bonus: "1 tháng",
      years_of_experience: 3,
      offer_index: 0,
    });
  });
});

describe("cleanCompanyName", () => {
  it("drops trailing notes in parentheses", () => {
    expect(cleanCompanyName("OANDA Coinpass (làm remote, giờ UK")).toBe("OANDA Coinpass");
  });

  it("drops trailing note after comma", () => {
    expect(cleanCompanyName("A***s, Singapore")).toBe("A***s");
  });

  it("keeps wildcard stars used in censored names", () => {
    expect(cleanCompanyName("F**")).toBe("F**");
    expect(cleanCompanyName("FPT Software.")).toBe("FPT Software");
  });
});

describe("splitOfferSections", () => {
  it("returns whole content when fewer than two company sections", () => {
    expect(splitOfferSections("Tên công ty: Alpha\nVị trí: Dev")).toEqual([
      "Tên công ty: Alpha\nVị trí: Dev",
    ]);
  });
});

describe("parse helpers", () => {
  it("parses offer year", () => {
    expect(parseOfferYear("2024")).toBe(2024);
    expect(parseOfferYear("đầu 2023")).toBe(2023);
    expect(parseOfferYear("không rõ")).toBe("không rõ");
    expect(parseOfferYear(null)).toBeNull();
  });

  it("parses years of experience", () => {
    expect(parseYearsOfExperience("3")).toBe(3);
    expect(parseYearsOfExperience("2,5")).toBe(2.5);
    expect(parseYearsOfExperience("gần 4 năm")).toBe(4);
    expect(parseYearsOfExperience(null)).toBeNull();
  });
});

describe("extractOffer", () => {
  it("returns null for Unknown company", () => {
    expect(extractOffer("Vị trí: Dev", "Unknown", "12345", "post-1")).toBeNull();
  });
});

describe("resolveCanonicalCompany", () => {
  it("follows alias chains", () => {
    const map = new Map([
      ["Line Technology Vietnam", "Line Technology"],
      ["Line Technology", "LINE VN"],
      ["LINE VN", "LINE VN"],
    ]);
    expect(resolveCanonicalCompany("Line Technology Vietnam", map)).toBe("LINE VN");
  });

  it("resolves bundled alias entries", () => {
    expect(resolveCanonicalCompany("Bank hiển lùn S*B")).toBe("SHB");
    expect(resolveCanonicalCompany("F****")).toBe("FPT Software");
  });
});

describe("normalizeAliases", () => {
  it("deduplicates and excludes the canonical name", () => {
    expect(
      normalizeAliases([" AXON ", "Axon", "AXON", "Unknown", "", "A**n"], "AXON"),
    ).toEqual(["A**n"]);
  });
});
