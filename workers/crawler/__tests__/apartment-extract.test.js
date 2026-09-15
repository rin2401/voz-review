import { describe, expect, it } from "vitest";

import {
  cleanApartmentName,
  createApartmentExtractor,
  splitApartmentSections,
} from "../apartment-extract.js";
import { apartmentAliasMap, resolveCanonicalApartment } from "../aliases.js";

const extractor = createApartmentExtractor(apartmentAliasMap);

describe("cleanApartmentName", () => {
  it("drops trailing notes in parentheses", () => {
    expect(cleanApartmentName("The Global City (đang xây thô)")).toBe("The Global City");
  });

  it("keeps location qualifiers after a dash", () => {
    expect(cleanApartmentName("Akari City - Bình Tân")).toBe("Akari City - Bình Tân");
  });

  it("drops question-style trailing notes after a dash", () => {
    expect(cleanApartmentName("Akari City - có nên mua không")).toBe("Akari City");
  });
});

describe("extractApartment", () => {
  it("reads the complex after Ten du an label", () => {
    expect(extractor.extractApartment("Tên dự án: The Global City\nQuận 2")).toBe(
      "The Global City",
    );
  });

  it("reads the complex after Du an label", () => {
    expect(extractor.extractApartment("Dự án: Akari City\nVõ Văn Kiệt")).toBe("Akari City");
  });

  it("uses value on the next non-empty line", () => {
    expect(extractor.extractApartment("Tên dự án:\nVinhomes Grand Park\nQuận 9")).toBe(
      "Vinhomes Grand Park",
    );
  });

  it("matches labels behind a numbered-list prefix", () => {
    expect(
      extractor.extractApartment("1. Tên dự án:\nLDG Sky\n2. Vị trí: Bình Dương"),
    ).toBe("LDG Sky");
  });

  it("skips question posts", () => {
    expect(extractor.extractApartment("Cho em hỏi chung cư này thế nào ạ")).toBe("Unknown");
  });

  it("skips label values that are questions", () => {
    expect(extractor.extractApartment("Tên dự án: có nên mua không các bác")).toBe("Unknown");
    expect(extractor.extractApartment("Dự án: tên gì thế các thím")).toBe("Unknown");
  });

  it("falls back to alias candidates found in content", () => {
    expect(extractor.extractApartment("Em đang ở Grand Park gần 2 năm rồi")).toBe(
      "Vinhomes Grand Park",
    );
  });

  it("returns the raw censored name; alias resolution happens in normalizeApartments", () => {
    const raw = extractor.extractApartment("Tên dự án: V*nhome* Gr*nd P*rk");
    expect(raw).toBe("V*nhome* Gr*nd P*rk");
    expect(extractor.normalizeApartments([raw])).toEqual(["V*nhome* Gr*nd P*rk"]);
  });
});

describe("extractApartments", () => {
  it("extracts one complex per section", () => {
    const content = [
      "Tên dự án: Akari City",
      "Đang ở 2 năm, ổn.",
      "",
      "Tên dự án: The Global City",
      "Giao thông tệ giờ tan tầm.",
    ].join("\n");
    expect(extractor.extractApartments(content)).toEqual(["Akari City", "The Global City"]);
  });

  it("resolves aliases to canonical names", () => {
    const content = [
      "Tên dự án: Grand Park",
      "Đang ở 2 năm.",
      "",
      "Tên dự án: EcoGreen Q7",
      "Chỗ ở ổn.",
    ].join("\n");
    expect(extractor.extractApartments(content)).toEqual([
      "Vinhomes Grand Park",
      "EcoGreen",
    ]);
  });

  it("returns a single complex for single-section posts", () => {
    expect(extractor.extractApartments("Tên dự án: Vinhomes Central Park\nQuận 4")).toEqual([
      "Vinhomes Central Park",
    ]);
  });
});

describe("splitApartmentSections", () => {
  it("splits at each Du an label line", () => {
    const content = "Dự án: A\nreview A\nDự án: B\nreview B";
    expect(splitApartmentSections(content)).toHaveLength(2);
  });

  it("keeps the whole content when there is no label", () => {
    expect(splitApartmentSections("just a normal post")).toEqual(["just a normal post"]);
  });
});

describe("resolveCanonicalApartment", () => {
  it("resolves an alias chain to the canonical complex name", () => {
    expect(resolveCanonicalApartment("Vinhomes GP")).toBe("Vinhomes Grand Park");
  });
});
