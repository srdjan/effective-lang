import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { TypeTable } from "../src/core/types.ts";
import type { SchemaPresence } from "../src/core/types.ts";

Deno.test("schema presence roundtrips every legal IR state independently of constructor defaults", () => {
  const table = new TypeTable();
  const decoded = table.record([{
    name: "count",
    type: table.int,
    optional: false,
  }]);
  const makeInput = table.record([]);
  const cases: readonly [SchemaPresence, readonly (true | undefined)[]][] = [
    ["required", [undefined, undefined, undefined]],
    ["optional", [true, undefined, undefined]],
    ["encoded-optional", [undefined, true, undefined]],
    ["decoded-optional", [undefined, undefined, true]],
  ];
  const refs = new Set();
  for (const [presence, flags] of cases) {
    for (const constructorDefault of [false, true]) {
      const ref = table.schema(decoded, table.string, [], [], {
        presence,
        makeInput,
        constructorDefault,
      });
      refs.add(ref);
      const node = table.node(ref);
      assert(node.kind === "schema");
      assertEquals(node.presence, presence);
      assertEquals(node.makeInput, makeInput);
      const ir = table.toIr(ref);
      assert(ir.kind === "schema");
      assertEquals([
        ir.optionalKey,
        ir.encodedOptionalKey,
        ir.decodedOptionalKey,
      ], flags);
      assertEquals(
        ir.constructorDefault,
        constructorDefault ? true : undefined,
      );
      assertEquals(ir.decoded, table.toIr(decoded));
      assertEquals(ir.encoded, { kind: "primitive", name: "string" });
      assertEquals(ir.makeInput, { kind: "record", fields: [] });
      assertEquals(table.fromIr(ir), ref);
    }
  }
  assertEquals(refs.size, 8);
});

Deno.test("schema assignability distinguishes presence and preserves normalized make input", () => {
  const table = new TypeTable();
  const required = table.schema(table.int, table.string, [], []);
  const equivalent = table.schema(table.int, table.string, [], [], {
    presence: "required",
    makeInput: table.int,
    constructorDefault: false,
  });
  const optional = table.schema(table.int, table.string, [], [], {
    presence: "optional",
  });
  assertEquals(required, equivalent);
  assertNotEquals(required, optional);
  assertEquals(table.isAssignable(required, optional), false);
  assertEquals(table.isAssignable(optional, required), false);
});
