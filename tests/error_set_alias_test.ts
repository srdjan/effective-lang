// Tests for a type alias of errors in a `fails` clause.

import { assert, assertEquals } from "@std/assert";
import { Program } from "../src/core/db.ts";
import { hoverAt } from "../src/core/editor.ts";
import { referencesAt } from "../src/core/editor_index.ts";
import { checkModule } from "./helpers.ts";

const HEAD = `error NotFound = { id: Text }
error Declined = { id: Text }
error Offline = {}
type Text = string
type PayFailure = NotFound | Declined
`;

function messages(text: string): string[] {
  return checkModule(HEAD + text).diagnostics.map((d) =>
    `${d.code} ${d.message}`
  );
}

function load(files: Record<string, string>) {
  const result = new Program("").update({
    set: { "effektive.json": "{}", ...files },
  });
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/** The hover contract of the declaration whose name starts at `needle`. */
function contractOf(
  files: Record<string, string>,
  file: string,
  needle: string,
) {
  const revision = load(files);
  assertEquals(revision.diagnostics, []);
  const hover = hoverAt(revision, file, files[file].indexOf(needle) + 1);
  assert(hover !== undefined);
  return hover.contract;
}

Deno.test("a local alias of errors is accepted in a fails clause", () => {
  assertEquals(
    messages(
      `export const pay = (id: Text): Text fails PayFailure => fail(NotFound({ id }))
`,
    ),
    [],
  );
});

Deno.test("a body that fails outside the alias still breaks the contract", () => {
  assertEquals(
    messages(`export const pay = (): Text fails PayFailure => fail(Offline({}))
`).map((m) => m.split(" ")[0]),
    ["failure-contract/001"],
  );
});

Deno.test("an alias of aliases and an alias of one error expand", () => {
  assertEquals(
    contractOf(
      {
        "m.eff": `${HEAD}type One = Offline
type All = PayFailure | One
export const pay = (): Text fails All => fail(Offline({}))
`,
      },
      "m.eff",
      "pay",
    ),
    "pay(): Text fails Declined | NotFound | Offline",
  );
});

Deno.test("a mixed alias reports the member that is not an error", () => {
  assertEquals(
    messages(`type Mixed = NotFound | Text
const f = (): Text fails Mixed => "x"
`),
    ["failure-contract/004 `Mixed` has a member that is not an error: `Text`"],
  );
});

Deno.test("an exported alias works across modules", () => {
  const files = {
    "errors.eff": `export error NotFound = { id: Text }
export error Declined = { id: Text }
export type Text = string
export type PayFailure = NotFound | Declined
`,
    "pay.eff":
      `import { Declined, NotFound, PayFailure, Text } from "./errors.eff"
export const pay = (id: Text): Text fails PayFailure => fail(Declined({ id }))
`,
  };
  assertEquals(
    contractOf(files, "pay.eff", "pay"),
    "pay(id: Text): Text fails Declined | NotFound",
  );
});

Deno.test("an alias works in a function type and a service method", () => {
  assertEquals(
    messages(`type Charge = (id: Text) => Text fails PayFailure
service Bank {
  charge(id: Text): Text fails PayFailure
}
export const run = (id: Text): Text fails Declined | NotFound uses Bank.charge => Bank.charge(id)
export const use = (f: Charge, id: Text): Text fails NotFound | Declined => f(id)
`),
    [],
  );
});

Deno.test("an alias is rejected in a catch arm", () => {
  assert(
    messages(
      `const f = (id: Text): Text fails PayFailure => fail(NotFound({ id }))
const g = (id: Text): Text =>
  try {
    f(id)
  } catch {
    PayFailure(error) => "x"
  }
`,
    ).includes("unknown-name/004 `PayFailure` is a type, not an error"),
  );
});

Deno.test("hover over a function with an alias shows the expanded members", () => {
  assertEquals(
    contractOf(
      {
        "m.eff":
          `${HEAD}export const pay = (id: Text): Text fails PayFailure => fail(NotFound({ id }))\n`,
      },
      "m.eff",
      "pay",
    ),
    "pay(id: Text): Text fails Declined | NotFound",
  );
});

Deno.test("references of an alias include its use in a fails clause", () => {
  const text =
    `${HEAD}export const pay = (id: Text): Text fails PayFailure => fail(NotFound({ id }))\n`;
  const revision = load({ "m.eff": text });
  const refs = referencesAt(revision, "m.eff", text.indexOf("PayFailure ="));
  assertEquals(refs.length, 2);
});

Deno.test("an alias works in a host interface file", () => {
  const files = {
    "effektive.json": JSON.stringify({
      host: { h: { interface: "./h.effi", module: "./h.ts" } },
    }),
    "h.effi": `export error NotFound = { id: Text }
export error Declined = { id: Text }
export type Text = string
export type PayFailure = NotFound | Declined
export service Bank {
  charge(id: Text): Text fails PayFailure
}
`,
    "m.eff": `import { Bank, Declined, NotFound, Text } from "host:h"
export const pay = (id: Text): Text fails Declined | NotFound uses Bank.charge => Bank.charge(id)
`,
  };
  const result = new Program("").update({ set: files });
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.value.diagnostics, []);
});
