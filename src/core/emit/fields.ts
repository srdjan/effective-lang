// Property semantics at the JavaScript boundary. Adapters follow declared data
// shapes only: they do not traverse arbitrary host objects or deferred values.
import type { Field, Type, TypeDecl } from "../ir.ts";
import { type Doc, hard } from "./doc.ts";
import type { ExprScope, TypeLookup } from "./scope.ts";

export function fieldKey(name: string): string {
  return name === "__proto__" ? '["__proto__"]' : name;
}

export function prototypeField(name: string): boolean {
  return Object.hasOwn(Object.prototype, name);
}

export function sensitiveField(name: string): boolean {
  return Object.hasOwn(Object.prototype, name) ||
    ["message", "name", "stack"].includes(name);
}

/** The fields of a nominal type over a record, which lowers to a tagged record. Other declarations give undefined. */
export function dataFields(d: TypeDecl): readonly Field[] | undefined {
  return d.definition.kind === "nominal" && d.definition.tagged === true &&
      d.definition.base.kind === "record"
    ? d.definition.base.fields
    : undefined;
}

/** The type that a type declaration stands for: the alias target or the nominal base. */
function definitionType(d: TypeDecl): Type {
  return d.definition.kind === "alias" ? d.definition.type : d.definition.base;
}

export function needsFieldAdapter(
  scope: TypeLookup,
  type: Type,
  seen = new Set<string>(),
): boolean {
  switch (type.kind) {
    case "named": {
      if (seen.has(type.id)) return false;
      const next = new Set([...seen, type.id]);
      const declaration = scope.typeLevelDeclaration(type.id);
      if (declaration?.kind === "error") return false;
      return declaration?.kind === "type" &&
        needsFieldAdapter(scope, definitionType(declaration), next);
    }
    case "record":
      return type.fields.some((f) =>
        prototypeField(f.name) || needsFieldAdapter(scope, f.type, seen)
      );
    case "option":
    case "array":
      return needsFieldAdapter(scope, type.element, seen);
    case "tuple":
      return type.elements.some((t) => needsFieldAdapter(scope, t, seen));
    case "union":
      return type.members.some((t) => needsFieldAdapter(scope, t, seen));
    default:
      return false;
  }
}

export function fieldAdapter(
  scope: ExprScope,
  type: Type,
  direction: "decoded" | "encoded" | "make",
): string {
  const key = JSON.stringify([direction, type]);
  const existing = scope.fieldAdapters.get(key);
  if (existing !== undefined) return existing.name;
  const name = scope.fresh("$fields");
  scope.fieldAdapters.set(key, { name, type, direction });
  return name;
}

function adapterBody(
  scope: ExprScope,
  type: Type,
  direction: "decoded" | "encoded" | "make",
): string {
  const apply = (child: Type, value: string) =>
    needsFieldAdapter(scope, child)
      ? `${fieldAdapter(scope, child, direction)}(${value})`
      : value;
  let fields;
  if (type.kind === "named") {
    const d = scope.typeLevelDeclaration(type.id);
    if (d?.kind === "type") {
      return `return ${apply(definitionType(d), "value")};`;
    }
    if (d?.kind !== "error") return "return value;";
    // Compiler-derived error schemas are nominal identity schemas. Never clone
    // their instances: class validation and recovery rely on that identity.
    return "return value;";
  } else if (type.kind === "record") fields = type.fields;
  else if (type.kind === "option") {
    const option = scope.effect("Option");
    return `return ${option}.isOption(value) ? ${option}.map(value, item => ${
      apply(type.element, "item")
    }) : value;`;
  } else if (type.kind === "array") {
    return `return globalThis.Array.isArray(value) ? value.map(item => ${
      apply(type.element, "item")
    }) : value;`;
  } else if (type.kind === "tuple") {
    return `return globalThis.Array.isArray(value) ? value.map((item, index) => { switch (index) { ${
      type.elements.map((t, i) => `case ${i}: return ${apply(t, "item")};`)
        .join(" ")
    } default: return item; } }) : value;`;
  } else if (type.kind === "union") {
    // Discriminated records select their declared branch; other members adapt
    // only their own fields, so sequential adaptation preserves unrelated data.
    const branches = type.members.map((member) => {
      const resolved = scope.resolve(member);
      const tag = resolved.kind === "record"
        ? resolved.fields.find((f) => f.type.kind === "literal")
        : undefined;
      if (tag?.type.kind !== "literal") return undefined;
      return `if (typeof value === "object" && value !== null && globalThis.Reflect.get(value, ${
        JSON.stringify(tag.name)
      }) === ${JSON.stringify(tag.type.value)}) return ${
        apply(member, "value")
      };`;
    });
    return branches.every((b) => b !== undefined)
      ? `${branches.join("\n")}\nreturn value;`
      : `return ${type.members.reduce((v, t) => apply(t, v), "value")};`;
  } else return "return value;";
  const record = scope.fieldHelper("record");
  const transformations = fields.filter((f) => needsFieldAdapter(scope, f.type))
    .map((f) => {
      const key = JSON.stringify(f.name);
      return `if (globalThis.Object.hasOwn(out, ${key})) globalThis.Object.defineProperty(out, ${key}, { value: ${
        apply(f.type, `out[${key}]`)
      }, enumerable: true, configurable: true, writable: true });`;
    });
  return `if (typeof value !== "object" || value === null || globalThis.Array.isArray(value)) return value;
const out = ${record}<{ [key: string]: unknown }>(value);
${transformations.join("\n")}
return out;`;
}

