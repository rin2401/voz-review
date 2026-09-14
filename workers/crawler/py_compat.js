// Python-compatible string/regex helpers shared by the ported extraction logic.
// Keep semantics aligned with crawler/voz_scraper.py (Python re + str methods).

/** Split `text` at most `maxSplit` times, Python re.split/str.split style. */
export function splitMax(text, separator, maxSplit) {
  if (typeof separator === "string") {
    const parts = text.split(separator);
    if (parts.length <= maxSplit + 1) return parts;
    const head = parts.slice(0, maxSplit);
    head.push(parts.slice(maxSplit).join(separator));
    return head;
  }
  const flags = separator.flags.includes("g") ? separator.flags : separator.flags + "g";
  const regex = new RegExp(separator.source, flags);
  const parts = [];
  let lastIndex = 0;
  let match;
  while (parts.length < maxSplit && (match = regex.exec(text))) {
    if (match[0] === "" && regex.lastIndex === match.index) {
      regex.lastIndex += 1;
      continue;
    }
    parts.push(text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
  }
  parts.push(text.slice(lastIndex));
  return parts;
}

/** Python str.islower(): all cased chars lowercase and at least one cased char. */
export function pyIsLower(text) {
  let hasCased = false;
  for (const ch of text) {
    if (/\p{Lu}|\p{Lt}/u.test(ch)) return false;
    if (/\p{Ll}/u.test(ch)) hasCased = true;
  }
  return hasCased;
}

/** Python str.isupper(): all cased chars uppercase and at least one cased char. */
export function pyIsUpper(text) {
  let hasCased = false;
  for (const ch of text) {
    if (/\p{Ll}/u.test(ch)) return false;
    if (/\p{Lu}|\p{Lt}/u.test(ch)) hasCased = true;
  }
  return hasCased;
}

function escapeForCharClass(chars) {
  return chars.replace(/[-[\]\\^$*+{}?().|/]/g, "\\$&");
}

/** Python str.strip(chars) / rstrip(chars). */
export function stripChars(text, chars) {
  const cls = escapeForCharClass(chars);
  return text.replace(new RegExp(`^[${cls}]+|[${cls}]+$`, "g"), "");
}

export function rstripChars(text, chars) {
  const cls = escapeForCharClass(chars);
  return text.replace(new RegExp(`[${cls}]+$`, "g"), "");
}

/** Python re.escape equivalent for embedding a literal in a RegExp. */
export function escapeRegExp(text) {
  return text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

// Python \w for str patterns is Unicode-aware: letters, digits, marks, underscore.
export const WORD_CHARS = "\\p{L}\\p{N}\\p{M}_";
