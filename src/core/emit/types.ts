// The type printer and the schema printer (plan sections 6.5 and 6.6).
//
// `typeDoc` prints a TypeScript type. `schemaDoc` prints the Effect Schema
// value of a type that has no function or provider inside.

import type {
  CapabilityId,
  Effects,
  ErrorId,
  FunctionType,
  Type,
} from "../ir.ts";
import {
  bracketed,
  callWith,
  type Doc,
  group,
  ifBreak,
  indent,
  join,
  line,
  soft,
} from "./doc.ts";
import { internal, type Scope, servicesOf, unsupported } from "./scope.ts";

function literalText(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Parameter names of function types: `a`, `b`, `c`, ... */
export function parameterName(index: number): string {
  return index < 26 ? String.fromCharCode(97 + index) : `a${index}`;
}

/** Type arguments: one line when they fit, else one for each line. */
function typeArguments(args: readonly Doc[]): Doc {
  return group([
    "<",
    indent([soft, join([",", line], args)]),
    soft,
    ">",
  ]);
}

function unionDoc(members: readonly Doc[]): Doc {
  return join(" | ", members);
}

function failureUnion(
  scope: Scope,
  failures: readonly ErrorId[],
): Doc | undefined {
  if (failures.length === 0) return undefined;
  return unionDoc(failures.map((id) => scope.nameOf(id)));
}

function requirementUnion(
  scope: Scope,
  capabilities: readonly CapabilityId[],
): Doc | undefined {
  const services = servicesOf(capabilities);
  if (services.length === 0) return undefined;
  return unionDoc(services.map((id) => scope.nameOf(id)));
}

/**
 * `Effect.Effect<R, E, Rq>` with the trailing `never` arguments left out. The
 * failure and requirement sets are already in sorted identity order.
 */
export function effectTypeDoc(
  scope: Scope,
  result: Doc,
  effects: Effects,
): Doc {
  const failures = failureUnion(scope, effects.failures);
  const requirements = requirementUnion(scope, effects.requirements);
  const args: Doc[] = [result];
  if (failures !== undefined || requirements !== undefined) {
    args.push(failures ?? "never");
  }
  if (requirements !== undefined) args.push(requirements);
  const effect = scope.effect("Effect");
  return [`${effect}.Effect`, typeArguments(args)];
}

function deferredArguments(
  scope: Scope,
  results: readonly Doc[],
  effects: Effects,
): Doc {
  const failures = failureUnion(scope, effects.failures);
  const requirements = requirementUnion(scope, effects.requirements);
  const args: Doc[] = [...results];
  if (failures !== undefined || requirements !== undefined) {
    args.push(failures ?? "never");
  }
  if (requirements !== undefined) args.push(requirements);
  return typeArguments(args);
}

/** `Layer.Layer<S1 | S2, E, Rq>` for a provider type. */
export function layerTypeDoc(
  scope: Scope,
  provides: readonly CapabilityId[],
  acquisition: Effects,
): Doc {
  const services = servicesOf(provides).map((id) => scope.nameOf(id));
  const failures = failureUnion(scope, acquisition.failures);
  const requirements = requirementUnion(scope, acquisition.requirements);
  const args: Doc[] = [unionDoc(services)];
  if (failures !== undefined || requirements !== undefined) {
    args.push(failures ?? "never");
  }
  if (requirements !== undefined) args.push(requirements);
  const layer = scope.effect("Layer");
  return [`${layer}.Layer`, typeArguments(args)];
}

function functionTypeDoc(scope: Scope, type: FunctionType): Doc {
  const parameters = type.parameters.map((p, i) => [
    parameterName(i),
    ": ",
    typeDoc(scope, p),
  ]);
  const result = typeDoc(scope, type.result);
  const returns = type.execution === "effect"
    ? effectTypeDoc(scope, result, type.effects)
    : result;
  return [
    group([
      "(",
      indent([soft, join([",", line], parameters)]),
      ifBreak(","),
      soft,
      ")",
    ]),
    " => ",
    returns,
  ];
}

/** True when the type needs parentheses as a member of a union or as an array element. */
function needsParentheses(type: Type): boolean {
  return type.kind === "function" || type.kind === "union";
}

export function typeDoc(scope: Scope, type: Type): Doc {
  switch (type.kind) {
    case "primitive":
      return type.name === "int"
        ? "number"
        : type.name === "unit"
        ? "void"
        : type.name;
    case "literal":
      return literalText(type.value);
    case "named":
      return scope.nameOf(type.id);
    case "array":
      return [`ReadonlyArray<`, typeDoc(scope, type.element), ">"];
    case "tuple":
      return type.elements.length === 0 ? "readonly []" : [
        "readonly [",
        join(", ", type.elements.map((t) => typeDoc(scope, t))),
        "]",
      ];
    case "option": {
      const option = scope.effect("Option");
      return [`${option}.Option<`, typeDoc(scope, type.element), ">"];
    }
    case "record": {
      if (type.fields.length === 0) return "{}";
      const fields = type.fields.map((f) => [
        "readonly ",
        f.name,
        f.optional ? "?" : "",
        ": ",
        typeDoc(scope, f.type),
      ]);
      return group([
        "{",
        indent([line, join([";", line], fields)]),
        line,
        "}",
      ]);
    }
    case "union":
      return unionDoc(
        type.members.map((m) => {
          const inner = typeDoc(scope, m);
          return needsParentheses(m) ? ["(", inner, ")"] : inner;
        }),
      );
    case "function":
      return functionTypeDoc(scope, type);
    case "effect":
      return effectTypeDoc(scope, typeDoc(scope, type.result), type.effects);
    case "stream":
      return [
        `${scope.effect("Stream")}.Stream`,
        deferredArguments(scope, [typeDoc(scope, type.element)], type.effects),
      ];
    case "sink":
      return [
        `${scope.effect("Sink")}.Sink`,
        typeArguments([
          typeDoc(scope, type.result),
          typeDoc(scope, type.input),
          "never",
          failureUnion(scope, type.effects.failures) ?? "never",
          requirementUnion(scope, type.effects.requirements) ?? "never",
        ]),
      ];
    case "provider":
      return layerTypeDoc(scope, type.provides, type.acquisition.effects);
  }
}

// ------------------------------------------------------------------ schemas

function schemaOfLiterals(
  scope: Scope,
  values: readonly (string | number | boolean)[],
): Doc {
  const schema = scope.effect("Schema");
  if (values.length === 1) {
    return callWith(`${schema}.Literal`, literalText(values[0]));
  }
  return [
    `${schema}.Literals(`,
    bracketed("[", "]", values.map(literalText), false),
    ")",
  ];
}

/** The Effect Schema value of a type. The type has no function or provider in it. */
export function schemaDoc(scope: Scope, type: Type): Doc {
  const schema = scope.effect("Schema");
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string":
          return `${schema}.String`;
        case "boolean":
          return `${schema}.Boolean`;
        case "number":
          return `${schema}.Number`;
        case "int":
          return scope.intSchemaName();
        case "unit":
          return `${schema}.Void`;
        case "never":
          return `${schema}.Never`;
        case "unknown":
          return `${schema}.Unknown`;
      }
      throw internal("unreachable primitive");
    case "literal":
      return schemaOfLiterals(scope, [type.value]);
    case "named":
      return scope.nameOf(type.id);
    case "array":
      return [`${schema}.Array(`, schemaDoc(scope, type.element), ")"];
    case "tuple":
      return [
        `${schema}.Tuple(`,
        bracketed(
          "[",
          "]",
          type.elements.map((t) => schemaDoc(scope, t)),
          false,
        ),
        ")",
      ];
    case "option":
      return [`${schema}.Option(`, schemaDoc(scope, type.element), ")"];
    case "record": {
      const fields = type.fields.map((f) => {
        const inner = schemaDoc(scope, f.type);
        return [
          f.name,
          ": ",
          f.optional ? [`${schema}.optionalKey(`, inner, ")"] : inner,
        ];
      });
      return [`${schema}.Struct(`, bracketed("{", "}", fields, true), ")"];
    }
    case "union": {
      const literals = type.members.flatMap((m) =>
        m.kind === "literal" ? [m.value] : []
      );
      if (literals.length === type.members.length) {
        return schemaOfLiterals(scope, literals);
      }
      return [
        `${schema}.Union(`,
        bracketed(
          "[",
          "]",
          type.members.map((m) => schemaDoc(scope, m)),
          false,
        ),
        ")",
      ];
    }
    case "function":
    case "effect":
    case "stream":
    case "sink":
    case "provider":
      throw unsupported("a deferred or function type has no schema");
  }
}
