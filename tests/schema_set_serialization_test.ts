import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  serializeModule,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const source = `type Text = string
service Need { a(): Text
  b(): Text }
const text: Schema<Text> = schema()
const adapted = schemaTransform(
  text, text,
  (x: Text): Option<Text> uses Need.a | Need.b => { Need.a(); Some(Need.b()) },
  (x: Text): Option<Text> uses Need.a | Need.b => { Need.a(); Some(Need.b()) }
)
`;

Deno.test("Schema requirement sets must be sorted and unique in both service directions", () => {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(checked.ok);
  assertEquals(checked.value.diagnostics, []);
  const lowered = lowerProject(checked.value).get("main");
  assert(lowered?.ok);
  const sources = new Map([["main.eff", source]]);
  assertEquals(validateModule(lowered.value, sources), []);
  assert(serializeModule(lowered.value).ok);
  for (const key of ["decodeRequirements", "encodeRequirements"] as const) {
    for (const fault of ["reversed", "duplicate"] as const) {
      const forged = structuredClone(lowered.value);
      const index = forged.declarations.findIndex((d) => d.name === "adapted");
      const declaration = forged.declarations[index];
      assert(
        declaration.kind === "constant" && declaration.type.kind === "schema",
      );
      const requirements = declaration.type[key];
      assertEquals(requirements.length, 2);
      const invalid = fault === "reversed"
        ? [...requirements].reverse()
        : [requirements[0], ...requirements];
      Object.assign(declaration.type, { [key]: invalid });
      const path = `declarations[${index}].type.${key}`;
      const serialized = serializeModule(forged);
      assert(!serialized.ok);
      assertEquals(serialized.error, {
        tag: "unsorted-set",
        path: `$.${path}`,
      });
      const diagnostics = validateModule(forged, sources);
      assertEquals(diagnostics.length, 1);
      assertEquals(diagnostics[0].code, "validation/008");
      assert(diagnostics[0].message.startsWith(`${path}:`));
    }
  }
});
