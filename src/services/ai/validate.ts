/**
 * Language and content sanity checks applied to anything the model returns.
 * The product is Arabic-only, so an English leak would break the RTL layout.
 */

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN = /[A-Za-z]/g;

export function arabicCharCount(text: string): number {
  return (text.match(ARABIC) || []).length;
}

export function latinCharCount(text: string): number {
  return (text.match(LATIN) || []).length;
}

/** Share of letters that are Arabic, ignoring all non-letters. */
export function arabicRatio(text: string): number {
  const ar = arabicCharCount(text);
  const la = latinCharCount(text);
  const total = ar + la;
  return total === 0 ? 0 : ar / total;
}

/** True when a string is predominantly Arabic. */
export function isArabic(text: string, minRatio = 0.6): boolean {
  return arabicRatio(text) >= minRatio;
}

/** Collect every user-visible string so the whole payload can be checked at once. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

/** Fraction of collected strings that are predominantly Arabic. */
export function payloadArabicRatio(value: unknown): number {
  const strings = collectStrings(value);
  if (strings.length === 0) return 0;
  const arabic = strings.filter((s) => isArabic(s)).length;
  return arabic / strings.length;
}

/** Model output is stored as plain text — strip anything that looks like markup. */
export function sanitizeModelText(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/\n?```/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
