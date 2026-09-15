// Apartment complex (chung cư) name extraction. Mirrors createCompanyExtractor
// from extract.js but with apartment labels ("Tên dự án:" / "Dự án:") and the
// apartment alias fixture; no offer/salary extraction for apartment reviews.

import { apartmentAliasMap, resolveCanonicalApartment } from "./aliases.js";
import { buildCompanyCandidates } from "./extract.js";
import {
  WORD_CHARS,
  rstripChars,
  splitMax,
} from "./py_compat.js";

const BULLET_PREFIX = /^[•·●▪◦*\-]+\s*/;

// Numbered-list prefixes ("1. Tên dự án:") are common in these threads.
const LIST_PREFIX = /^(?:[•·●▪◦*\-]+|\d+[.)])\s*/;

function stripListPrefix(line) {
  return line.replace(LIST_PREFIX, "");
}

/**
 * Clean a raw apartment name. Unlike cleanCompanyName, location qualifiers
 * (quận/Q7/TP HCM/Thủ Đức...) are part of many complex names, so only
 * note-like trailing junk is dropped.
 */
export function cleanApartmentName(apartment) {
  apartment = (apartment || "").trim();

  // Drop trailing notes in parentheses, e.g. "The Global City (đang xây)"
  apartment = splitMax(apartment, /\s*\(/, 1)[0].trim();

  // Drop trailing note after dash only when the right side looks like a note
  const dashParts = splitMax(apartment, /\s+[-–—]\s+/, 1);
  if (dashParts.length === 2) {
    const rightSide = dashParts[1].trim();
    const rightLower = rightSide.toLowerCase();
    const noteKeywords = [
      "review", "xin review", "cho em hỏi", "cho mình hỏi", "có nên",
      "thế nào", "the nao", "tư vấn", "tu van", "hỏi", "hoi", "đánh giá", "danh gia",
    ];
    if (rightSide && noteKeywords.some((token) => rightLower.includes(token))) {
      apartment = dashParts[0].trim();
    }
  }

  // Drop trailing note after comma, e.g. "Akari City, Nam Long"
  apartment = splitMax(apartment, /\s*,\s*/, 1)[0].trim();

  // Clean punctuation around edges but keep wildcard '*' used in censored names
  apartment = rstripChars(apartment, ".,;:");
  apartment = apartment.replace(
    new RegExp(`^[^${WORD_CHARS}\\s&*]+|[^${WORD_CHARS}\\s&*]+$`, "gu"),
    "",
  );
  return apartment.trim();
}

function findApartmentSectionStarts(lines) {
  const sectionStarts = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const normalizedLine = stripListPrefix(line);
    if (/^\s*(?:tên dự án|ten du an|tên du an|dự án|du an)\s*:?/i.test(normalizedLine)) {
      sectionStarts.push(index);
    }
  }
  return sectionStarts;
}

export function splitApartmentSections(content) {
  const lines = content.split("\n");
  const sectionStarts = findApartmentSectionStarts(lines);
  if (sectionStarts.length < 2) return [content];

  const sections = [];
  const boundaries = [...sectionStarts, lines.length];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const section = lines.slice(boundaries[i], boundaries[i + 1]).join("\n").trim();
    if (section) sections.push(section);
  }
  return sections.length ? sections : [content];
}

/**
 * Create the apartment extraction bundle bound to an alias map, mirroring
 * createCompanyExtractor from extract.js.
 */
export function createApartmentExtractor(map = apartmentAliasMap) {
  const candidates = buildCompanyCandidates(map);
  const applyApartmentAlias = (apartment) => resolveCanonicalApartment(apartment);

  function normalizeApartments(apartments) {
    const normalized = [];
    const seen = new Set();
    for (const rawApartment of apartments || []) {
      const apartment = applyApartmentAlias((rawApartment || "").trim());
      if (!apartment || apartment === "Unknown") continue;
      const key = apartment.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(apartment);
    }
    return normalized;
  }

  function extractApartment(content) {
    const lines = content.split("\n");

    // Skip if this looks like a question/request post
    const skipPhrases = [
      "xin review", "xin đánh giá", "xin ít", "cho em hỏi", "cho mình hỏi", "cho các bác",
      "có ai", "có nên", "tư vấn", "hỏi về", "cần hỏi", "cần tư vấn", "cho e hỏi",
    ];
    const firstLine = lines.length ? lines[0].toLowerCase() : "";
    if (skipPhrases.some((phrase) => firstLine.includes(phrase))) {
      if (!content.toLowerCase().includes("said:")) return "Unknown";
    }

    const nextNonEmptyLine = (startIndex) => {
      for (let i = startIndex + 1; i < lines.length; i++) {
        const candidate = lines[i].trim();
        if (candidate) return candidate;
      }
      return "";
    };

    const normalizeExtractedApartment = (rawApartment) => {
      const apartment = cleanApartmentName(rawApartment);
      const words = apartment.split(/\s+/).filter((w) => w && !["-", "–", "—"].includes(w));
      if (!apartment) return ["", false];
      if (words.length > 8) return ["", false];
      if (apartment.length < 3 || apartment.length > 80) return ["", false];
      return [apartment, false];
    };

    // Look for "Tên dự án:" / "Dự án:" at the START of a line (optionally
    // behind a bullet or numbered-list prefix)
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      const normalizedLine = stripListPrefix(line);
      const lowerLine = normalizedLine.toLowerCase();
      if (
        !lowerLine.startsWith("tên dự án") &&
        !lowerLine.startsWith("ten du an") &&
        !lowerLine.startsWith("dự án") &&
        !lowerLine.startsWith("du an")
      ) {
        continue;
      }

      let apartment;
      if (normalizedLine.includes(":")) {
        apartment = splitMax(normalizedLine, ":", 1)[1].trim();
      } else {
        apartment = (splitMax(normalizedLine, /(?:tên dự án|ten du an|dự án|du an)/i, 1)[1] ?? "").trim();
      }

      if (!apartment) apartment = nextNonEmptyLine(index);

      // Skip if it's clearly not a complex name
      if (apartment.length < 3) return "Unknown";
      if (["xin", "hỏi", "hoi", "cho em", "cho mình", "có nên", "thế nào", "the nao", "tư vấn", "tu van", "tên gì", "ten gi"].some((x) => apartment.toLowerCase().includes(x))) {
        return "Unknown";
      }

      const [normalizedApartment] = normalizeExtractedApartment(apartment);
      if (normalizedApartment) return normalizedApartment;
    }

    // Fallback: longest matching alias/canonical name inside content
    for (const candidate of candidates) {
      if (candidate.pattern.test(content)) return candidate.canonical;
    }

    return "Unknown";
  }

  function extractApartments(content) {
    const sections = splitApartmentSections(content);
    const extractedApartments = [];

    if (sections.length > 1) {
      for (const section of sections) {
        const apartment = extractApartment(section);
        if (apartment && apartment !== "Unknown") extractedApartments.push(apartment);
      }
    }

    if (!extractedApartments.length) {
      const apartment = extractApartment(content);
      if (apartment && apartment !== "Unknown") extractedApartments.push(apartment);
    }

    return normalizeApartments(extractedApartments);
  }

  return {
    candidates,
    applyApartmentAlias,
    normalizeApartments,
    cleanApartmentName,
    extractApartment,
    extractApartments,
  };
}

export const defaultApartmentExtractor = createApartmentExtractor(apartmentAliasMap);
