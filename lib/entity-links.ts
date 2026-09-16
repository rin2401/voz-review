// Entity linking: turn known apartment names/aliases found in plain-text
// review content into internal links (Wikipedia-style). Pure helpers, safe
// to use from both server and client components.

import { asciiSlug } from "./format";

/** Entity map value: link target + canonical name for the hover tooltip. */
export type EntityLink = { href: string; name: string };
export type EntityMap = Record<string, EntityLink>;

export type EntitySegment = { text: string; href?: string; title?: string };

/**
 * Conversation context: the apartment whose page/conversation the text is
 * rendered in. Short family aliases ("Topaz", "Lumiere", "Bcons"...) point at
 * a corpus-dominant default project, but inside a conversation about a
 * sibling of the same family they should link to that sibling instead.
 */
export type EntityLinkContext = { name: string };

/** Lowercase, diacritic-folded word tokens for subset comparison. */
function foldWords(value: string): string[] {
  const folded = (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Map apartment names + aliases (lowercased) to their detail page href. */
export function buildApartmentEntityMap(
  apartments: { name: string; aliases?: string[] | null }[],
): EntityMap {
  const map: EntityMap = {};
  for (const apartment of apartments) {
    const name = (apartment.name || "").trim();
    if (!name) continue;
    const link: EntityLink = { href: `/apartments/${asciiSlug(name)}`, name };
    map[name.toLowerCase()] = link;
    for (const rawAlias of apartment.aliases || []) {
      const alias = (rawAlias || "").trim();
      if (!alias) continue;
      const key = alias.toLowerCase();
      if (!map[key]) map[key] = link;
    }
  }
  return map;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Company-name quality filter: the companies collection carries many junk
// names from review extraction (censored names, leetspeak, common words and
// whole descriptive sentences). Linking those would produce nonsense links.

const COMPANY_BLOCKLIST = new Set([
  "bank", "green", "cake", "zoom", "grab", "stripe", "amazon", "netflix",
  "masteri", "shiba inu", "amigo", "autonomous", "aspire", "ascend", "manta",
  "spartan", "fossil", "meld", "movi", "opes", "tulpo", "multiplier", "ft",
  "mỹ", "ấn",
]);

const COMPANY_GENERIC_PATTERNS = [
  "công ty", "cty", "outsource", "như", "một brand", "của", "màu",
  "giao hàng", "cá nhỏ", "trực thuộc", "làm về", "tnhh", "private", "hedge",
  "remote", "vi ti ai", "nát têc", "đỏ", "sàn crypto", "product base",
];

/** True when a company name is brand-like enough to be worth linking. */
export function isCleanCompanyName(name: string): boolean {
  const value = (name || "").trim();
  const lower = value.toLowerCase();
  if (value.length < 2) return false;
  // Censored by voz posters ("A***", "M*crosoft") — "Sun* Asterisk" is real.
  if (value.includes("*") && lower !== "sun* asterisk") return false;
  // Leetspeak junk of real brands ("D3K", "H1tachi", "T3chnologi3s").
  if (/[a-z]\d[a-z]/i.test(value)) return false;
  if (COMPANY_BLOCKLIST.has(lower)) return false;
  if (COMPANY_GENERIC_PATTERNS.some((pattern) => lower.includes(pattern))) return false;
  return true;
}

/** Map clean company names + aliases (lowercased) to their detail href. */
export function buildCompanyEntityMap(
  companies: { name: string; aliases?: string[] | null }[],
): EntityMap {
  const map: EntityMap = {};
  for (const company of companies) {
    const name = (company.name || "").trim();
    if (!name || !isCleanCompanyName(name)) continue;
    const link: EntityLink = { href: `/company/${asciiSlug(name)}`, name };
    map[name.toLowerCase()] = link;
    for (const rawAlias of company.aliases || []) {
      const alias = (rawAlias || "").trim();
      if (!alias || !isCleanCompanyName(alias)) continue;
      const key = alias.toLowerCase();
      if (!map[key]) map[key] = link;
    }
  }
  return map;
}

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;

/**
 * Build a linker that splits plain text into segments, linking every known
 * entity mention. Longest name wins (so "Vinhomes Grand Park" beats
 * "Grand Park"); URLs are masked out; boundaries use unicode letter/number
 * classes so Vietnamese diacritics behave (\b is ASCII-only).
 */
export function createEntityLinker(entityMap: EntityMap, context?: EntityLinkContext) {
  const keys = Object.keys(entityMap)
    .filter((key) => key.length >= 3)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const pattern = keys.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${keys.join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;

  // Same-conversation resolution: when every word of a matched short alias
  // also appears in the context apartment's name ("Topaz" ⊂ "Topaz City",
  // "Lumiere" ⊂ "Lumiere Riverside"), the mention almost surely refers to
  // the context apartment, not the alias's default target. Full names of
  // other projects are never overridden ("Bcons City" stays Bcons City even
  // on the Bcons Center City page), so sibling comparisons keep their links.
  const contextWords = context ? new Set(foldWords(context.name)) : null;
  const contextLink: EntityLink | null = context
    ? { href: `/apartments/${asciiSlug(context.name)}`, name: context.name }
    : null;

  function resolveLink(matched: string): EntityLink {
    const key = matched.toLowerCase();
    const link = entityMap[key];
    if (!contextWords || !contextLink || !link) return link;
    const isCanonicalName = link.name.toLowerCase() === key;
    if (isCanonicalName || !link.href.startsWith("/apartments/")) return link;
    const words = foldWords(matched);
    if (words.length && words.every((word) => contextWords.has(word))) {
      return contextLink;
    }
    return link;
  }

  function pushPlain(segments: EntitySegment[], plain: string) {
    if (!plain) return;
    if (!pattern) {
      segments.push({ text: plain });
      return;
    }
    let last = 0;
    for (const match of plain.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > last) segments.push({ text: plain.slice(last, index) });
      const link = resolveLink(match[0]);
      segments.push({ text: match[0], href: link.href, title: link.name });
      last = index + match[0].length;
    }
    if (last < plain.length) segments.push({ text: plain.slice(last) });
  }

  return {
    split(text: string): EntitySegment[] {
      if (!text) return [];
      if (!pattern) return [{ text }];
      const segments: EntitySegment[] = [];
      let last = 0;
      for (const match of text.matchAll(URL_PATTERN)) {
        const index = match.index ?? 0;
        pushPlain(segments, text.slice(last, index));
        segments.push({ text: match[0] });
        last = index + match[0].length;
      }
      pushPlain(segments, text.slice(last));
      return segments;
    },
  };
}
