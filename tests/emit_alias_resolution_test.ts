import { assertEquals } from "@std/assert";
import { Scope } from "../src/core/emit/scope.ts";
import type { ModuleIR, Type, TypeDecl, TypeId } from "../src/core/ir.ts";

Deno.test("emitter alias resolution reaches deep targets and stops at cycles, brands and unknown names", () => {
  const span = { source: "main.eff", start: 0, end: 0 };
  const named = (index: number): Type => ({
    kind: "named",
    id: `type:main#A${index}`,
  });
  const leaf: Type = { kind: "primitive", name: "int" };
  const declarations: TypeDecl[] = Array.from({ length: 126 }, (_, index) => ({
    kind: "type",
    id: `type:main#A${index}` as TypeId,
    name: `A${index}`,
    definition: { kind: "alias", type: index === 0 ? leaf : named(index - 1) },
    span,
  }));
  declarations.push({
    kind: "type",
    id: "type:main#Loop",
    name: "Loop",
    definition: {
      kind: "alias",
      type: { kind: "named", id: "type:main#Loop" },
    },
    span,
  }, {
    kind: "type",
    id: "type:main#Brand",
    name: "Brand",
    definition: { kind: "nominal", base: leaf },
    span,
  });
  const ir: ModuleIR = {
    format: "light-functional-ir",
    version: 4,
    module: "main",
    sources: ["main.eff"],
    imports: [],
    declarations,
    exports: [],
  };
  const scope = new Scope(ir, { host: new Map() });
  for (const depth of [63, 64, 70, 125]) {
    assertEquals(scope.resolve(named(depth)), leaf);
  }
  for (const name of ["Loop", "Brand", "Unknown"]) {
    const type: Type = { kind: "named", id: `type:main#${name}` };
    assertEquals(scope.resolve(type), type);
  }
  assertEquals(scope.resolve(leaf), leaf);
});
