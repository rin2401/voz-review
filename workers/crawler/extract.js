// Company/offer/salary extraction ported from crawler/voz_scraper.py (VozCrawler).
// Semantics must stay aligned with the Python implementation; see tests in
// workers/crawler/*.test.js and tests/test_multi_company_support.py.

import { aliasMap, resolveCanonicalCompany } from "./aliases.js";
import {
  WORD_CHARS,
  escapeRegExp,
  pyIsLower,
  pyIsUpper,
  rstripChars,
  splitMax,
  stripChars,
} from "./py_compat.js";

const BULLET_PREFIX = /^[•·●▪◦*\-]+\s*/;

// Python \b is Unicode-aware; emulate with word-char lookarounds.
const NOT_WORD = `(?![${WORD_CHARS}])`;
const NOT_WORD_BEFORE = `(?<![${WORD_CHARS}])`;

export function cleanCompanyName(company) {
  company = company.trim();

  // Drop trailing notes in parentheses, e.g. "OANDA Coinpass (làm remote, giờ UK"
  company = splitMax(company, /\s*\(/, 1)[0].trim();

  // Drop trailing note after dash only when the right side looks like a note
  const dashParts = splitMax(company, /\s+[-–—]\s+/, 1);
  if (dashParts.length === 2) {
    const rightSide = dashParts[1].trim();
    const rightLower = rightSide.toLowerCase();
    const noteKeywords = [
      "remote", "onsite", "hybrid", "singapore", "sing", "hà nội", "hn", "hcm", "sài gòn",
      "timezone", "time zone", "uk", "us", "jp", "nhật", "mỹ", "làm", "dự án", "project",
      "outsource", "product", "startup", "review", "xin review", "cho em hỏi", "offer", "rejected",
    ];
    if (rightSide && (pyIsLower(rightSide.slice(0, 1)) || noteKeywords.some((token) => rightLower.includes(token)))) {
      company = dashParts[0].trim();
    }
  }

  // Drop trailing note after comma, e.g. "A***s, Singapore"
  company = splitMax(company, /\s*,\s*/, 1)[0].trim();

  // Clean punctuation around edges but keep wildcard '*' used in censored names
  company = rstripChars(company, ".,;:");
  company = company.replace(
    new RegExp(`^[^${WORD_CHARS}\\s&*]+|[^${WORD_CHARS}\\s&*]+$`, "gu"),
    "",
  );
  return company.trim();
}

export function extractMonthlySalaryMillion(content) {
  const lines = content.split("\n");

  const nextNonEmptyLine = (startIndex) => {
    for (let i = startIndex + 1; i < lines.length; i++) {
      const candidate = lines[i].trim();
      if (candidate) return candidate;
    }
    return "";
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    const lowerLine = line.toLowerCase();
    if (!lowerLine.startsWith("lương tháng") && !lowerLine.startsWith("luong thang")) continue;

    let salaryText;
    if (line.includes(":")) {
      salaryText = splitMax(line, ":", 1)[1].trim();
    } else {
      const parts = splitMax(line, /luong thang|lương tháng/i, 1);
      salaryText = stripChars(parts[parts.length - 1], " :-");
    }

    if (!/\d/.test(salaryText)) salaryText = nextNonEmptyLine(index);

    const lowerSalary = salaryText.toLowerCase();
    if (["năm", "/năm", "year", "/year", "package", "usd", "sgd", "$", "vnd", "k"].some((token) => lowerSalary.includes(token))) {
      return null;
    }

    let m = new RegExp(`(\\d+)\\s*m\\s*(\\d+)${NOT_WORD}`, "u").exec(lowerSalary);
    if (m) {
      const value = parseFloat(`${m[1]}.${m[2]}`);
      if (value > 200) return null;
      return value;
    }

    m = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(m|tr|triệu|mil)${NOT_WORD}`, "u").exec(lowerSalary);
    if (!m) m = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(gross|net)${NOT_WORD}`, "iu").exec(lowerSalary);
    if (!m) m = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*/\\s*tháng${NOT_WORD}`, "iu").exec(lowerSalary);
    if (!m) {
      m = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*x${NOT_WORD}`, "iu").exec(lowerSalary);
      if (m) {
        const value = parseFloat(m[1].replace(",", ".")) * 10;
        if (value > 200) return null;
        return value;
      }
    }
    if (!m) m = new RegExp(`^(\\d+(?:[.,]\\d+)?)$`).exec(lowerSalary);
    if (!m) return null;

    const value = parseFloat(m[1].replace(",", "."));
    if (value > 200) return null;
    return value;
  }

  return null;
}

