// Small pure helpers that the front end and the edges share. Nothing here does I/O.

/** Orders two strings by UTF-16 code units, as the default `sort` does. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The message of a thrown value: the `message` of an `Error`, else its string form. */
export function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** True for a plain JSON object: not null and not an array. */
export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
