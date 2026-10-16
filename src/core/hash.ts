// A small synchronous content hash. FNV-1a with 64 bits, over UTF-16 code units.
// The incremental model uses it to compare header text and body text. It is not
// a cryptographic hash. A later part adds SHA-256 for builtin specialization (Q1).

const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;

/** FNV-1a 64 over the UTF-16 code units of `text`. Returns 16 lowercase hex digits. */
export function fnv1a64(text: string): string {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * PRIME);
  }
  return hash.toString(16).padStart(16, "0");
}
