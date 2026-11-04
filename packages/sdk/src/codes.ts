import { wordlist } from "@scure/bip39/wordlists/english.js";

export const MAX_CODE_LEN = 64;
export const CODE_WORDS = 5;

/**
 * Lowercase ASCII words joined by single spaces, exactly as the contract normalizes them:
 * only ASCII whitespace separates words and only ASCII letters change case.
 */
export function normalizeCode(code: string): string {
  return code
    .split(/[ \t\n\f\r]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/[A-Z]/g, (c) => c.toLowerCase()))
    .join(" ");
}

/** The normalized code, or an error if the contract would refuse to reveal it. */
export function checkedCode(code: string): string {
  const normalized = normalizeCode(code);
  const bytes = new TextEncoder().encode(normalized).length;
  if (bytes === 0 || bytes > MAX_CODE_LEN) throw new RangeError("a code must be 1 to 64 bytes");
  return normalized;
}

/** Five words from the BIP-39 English list, about 55 bits. */
export function generateCode(words = CODE_WORDS): string {
  const picks = crypto.getRandomValues(new Uint16Array(words));
  // 2048 divides 65536, so masking keeps every word equally likely.
  return Array.from(picks, (n) => wordlist[n & 2047]).join(" ");
}

/** Words from the list that start with what has been typed, for autocomplete. */
export function suggestWords(prefix: string, limit = 5): string[] {
  const start = normalizeCode(prefix);
  if (!start) return [];
  return wordlist.filter((word) => word.startsWith(start)).slice(0, limit);
}

export { wordlist };