const LABELED_STOP_PREFIXES = [
  "tên công ty", "tên cty", "công ty", "lương tháng", "luong thang", "vị trí", "vi tri",
  "thời điểm", "thoi diem", "bonus", "số năm kinh nghiệm", "so nam kinh nghiem",
];

export function extractLabeledValue(content, labelPatterns) {
  const lines = content.split("\n");

  const nextNonEmptyLine = (startIndex) => {
    for (let i = startIndex + 1; i < lines.length; i++) {
      const candidate = lines[i].trim();
      if (!candidate) continue;
      const lowerCandidate = candidate.toLowerCase();
      if (LABELED_STOP_PREFIXES.some((prefix) => lowerCandidate.startsWith(prefix))) return "";
      return candidate;
    }
    return "";
  };

  const compiledPatterns = labelPatterns.map((pattern) => new RegExp(pattern, "i"));
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const normalizedLine = line.replace(BULLET_PREFIX, "");
    for (const pattern of compiledPatterns) {
      const match = pattern.exec(normalizedLine);
      if (!match) continue;
      let value = match[1] !== undefined ? match[1].trim() : "";
      if (!value) value = nextNonEmptyLine(index);
      value = rstripChars(value.trim(), ".,;:");
      return value || null;
    }
  }
  return null;
}

export function parseOfferYear(rawValue) {
  if (!rawValue) return null;
  const cleaned = String(rawValue).trim();
  const yearMatch = new RegExp(`${NOT_WORD_BEFORE}(20\\d{2}|19\\d{2})${NOT_WORD}`, "u").exec(cleaned);
  if (yearMatch) return parseInt(yearMatch[1], 10);
  return cleaned || null;
}

export function parseYearsOfExperience(rawValue) {
  if (!rawValue) return null;
  const cleaned = String(rawValue).trim();
  const expMatch = /(\d+(?:[.,]\d+)?)/.exec(cleaned);
  if (expMatch) {
    const value = parseFloat(expMatch[1].replace(",", "."));
    return Number.isInteger(value) ? Math.trunc(value) : value;
  }
  return cleaned || null;
}

export function extractOffer(content, company, vozThreadId, vozPostId) {
  if (!company || company === "Unknown" || !vozPostId) return null;

  const bulletPrefix = "^(?:[•·●▪◦*\\-]+\\s*)?";
  const position = extractLabeledValue(content, [bulletPrefix + "\\s*(?:vị trí|vi tri)\\s*:\\s*(.*)$"]);
  const offerYear = parseOfferYear(
    extractLabeledValue(content, [
      bulletPrefix + "\\s*(?:thời điểm(?:\\s*\\(.*?\\))?|thoi diem(?:\\s*\\(.*?\\))?)\\s*:\\s*(.*)$",
    ]),
  );
  const bonus = extractLabeledValue(content, [
    bulletPrefix + "\\s*bonus\\s*:\\s*\\(.*?\\)\\s*:\\s*(.*)$",
    bulletPrefix + "\\s*bonus(?:\\s*\\(.*?\\))?\\s*:\\s*(.*)$",
    bulletPrefix + "\\s*(?:phúc lợi|phuc loi)\\s*:\\s*(.*)$",
  ]);
  const yearsOfExperience = parseYearsOfExperience(
    extractLabeledValue(content, [
      bulletPrefix + "\\s*(?:số năm kinh nghiệm khi nhận offer|so nam kinh nghiem khi nhan offer)\\s*:\\s*(.*)$",
      bulletPrefix + "\\s*(?:kinh nghiệm khi nhận offer|kinh nghiem khi nhan offer)\\s*:\\s*(.*)$",
    ]),
  );
  const salary = extractLabeledValue(content, [
    bulletPrefix + "\\s*(?:lương tháng/năm(?:\\s*\\(.*?\\))?|luong thang/nam(?:\\s*\\(.*?\\))?)\\s*:\\s*(.*)$",
  ]);
  const monthlySalaryMillion = extractMonthlySalaryMillion(content);

  const offerSignals = [position, offerYear, bonus, yearsOfExperience, monthlySalaryMillion]
    .filter((value) => value !== null && value !== undefined && value !== "").length;
  const lowerContent = content.toLowerCase();
  const hasOfferPhrase = lowerContent.includes("nhận offer") || lowerContent.includes("nhan offer");
  if (offerSignals < 2 && !(hasOfferPhrase && offerSignals >= 1)) return null;

  return {
    voz_thread_id: vozThreadId || "",
    voz_post_id: vozPostId,
    company,
    salary,
    monthly_salary_million: monthlySalaryMillion,
    position,
    offer_year: offerYear,
    bonus,
    years_of_experience: yearsOfExperience,
  };
}

