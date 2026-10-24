// The tutorial quotes `fixtures/tutorial/`. These tests keep each quoted block
// and the shown contract diagnostic equal to what the project and compiler give.

import { assert, assertEquals } from "@std/assert";
import { Program } from "../src/core/frontend.ts";
import { main } from "../src/cli/main.ts";
import { memoryIo, under } from "./cli_helpers.ts";

const TUTORIAL = Deno.readTextFileSync(
  new URL("../docs/tutorial.md", import.meta.url),
);
const SOURCES = ["effektive.json", "deno.json", "library.eff", "loans.eff"];
const FILES: Record<string, string> = Object.fromEntries(
  [...SOURCES, "main.ts"].map((name) => [
    name,
    Deno.readTextFileSync(
      new URL(`../fixtures/tutorial/${name}`, import.meta.url),
    ),
  ]),
);

function check(files: Record<string, string>) {
  const updated = new Program().update({ set: files });
  assert(updated.ok);
  return updated.value.diagnostics;
}

function sources(): Record<string, string> {
  return Object.fromEntries(SOURCES.map((name) => [name, FILES[name]!]));
}

Deno.test("each eff, ts, and json block of the tutorial is in the tutorial project", () => {
  const blocks = [...TUTORIAL.matchAll(/```(eff|ts|json)\n([\s\S]*?)```/g)];
  assert(blocks.length >= 12, `${blocks.length} blocks`);
  for (const [, , body] of blocks) {
    assert(
      Object.values(FILES).some((text) => text.includes(body!)),
      `not in fixtures/tutorial:\n${body}`,
    );
  }
});

Deno.test("the tutorial project checks without diagnostics", () => {
  assertEquals(check(sources()), []);
});

Deno.test("Step 7 shows the diagnostic before the second module exists", async () => {
  const library = [
    ...TUTORIAL.split("## Step 7:")[0]!.matchAll(/```eff\n([\s\S]*?)```/g),
  ].map(([, body]) => body).join("\n");
  assertEquals(library, FILES["library.eff"]);
  const broken = library.replace(
    "uses Shelf.find | Shelf.save => {",
    "uses Shelf.find => {",
  );
  assert(broken !== library);
  const io = memoryIo(under("/tutorial", {
    "effektive.json": FILES["effektive.json"]!,
    "library.eff": broken,
  }));
  assertEquals(await main(["check", "/tutorial"], io.io), 1);
  const output = io.out.join("") + io.err.join("");
  assert(TUTORIAL.includes(`\`\`\`text\n${output}\`\`\``), output);
});
