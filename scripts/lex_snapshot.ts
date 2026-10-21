// The oracle for the lexer. It lexes a fixed corpus and writes one hash of the
// lexer output for each input into fixtures/lex/snapshot.json. The corpus is
// 20,000 random strings from a fixed seed over the lexer alphabet, plus every
// .eff and .effi file of the repository. tests/lex_snapshot_test.ts regenerates
// the corpus and compares the hashes, so a change of the lexer output for any
// input shows as a failure.
//
// The snapshot records the lexer of the revision that wrote it. Run
// `deno run --allow-read --allow-write scripts/lex_snapshot.ts` only after a
// deliberate change of the lexer output. A refactor of the lexer must not run it.

import { compareText } from "../src/core/mod.ts";
import { lex, type Lexed } from "../src/core/lex.ts";

/** The number of random strings. */
export const RANDOM_COUNT = 20_000;

/** The seed of the random strings. */
export const SEED = 0x1ec5;

/**
 * The alphabet of the random strings: quotes, escapes, CR, LF, digits,
 * exponents, operators, brackets, a byte-order mark, non-ASCII letters, an
 * astral character, and a lone high surrogate.
 */
const ALPHABET: readonly string[] = [
  ..." \t\n\r\"'`\\u0aZz_$09.eE+-*/|&=!<>()[]{},:;?@#x01",
  "é",
  "ü",
  " ",
  "﻿",
  "\u{1F600}",
  "\ud83d",
];

/** Directories that hold no repository sources, or that git ignores. */
const SKIPPED = new Set([
  ".git",
  ".claude",
  ".playwright-mcp",
  "node_modules",
  "demos",
  "dist",
]);

/** A small seeded generator (mulberry32). It returns numbers in [0, 1). */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The random strings. The same seed always gives the same strings. */
export function randomInputs(count: number = RANDOM_COUNT): string[] {
  const next = generator(SEED);
  const inputs: string[] = [];
  for (let k = 0; k < count; k++) {
    const length = Math.floor(next() * 40);
    let text = "";
    for (let i = 0; i < length; i++) {
      text += ALPHABET[Math.floor(next() * ALPHABET.length)];
    }
    inputs.push(text);
  }
  return inputs;
}

/** Reads every .eff and .effi file under the root. The keys are root-relative paths. */
export async function repositoryInputs(
  root: URL,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(new URL(directory, root))) {
      entries.push(entry);
    }
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory) {
        if (!SKIPPED.has(entry.name)) await visit(`${path}/`);
      } else if (
        entry.isFile && (path.endsWith(".eff") || path.endsWith(".effi"))
      ) {
        found.set(path, await Deno.readTextFile(new URL(path, root)));
      }
    }
  };
  await visit("");
  return found;
}

/** A 64-bit hash (two 32-bit FNV style lanes) of a text, as 16 hex digits. */
export function hashText(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b ^ c, 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The hash of the whole lexer output of a text: tokens, trivia, and diagnostics. */
export function lexHash(text: string): string {
  const lexed: Lexed = lex("f", text);
  return hashText(JSON.stringify([
    Array.from(lexed.kinds),
    Array.from(lexed.starts),
    Array.from(lexed.ends),
    Array.from(lexed.trivia.kinds),
    Array.from(lexed.trivia.starts),
    Array.from(lexed.trivia.ends),
    Array.from(lexed.triviaEnd),
    lexed.diagnostics,
  ]));
}

/** The content of the snapshot file. */
export interface LexSnapshot {
  readonly seed: number;
  readonly randomCount: number;
  /** The lexer hashes of the random strings, 16 hex digits each, in order. */
  readonly random: string;
  /** For each repository file: the hash of its text and the hash of its lexer output. */
  readonly files: Readonly<
    Record<string, readonly [input: string, output: string]>
  >;
}

export function buildSnapshot(
  random: readonly string[],
  files: ReadonlyMap<string, string>,
): LexSnapshot {
  const entries: Record<string, readonly [string, string]> = {};
  for (const [path, text] of [...files].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    entries[path] = [hashText(text), lexHash(text)];
  }
  return {
    seed: SEED,
    randomCount: random.length,
    random: random.map(lexHash).join(""),
    files: entries,
  };
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url);
  const snapshot = buildSnapshot(
    randomInputs(),
    await repositoryInputs(root),
  );
  const target = new URL("fixtures/lex/snapshot.json", root);
  await Deno.mkdir(new URL("./", target), { recursive: true });
  await Deno.writeTextFile(target, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `wrote fixtures/lex/snapshot.json: ${snapshot.randomCount} random inputs, ${
      Object.keys(snapshot.files).length
    } files`,
  );
}
