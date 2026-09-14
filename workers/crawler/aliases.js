// Company alias map + resolution, ported from database/company_aliases.py.
// The alias JSON is bundled into the worker at build time.

import rawAliasPayload from "../../data/company_aliases.json" with { type: "json" };

function buildAliasMap(payload) {
  const map = new Map();
  for (const [alias, canonical] of Object.entries(payload || {})) {
    const aliasKey = (alias || "").trim();
    const canonicalValue = (canonical || "").trim();
    if (!aliasKey) continue;
    map.set(aliasKey, canonicalValue);
  }
  return map;
}

export const aliasMap = buildAliasMap(rawAliasPayload);

/** Resolve an alias chain to its canonical company name. */
export function resolveCanonicalCompany(name, map = aliasMap) {
  const seen = new Set();
  let current = (name || "").trim();
  if (!current) return "";
  while (!seen.has(current)) {
    seen.add(current);
    const mapped = (map.get(current) || "").trim();
    if (!mapped || mapped === current) return current;
    current = mapped;
  }
  return current;
}

/** Normalize raw aliases: strip, drop empty/"Unknown"/canonical, dedupe case-insensitively. */
export function normalizeAliases(rawAliases, canonicalName = null) {
  const normalized = [];
  const seen = new Set();
  const canonicalKey = (canonicalName || "").trim().toLowerCase();
  for (const rawAlias of rawAliases || []) {
    const alias = (rawAlias || "").trim();
    if (!alias || alias === "Unknown") continue;
    const key = alias.toLowerCase();
    if (canonicalKey && key === canonicalKey) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(alias);
  }
  return normalized;
}

let aliasesByCanonicalCache = null;

/** Group the alias map by canonical company name. */
export function buildCompanyAliasesByCanonical(map = aliasMap) {
  const grouped = new Map();
  for (const [rawAlias, rawCanonical] of map.entries()) {
    const canonical = resolveCanonicalCompany(rawCanonical, map);
    const alias = (rawAlias || "").trim();
    if (!alias || !canonical) continue;
    if (!grouped.has(canonical)) grouped.set(canonical, []);
    grouped.get(canonical).push(alias);
  }
  const result = new Map();
  for (const [canonical, aliases] of grouped) {
    result.set(canonical, normalizeAliases(aliases, canonical));
  }
  return result;
}

/** Aliases registered for a canonical company name. */
export function companyAliasesForName(name, map = aliasMap) {
  const canonicalName = (name || "").trim();
  if (!canonicalName) return [];
  if (aliasesByCanonicalCache === null) {
    aliasesByCanonicalCache = buildCompanyAliasesByCanonical(map);
  }
  return aliasesByCanonicalCache.get(canonicalName) || [];
}
