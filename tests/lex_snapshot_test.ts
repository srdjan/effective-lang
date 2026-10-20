// The lexer oracle. fixtures/lex/snapshot.json holds one hash of the lexer
// output (kinds, starts, ends, trivia, triviaEnd, diagnostics) for each input of
// a fixed corpus. The test regenerates the corpus and compares every hash, so a
// refactor of src/core/lex.ts that changes the output for any input fails here.
// scripts/lex_snapshot.ts writes the snapshot.

import { assert, assertEquals } from "@std/assert";
import {
  hashText,
  lexHash,
  type LexSnapshot,
  RANDOM_COUNT,
  randomInputs,
  repositoryInputs,
  SEED,
} from "../scripts/lex_snapshot.ts";

const ROOT = new URL("../", import.meta.url);
const HASH_WIDTH = 16;

function readSnapshot(): LexSnapshot {
  return JSON.parse(
    Deno.readTextFileSync(new URL("fixtures/lex/snapshot.json", ROOT)),
  );
}

Deno.test("the lexer output of 20,000 random strings equals the snapshot", () => {
  const snapshot = readSnapshot();
  assertEquals(snapshot.seed, SEED);
  assertEquals(snapshot.randomCount, RANDOM_COUNT);
  assertEquals(snapshot.random.length, RANDOM_COUNT * HASH_WIDTH);
  const inputs = randomInputs(RANDOM_COUNT);
  const mismatches: string[] = [];
  inputs.forEach((text, index) => {
    const expected = snapshot.random.slice(
      index * HASH_WIDTH,
      (index + 1) * HASH_WIDTH,
    );
    if (lexHash(text) !== expected) {
      mismatches.push(`#${index} ${JSON.stringify(text)}`);
    }
  });
  assertEquals(mismatches.slice(0, 5), []);
  // The corpus must reach strings, escapes, and numbers, or it proves nothing.
  assert(inputs.some((text) => text.includes('"\\')));
  assert(inputs.some((text) => /[0-9][eE][+-]?[0-9]/.test(text)));
  assert(inputs.some((text) => text.includes("\u{1F600}")));
});

Deno.test("the lexer output of each repository .eff and .effi file equals the snapshot", async () => {
  const snapshot = readSnapshot();
  const files = await repositoryInputs(ROOT);
  const expectedCount = Object.keys(snapshot.files).length;
  assert(expectedCount > 100, `the snapshot has ${expectedCount} files`);
  const mismatches: string[] = [];
  let compared = 0;
  for (const [path, [input, output]] of Object.entries(snapshot.files)) {
    const text = files.get(path);
    // A file that a later commit edited or removed has a new input hash. It is
    // not a lexer change, so the comparison skips it.
    if (text === undefined || hashText(text) !== input) continue;
    compared++;
    if (lexHash(text) !== output) mismatches.push(path);
  }
  assertEquals(mismatches, []);
  assert(
    compared * 2 > expectedCount,
    `only ${compared} of ${expectedCount} snapshot files are unchanged`,
  );
});
