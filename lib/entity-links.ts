// Entity linking: turn known apartment names/aliases found in plain-text
// review content into internal links (Wikipedia-style). Pure helpers, safe
// to use from both server and client components.

import { asciiSlug } from "./format";

export type EntitySegment = { text: string; href?: string };

/** Map apartment names + aliases (lowercased) to their detail page href. */
export function buildApartmentEntityMap(
  apartments: { name: string; aliases?: string[] | null }[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const apartment of apartments) {
    const name = (apartment.name || "").trim();
    if (!name) continue;
    const href = `/apartments/${asciiSlug(name)}`;
    map[name.toLowerCase()] = href;
    for (const rawAlias of apartment.aliases || []) {
      const alias = (rawAlias || "").trim();
      if (!alias) continue;
      const key = alias.toLowerCase();
      if (!map[key]) map[key] = href;
    }
  }
  return map;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;

/**
 * Build a linker that splits plain text into segments, linking every known
 * entity mention. Longest name wins (so "Vinhomes Grand Park" beats
 * "Grand Park"); URLs are masked out; boundaries use unicode letter/number
 * classes so Vietnamese diacritics behave (\b is ASCII-only).
 */
export function createEntityLinker(entityMap: Record<string, string>) {
  const keys = Object.keys(entityMap)
    .filter((key) => key.length >= 3)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const pattern = keys.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${keys.join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;

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
      segments.push({ text: match[0], href: entityMap[match[0].toLowerCase()] });
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
