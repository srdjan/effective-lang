// Tests for the playground compile facade: the examples, an edit with an error,
// stale output and its repair, a cross-file edit, hover, a configuration error,
// an internal error, and the clock.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { Program } from "../src/core/db.ts";
import {
  BACKEND_UNAVAILABLE,
  createPlayground,
  type Playground,
  type PlaygroundResult,
  type ProgramPort,
} from "../playground/src/compile.ts";
import { exampleFiles } from "./helpers.ts";

const FILES = exampleFiles();
const EFF_PATHS = [
  "collections.eff",
  "log.eff",
  "main.eff",
  "pay.eff",
  "users.eff",
];
const BAD_USERS = FILES["users.eff"] +
  'export const limit: Int = 3 + "x"\ntype Int = int\n';

function start(): { pg: Playground; first: PlaygroundResult } {
  const pg = createPlayground(FILES, { now: () => 0 });
  const first = pg.start();
  assert(first.ok);
  return { pg, first: first.value };
}

function okOf(
  result: ReturnType<Playground["update"]>,
): PlaygroundResult {
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function offsetOf(text: string, needle: string, delta = 0): number {
  const at = text.indexOf(needle);
  assert(at >= 0, `missing ${needle}`);
  return at + delta;
}

Deno.test("the examples compile with no diagnostics and five outputs", () => {
  const { first } = start();
  for (const diagnostics of Object.values(first.diagnostics)) {
    assertEquals(diagnostics, []);
  }
  assertEquals(Object.keys(first.outputs).sort(), EFF_PATHS);
  for (const path of EFF_PATHS) {
    const output = first.outputs[path];
    assert(output !== null);
    assertEquals(output.stale, false);
    assert(output.text.includes("Generated from"));
  }
  assertEquals(first.diagnostics["host/providers.effi"], []);
});

Deno.test("an update before start sends every file", () => {
  const pg = createPlayground(FILES, { now: () => 0 });
  const result = okOf(pg.update("users.eff", FILES["users.eff"]));
  assertEquals(Object.keys(result.outputs).sort(), EFF_PATHS);
});

Deno.test("the first call sends every file and later calls send one file", () => {
  const sets: string[][] = [];
  const real = new Program("");
  const program: ProgramPort = {
    update(changes) {
      const set = changes.set instanceof Map
        ? [...changes.set.keys()]
        : Object.keys(changes.set ?? {});
      sets.push(set.sort());
      return real.update(changes);
    },
  };
  const pg = createPlayground(FILES, { now: () => 0, program });
  assert(pg.start().ok);
  assert(pg.update("users.eff", FILES["users.eff"]).ok);
  assertEquals(sets.length, 2);
  assertEquals(sets[0], Object.keys(FILES).sort());
  assertEquals(sets[1], ["users.eff"]);
});

Deno.test("an error gives offsets over the right text and a stale output", () => {
  const { pg, first } = start();
  const oldText = first.outputs["users.eff"]?.text;
  assert(oldText !== undefined);
  const result = okOf(pg.update("users.eff", BAD_USERS));
  const diagnostics = result.diagnostics["users.eff"];
  assertEquals(diagnostics.length, 1);
  const d = diagnostics[0];
  assertEquals(d.severity, "error");
  assertEquals(d.code, "type-mismatch/007");
  assertEquals(BAD_USERS.slice(d.from, d.to), '3 + "x"');
  assertEquals(result.outputs["users.eff"], { text: oldText, stale: true });
  assertEquals(result.diagnostics["main.eff"], []);
});

Deno.test("a repair clears the diagnostic and the stale flag", () => {
  const { pg, first } = start();
  okOf(pg.update("users.eff", BAD_USERS));
  const result = okOf(pg.update("users.eff", FILES["users.eff"]));
  assertEquals(result.diagnostics["users.eff"], []);
  assertEquals(result.outputs["users.eff"], first.outputs["users.eff"]);
});

Deno.test("an edit of the host interface file changes a diagnostic of main.eff", () => {
  const { pg } = start();
  const result = okOf(pg.update(
    "host/providers.effi",
    'import { Users } from "../users.eff"\n',
  ));
  assertEquals(result.diagnostics["host/providers.effi"], []);
  const main = result.diagnostics["main.eff"];
  assert(main.some((d) => d.code === "unknown-name/002"));
  const d = main.find((x) => x.code === "unknown-name/002");
  assert(d !== undefined);
  assertEquals(FILES["main.eff"].slice(d.from, d.to), "UsersLive");
  assertEquals(result.outputs["main.eff"]?.stale, true);
  const repaired = okOf(
    pg.update("host/providers.effi", FILES["host/providers.effi"]),
  );
  assertEquals(repaired.diagnostics["main.eff"], []);
  assertEquals(repaired.outputs["main.eff"]?.stale, false);
});

Deno.test("hover on rename gives the contract and the backend text", () => {
  const { pg } = start();
  const text = FILES["users.eff"];
  const at = offsetOf(text, "rename", 2);
  const hit = pg.hover("users.eff", at);
  assert(hit !== undefined);
  assertEquals(hit.from, offsetOf(text, "rename"));
  assertEquals(hit.to, offsetOf(text, "rename") + "rename".length);
  assertEquals(
    hit.contract,
    "rename(id: UserId, name: Name): User fails StoreUnavailable | UserMissing uses Users.find | Users.save",
  );
  assertEquals(
    hit.backend,
    "(id: UserId, name: Name): Effect.Effect<User, StoreUnavailable | UserMissing, Users>",
  );
  assertEquals(pg.hover("users.eff", 0), undefined);
});

Deno.test("hover after a breaking edit gives the unavailable backend", () => {
  const { pg } = start();
  okOf(pg.update("users.eff", BAD_USERS));
  const hit = pg.hover(
    "users.eff",
    offsetOf(FILES["users.eff"], "rename", 2),
  );
  assert(hit !== undefined);
  assertEquals(hit.backend, BACKEND_UNAVAILABLE);
  assertEquals(
    BACKEND_UNAVAILABLE,
    "backend type: not available while the module has errors",
  );
});

Deno.test("a broken effektive.json gives a config error and no hover", () => {
  const { pg } = start();
  const result = pg.update("effektive.json", "{ nope");
  assert(!result.ok);
  assertEquals(result.error.tag, "config");
  assert(result.error.message.includes("effektive.json"));
  assertEquals(pg.hover("users.eff", 10), undefined);
  const repaired = okOf(pg.update("effektive.json", FILES["effektive.json"]));
  assertEquals(repaired.outputs["users.eff"]?.stale, false);
  assertNotEquals(
    pg.hover("users.eff", offsetOf(FILES["users.eff"], "rename")),
    undefined,
  );
});

Deno.test("a program that throws gives an internal error and no hover", () => {
  let calls = 0;
  const real = new Program("");
  const program: ProgramPort = {
    update(changes) {
      calls++;
      if (calls === 2) throw new Error("boom");
      return real.update(changes);
    },
  };
  const pg = createPlayground(FILES, { now: () => 0, program });
  assert(pg.start().ok);
  assertNotEquals(
    pg.hover("users.eff", offsetOf(FILES["users.eff"], "rename")),
    undefined,
  );
  const result = pg.update("users.eff", FILES["users.eff"]);
  assert(!result.ok);
  assertEquals(result.error, { tag: "internal", message: "boom" });
  assertEquals(
    pg.hover("users.eff", offsetOf(FILES["users.eff"], "rename")),
    undefined,
  );
  assert(pg.update("users.eff", FILES["users.eff"]).ok);
});

Deno.test("a thrown value that is not an Error becomes the internal message", () => {
  const program: ProgramPort = {
    update() {
      throw "plain";
    },
  };
  const pg = createPlayground(FILES, { now: () => 0, program });
  const result = pg.start();
  assert(!result.ok);
  assertEquals(result.error, { tag: "internal", message: "plain" });
});

for (
  const phase of ["before update", "after update", "during emission"] as const
) {
  Deno.test(`an internal error ${phase} resends failed edits when another file changes`, () => {
    let calls = 0;
    const sets: ReadonlyMap<string, string>[] = [];
    const real = new Program("");
    const program: ProgramPort = {
      update(changes) {
        calls++;
        assert(changes.set instanceof Map);
        sets.push(changes.set);
        if (calls === 2 && phase === "before update") throw new Error("boom");
        const result = real.update(changes);
        if (calls === 2) {
          if (phase === "after update") throw new Error("boom");
          assert(result.ok);
          result.value.emitted = () => {
            throw new Error("boom");
          };
        }
        return result;
      },
    };
    const pg = createPlayground(FILES, { now: () => 0, program });
    assert(pg.start().ok);
    const failed = pg.update("users.eff", BAD_USERS);
    assert(!failed.ok);
    assertEquals(failed.error, { tag: "internal", message: "boom" });
    const recovered = okOf(pg.update("main.eff", FILES["main.eff"]));
    assertEquals([...sets[2].keys()].sort(), Object.keys(FILES).sort());
    assertEquals(sets[2].get("users.eff"), BAD_USERS);
    assertEquals(recovered.diagnostics["users.eff"].length, 1);
    assertEquals(
      recovered.diagnostics["users.eff"][0].code,
      "type-mismatch/007",
    );
    assertEquals(recovered.outputs["users.eff"]?.stale, true);
  });
}

Deno.test("an internal error on start resends all files on the next edit", () => {
  const real = new Program("");
  let calls = 0;
  const program: ProgramPort = {
    update(changes) {
      if (++calls === 1) throw new Error("boom");
      return real.update(changes);
    },
  };
  const pg = createPlayground(FILES, { now: () => 0, program });
  const failed = pg.start();
  assert(!failed.ok && failed.error.tag === "internal");
  const recovered = okOf(pg.update("users.eff", BAD_USERS));
  assertEquals(Object.keys(recovered.outputs).sort(), EFF_PATHS);
  assertEquals(recovered.diagnostics["users.eff"].length, 1);
});

Deno.test("elapsedMs comes from the clock", () => {
  const times = [100, 107.5];
  const pg = createPlayground(FILES, { now: () => times.shift() ?? 0 });
  const result = okOf(pg.start());
  assertEquals(result.elapsedMs, 7.5);
});