/** Emit only the helpers requested by this module, allocating dependencies first. */
export function fieldHelperDeclarations(scope: ExprScope): Doc[] {
  const adapters: string[] = [];
  for (const { name, type, direction } of scope.fieldAdapters.values()) {
    adapters.push(
      `function ${name}(value: unknown): unknown {\n${
        adapterBody(scope, type, direction)
      }\n}`,
    );
  }
  const optional = scope.fieldHelpers.get("optionalField");
  if (optional !== undefined) scope.fieldHelper("suppliedFields");
  const helpers: string[] = [];
  const presence = scope.fieldHelpers.get("suppliedFields");
  if (presence !== undefined) {
    helpers.push(
      `const ${presence} = globalThis.Symbol.for("effektive/source-fields");`,
    );
  }
  const untagged = scope.fieldHelpers.get("untagged");
  if (untagged !== undefined) {
    helpers.push(
      `// A data value carries \`_tag\`. The copy leaves it out and has no prototype.
const ${untagged} = <T>(value: object): T =>
  globalThis.Object.assign(
    globalThis.Object.create(null),
    globalThis.Object.fromEntries(
      globalThis.Object.entries(value).filter(([key]) => key !== "_tag"),
    ),
  );`,
    );
  }
  const record = scope.fieldHelpers.get("record");
  if (record !== undefined) {
    helpers.push(
      `// Source checking establishes T; this boundary supplies JavaScript own-field semantics.
const ${record} = <T>(value: unknown, adapt?: (value: unknown) => unknown): T => {
let output: unknown;
if (adapt !== undefined) output = adapt(value);
else {
  const descriptors = globalThis.Object.getOwnPropertyDescriptors(value);
  for (const key of globalThis.Reflect.ownKeys(descriptors)) globalThis.Reflect.get(descriptors, key).configurable = true;
  output = globalThis.Object.defineProperties(globalThis.Object.create(null), descriptors);
}
return output as T;
};`,
    );
  }
  if (optional !== undefined) {
    const option = scope.effect("Option");
    helpers.push(
      `const ${optional} = <T>(value: object, key: string): ${option}.Option<T> => {
const supplied: unknown = globalThis.Reflect.get(value, ${presence});
return globalThis.Object.hasOwn(value, key) && (!(supplied instanceof globalThis.Set) || supplied.has(key)) ? ${option}.some<T>(globalThis.Reflect.get(value, key)) : ${option}.none();
};`,
    );
  }
  // Fixed helper bodies stay inside the Doc renderer, which owns source spans;
  // the emitter has no runtime formatter dependency.
  return [...helpers, ...adapters].map((text) =>
    text.split("\n").flatMap((line, i) => i === 0 ? [line] : [hard, line])
  );
}
