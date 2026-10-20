// Small pure helpers that the front end and the edges share. Nothing here does I/O.

/** Orders two strings by UTF-16 code units, as the default `sort` does. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