function findCompanySectionStarts(lines) {
  const sectionStarts = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const normalizedLine = line.replace(BULLET_PREFIX, "");
    const lowerLine = normalizedLine.toLowerCase();
    if (/^\s*(?:tên công ty|ten cong ty|tên cty|ten cty)\s*:?/i.test(normalizedLine)) {
      sectionStarts.push(index);
      continue;
    }
    if (/^\s*(?:công ty|cong ty)\s*:/.test(normalizedLine)) {
      sectionStarts.push(index);
      continue;
    }
    if (lowerLine === "công ty" || lowerLine === "cong ty") sectionStarts.push(index);
  }
  return sectionStarts;
}

export function splitOfferSections(content) {
  const lines = content.split("\n");
  const sectionStarts = findCompanySectionStarts(lines);
  if (sectionStarts.length < 2) return [content];

  const sections = [];
  const boundaries = [...sectionStarts, lines.length];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const section = lines.slice(boundaries[i], boundaries[i + 1]).join("\n").trim();
    if (section) sections.push(section);
  }
  return sections.length ? sections : [content];
}

/** Build the alias/canonical candidate list, longest name first (stable sort). */
export function buildCompanyCandidates(map = aliasMap) {
  const candidates = [];
  const seen = new Set();
  for (const [alias, canonical] of map.entries()) {
    for (const rawName of [alias, canonical]) {
      const name = (rawName || "").trim();
      if (name.length < 3) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const pattern = new RegExp(
        `${NOT_WORD_BEFORE}${escapeRegExp(name)}${NOT_WORD}`,
        "iu",
      );
      candidates.push({ name, canonical, pattern });
    }
  }
  candidates.sort((a, b) => b.name.length - a.name.length);
  return candidates;
}

/**
 * Create the extraction bundle bound to an alias map, mirroring VozCrawler's
 * instance methods that depend on self.alias_map / self.company_candidates.
 */
