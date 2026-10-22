// Builtin metadata and collection shapes used only by the independent validator.

import type { Expr, Type } from "../ir.ts";
import { same, type TypeEnv, unfold } from "./typing.ts";

const BUILTIN_NAMES = ["map", "filter", "fold", "all", "traverse"] as const;
export type BuiltinName = typeof BUILTIN_NAMES[number];
export type BuiltinCallName = BuiltinName | "other";

export interface BuiltinInfo {
  readonly identity: {
    readonly module: string;
    readonly name: BuiltinName;
  } | undefined;
  readonly call:
    | { readonly parsed: true; readonly name: BuiltinCallName | undefined }
    | { readonly parsed: false };
}

const BUILTIN_ID = /^value:(.+)#\$builtin\/([^/]+)\/[0-9a-f]+$/;

/** Unknown name segments still trigger the existing callback purity rule. */
export function classifyBuiltinCall(
  name: string | undefined,
): BuiltinCallName | undefined {
  return name === undefined
    ? undefined
    : BUILTIN_NAMES.find((known) => known === name) ?? "other";
}

export function builtinInfo(id: string, name: string): BuiltinInfo {
  const match = typeof id === "string" ? BUILTIN_ID.exec(id) : null;
  const known = BUILTIN_NAMES.find((known) => known === match?.[2]);
  return {
    identity: match !== null && known !== undefined
      ? { module: match[1], name: known }
      : undefined,
    // Malformed non-string names are evaluated in the guarded call phase.
    call: typeof name === "string"
      ? { parsed: true, name: classifyBuiltinCall(name.split("/")[1]) }
      : { parsed: false },
  };
}

interface Container {
  readonly shape: Extract<
    Type,
    { readonly kind: "tuple" | "record" | "array" }
  >;
  readonly entries: readonly Type[];
}

export function containerEntries(type: Type): Container | undefined {
  switch (type.kind) {
    case "tuple":
      return { shape: type, entries: type.elements };
    case "record":
      return { shape: type, entries: type.fields.map((field) => field.type) };
    case "array":
      return { shape: type, entries: [type.element] };
    default:
      return undefined;
  }
}

export function rebuildContainer(
  container: Container,
  entries: readonly Type[],
): Type {
  const shape = container.shape;
  switch (shape.kind) {
    case "tuple":
      return { kind: "tuple", elements: entries };
    case "record":
      return {
        kind: "record",
        fields: shape.fields.map((field, i) => ({
          name: field.name,
          type: entries[i],
          optional: false,
        })),
      };
    case "array":
      return { kind: "array", element: entries[0] };
  }
}

export function isConcurrencyType(env: TypeEnv, type: Type): boolean {
  const options = unfold(env, type);
  const field = options.kind === "record" && options.fields.length === 1
    ? options.fields[0]
    : undefined;
  return field?.name === "concurrency" && !field.optional &&
    (same(env, field.type, { kind: "primitive", name: "int" }) ||
      same(env, field.type, { kind: "primitive", name: "string" }));
}

export function isConcurrencyOption(options: Expr | undefined): boolean {
  const field = options?.kind === "record" && options.fields.length === 1
    ? options.fields[0]
    : undefined;
  const value = field?.value;
  return field?.name === "concurrency" && value?.kind === "literal" &&
    (value.value === "unbounded" ||
      (typeof value.value === "number" && Number.isSafeInteger(value.value) &&
        value.value > 0));
}