export function createCompanyExtractor(map = aliasMap) {
  const candidates = buildCompanyCandidates(map);
  const applyCompanyAlias = (company) => resolveCanonicalCompany(company, map);

  function normalizeCompanies(companies) {
    const normalized = [];
    const seen = new Set();
    for (const rawCompany of companies || []) {
      const company = applyCompanyAlias((rawCompany || "").trim());
      if (!company || company === "Unknown") continue;
      const key = company.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(company);
    }
    return normalized;
  }

  function extractCompany(content) {
    const lines = content.split("\n");

    // Skip if this looks like a question/request post
    const skipPhrases = ["xin review", "cho em hỏi", "cho mình hỏi", "có ai", "tuyển", "nhận offer", "hỏi về", "cần hỏi"];
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

    const normalizeExtractedCompany = (rawCompany) => {
      const company = cleanCompanyName(rawCompany);
      const words = company.split(/\s+/).filter((w) => w && !["-", "–", "—"].includes(w));
      if (!company || !pyIsUpper(company[0])) return ["", false];
      if (words.length > 6) return ["", false];
      if (company.length < 1 || company.length > 60) return ["", false];
      if (words.length > 1 && words[0].length === 1 && pyIsUpper(company[0])) {
        const second = words[1];
        const isCensored = second.includes("*");
        const isNormalWord = second.length > 1 && pyIsUpper(second[0]);
        if (!isCensored && !isNormalWord) return [words[0], true];
      }
      return [company, company.length === 1 && pyIsUpper(company)];
    };

    let singleLetterCandidate = "";

    // Look for "Tên công ty:" / "Tên cty:" at the START of a line
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      const normalizedLine = line.replace(BULLET_PREFIX, "");
      const lowerLine = normalizedLine.toLowerCase();
      if (lowerLine.startsWith("tên công ty") || lowerLine.startsWith("tên cty")) {
        let company;
        if (normalizedLine.includes(":")) {
          company = splitMax(normalizedLine, ":", 1)[1].trim();
        } else if (lowerLine.startsWith("tên cty")) {
          company = (splitMax(normalizedLine, /tên cty/i, 1)[1] ?? normalizedLine).trim();
        } else {
          company = (splitMax(normalizedLine, /tên công ty/i, 1)[1] ?? normalizedLine).trim();
        }

        if (!company) company = nextNonEmptyLine(index);

        // Skip if it's clearly not a company name
        if (company.length < 1) return "Unknown";
        if (["xin", "hỏi", "review", "cho", "em ", "mình "].some((x) => company.toLowerCase().includes(x))) {
          return "Unknown";
        }

        const [normalizedCompany, isSingleLetter] = normalizeExtractedCompany(company);
        if (normalizedCompany && !isSingleLetter) return normalizedCompany;
        if (normalizedCompany && isSingleLetter && !singleLetterCandidate) {
          singleLetterCandidate = normalizedCompany;
        }
      }
    }

    // Also try: starts with "Công ty" as a standalone line or label
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      const normalizedLine = line.replace(BULLET_PREFIX, "");
      const lowerLine = normalizedLine.toLowerCase();
      if (lowerLine.startsWith("công ty") && normalizedLine.length < 80) {
        let remainder = normalizedLine.slice("công ty".length).trim();
        if (remainder.startsWith(":")) remainder = remainder.slice(1).trim();
        const company = remainder || nextNonEmptyLine(index);
        const [normalizedCompany, isSingleLetter] = normalizeExtractedCompany(company);
        if (normalizedCompany && !isSingleLetter) return normalizedCompany;
        if (normalizedCompany && isSingleLetter && !singleLetterCandidate) {
          singleLetterCandidate = normalizedCompany;
        }
      }
    }

    // Fallback: longest matching alias/canonical name inside content for Unknown posts
    for (const candidate of candidates) {
      if (candidate.pattern.test(content)) return candidate.canonical;
    }

    if (singleLetterCandidate) return singleLetterCandidate;

    return "Unknown";
  }

  function extractCompanies(content) {
    const sections = splitOfferSections(content);
    const extractedCompanies = [];

    if (sections.length > 1) {
      for (const section of sections) {
        const company = extractCompany(section);
        if (company && company !== "Unknown") extractedCompanies.push(company);
      }
    }

    if (!extractedCompanies.length) {
      const company = extractCompany(content);
      if (company && company !== "Unknown") extractedCompanies.push(company);
    }

    return normalizeCompanies(extractedCompanies);
  }

  function extractOffers(content, company, vozThreadId, vozPostId, companies = null) {
    if (!vozPostId) return [];

    const normalizedCompanies = normalizeCompanies(companies || []);
    const fallbackCompany = normalizedCompanies.length
      ? normalizedCompanies[0]
      : applyCompanyAlias(company || "Unknown");
    const sections = splitOfferSections(content);
    const offerDocs = [];

    for (let index = 0; index < sections.length; index++) {
      const section = sections[index];
      let sectionCompany = extractCompany(section);
      if (!sectionCompany || sectionCompany === "Unknown") {
        if (index < normalizedCompanies.length) sectionCompany = normalizedCompanies[index];
        else sectionCompany = fallbackCompany;
      }
      sectionCompany = applyCompanyAlias(sectionCompany || "Unknown");

      const offerDoc = extractOffer(section, sectionCompany, vozThreadId, vozPostId);
      if (offerDoc) {
        offerDoc.offer_index = index;
        offerDocs.push(offerDoc);
      }
    }

    if (offerDocs.length) return offerDocs;

    const fallbackDoc = extractOffer(content, fallbackCompany, vozThreadId, vozPostId);
    if (fallbackDoc) {
      fallbackDoc.offer_index = 0;
      return [fallbackDoc];
    }
    return [];
  }

  return {
    candidates,
    applyCompanyAlias,
    normalizeCompanies,
    cleanCompanyName,
    extractMonthlySalaryMillion,
    extractOffer,
    extractOffers,
    extractCompanies,
    extractCompany,
  };
}

export const defaultCompanyExtractor = createCompanyExtractor(aliasMap);
