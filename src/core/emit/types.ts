import { fieldKey } from "./fields.ts";
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
import { SCOPE_CAPABILITY } from "../ir.ts";
import {
  bracketed,
  callWith,
  type Doc,
  group,
  ifBreak,
  indent,
  join,
  line,
  member,
  property,
  soft,
} from "./doc.ts";
import {
  type EmitNames,
  internal,
  isDeferredType,
  servicesOf,
  unsupported,
} from "./scope.ts";

function literalText(value: string | number | boolean | null): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Parameter names of function types: `a`, `b`, `c`, ... */
function parameterName(index: number): string {
  return index < 26 ? String.fromCharCode(97 + index) : `a${index}`;
}

/** Type arguments: one line when they fit, else one for each line. */
export function typeArguments(args: readonly Doc[]): Doc {
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
  scope: EmitNames,
  failures: readonly ErrorId[],
): Doc | undefined {
  if (failures.length === 0) return undefined;
  return unionDoc(failures.map((id) => scope.nameOf(id)));
}

function requirementUnion(
  scope: EmitNames,
  capabilities: readonly CapabilityId[],
): Doc | undefined {
  const services = servicesOf(capabilities);
  const names: Doc[] = services.map((id) => scope.nameOf(id));
  if (capabilities.includes(SCOPE_CAPABILITY)) {
    names.push(`${scope.effect("Scope")}.Scope`);
  }
  return names.length === 0 ? undefined : unionDoc(names);
}

/** The failure and requirement type arguments of an effect set, `never` when empty. */
export function channelTypeArguments(
  scope: EmitNames,
  effects: Effects,
): readonly Doc[] {
  return [
    failureUnion(scope, effects.failures) ?? "never",
    requirementUnion(scope, effects.requirements) ?? "never",
  ];
}

/**
 * `Effect.Effect<R, E, Rq>` with the trailing `never` arguments left out. The
 * failure and requirement sets are already in sorted identity order.
 */
export function effectTypeDoc(
  scope: EmitNames,
  result: Doc,
  effects: Effects,
): Doc {
  const args = deferredArguments(scope, [result], effects);
  const effect = scope.effect("Effect");
  return [`${effect}.Effect`, args];
}

function deferredArguments(
  scope: EmitNames,
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
function layerTypeDoc(
  scope: EmitNames,
  provides: readonly CapabilityId[],
  acquisition: Effects,
): Doc {
  const services = servicesOf(provides).map((id) => scope.nameOf(id));
  const args = deferredArguments(scope, [unionDoc(services)], acquisition);
  const layer = scope.effect("Layer");
  return [`${layer}.Layer`, args];
}

function functionTypeDoc(scope: EmitNames, type: FunctionType): Doc {
  const parameters = type.parameters.map((p, i) =>
    property(parameterName(i), typeDoc(scope, p))
  );
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

/**
 * True when a Schema carries make-input or optionality metadata. The printed type
 * then needs the metadata intersection, and an emitted value needs `Schema.make`.
 */
export function hasSchemaMetadata(
  type: Extract<Type, { readonly kind: "schema" }>,
): boolean {
  return type.makeInput !== undefined || type.constructorDefault === true ||
    type.optionalKey === true || type.encodedOptionalKey === true ||
    type.decodedOptionalKey === true;
}

export function typeDoc(scope: EmitNames, type: Type): Doc {
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
    case "ref":
      return [`${scope.effect("Ref")}.Ref<`, typeDoc(scope, type.element), ">"];
    case "retry-schedule":
      return [
        `${scope.effect("Schedule")}.Schedule<number, `,
        typeDoc(scope, type.error),
        ">",
      ];
    case "codec": {
      const option = scope.effect("Option");
      return [
        "{ readonly decode: (input: unknown) => ",
        `${option}.Option<`,
        typeDoc(scope, type.decoded),
        ">; readonly encode: (input: ",
        typeDoc(scope, type.decoded),
        `) => ${option}.Option<`,
        typeDoc(scope, type.encoded),
        "> }",
      ];
    }
    case "schema": {
      const codec: Doc = [
        `${scope.effect("Schema")}.Codec`,
        typeArguments([
          typeDoc(scope, type.decoded),
          typeDoc(scope, type.encoded),
          requirementUnion(scope, type.decodeRequirements) ?? "never",
          requirementUnion(scope, type.encodeRequirements) ?? "never",
        ]),
      ];
      if (!hasSchemaMetadata(type)) return codec;
      return [
        "(",
        codec,
        ' & { readonly "~type.make.in": ',
        typeDoc(scope, type.makeInput ?? type.decoded),
        '; readonly "~type.optionality": "',
        type.optionalKey === true || type.decodedOptionalKey === true
          ? "optional"
          : "required",
        '"; readonly "~encoded.optionality": "',
        type.optionalKey === true || type.encodedOptionalKey === true
          ? "optional"
          : "required",
        '"; readonly "~type.constructor.default": "',
        type.constructorDefault === true ? "with-default" : "no-default",
        '" })',
      ];
    }
    case "closeable-scope":
      return scope.scopeRuntime().type;
    case "fiber":
      return [
        `${scope.effect("Fiber")}.Fiber<`,
        typeDoc(scope, type.result),
        ", ",
        failureUnion(scope, type.failures) ?? "never",
        ">",
      ];
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
        ifBreak(";"),
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
    case "schedule":
      return [
        `${scope.effect("Schedule")}.Schedule`,
        typeArguments([
          typeDoc(scope, type.output),
          typeDoc(scope, type.input),
          ...channelTypeArguments(scope, type.effects),
        ]),
      ];
    case "sink":
      return [
        `${scope.effect("Sink")}.Sink`,
        typeArguments([
          typeDoc(scope, type.result),
          typeDoc(scope, type.input),
          type.leftover === undefined ? "never" : typeDoc(scope, type.leftover),
          ...channelTypeArguments(scope, type.effects),
        ]),
      ];
    case "provider":
      return layerTypeDoc(scope, type.provides, type.acquisition.effects);
  }
}

// ------------------------------------------------------------------ schemas

function schemaOfLiterals(
  scope: EmitNames,
  values: readonly (string | number | boolean | null)[],
): Doc {
  const schema = scope.effect("Schema");
  if (values.includes(null)) {
    const nonNull = values.filter((value) => value !== null);
    return nonNull.length === 0 ? `${schema}.Null` : [
      `${schema}.Union([`,
      schemaOfLiterals(scope, nonNull),
      `, ${schema}.Null])`,
    ];
  }
  if (values.length === 1) {
    return callWith(`${schema}.Literal`, literalText(values[0]));
  }
  return [
    `${schema}.Literals(`,
    bracketed("[", "]", values.map(literalText), false),
    ")",
  ];
}

/**
 * The TypeScript type that a type has after `schemaDoc` encodes it: a brand
 * becomes its base, an error becomes its Schema encoding, and each name of the
 * recursive group becomes its generated mirror type. The type has no function in it.
 */
export function encodedTypeDoc(
  scope: EmitNames,
  type: Type,
  recursive?: ReadonlySet<string>,
): Doc {
  if (isDeferredType(type)) {
    throw unsupported("a deferred or function type has no schema");
  }
  switch (type.kind) {
    case "primitive":
    case "literal":
      return typeDoc(scope, type);
    case "named":
      return recursive?.has(type.id) ? scope.encodedMirrorName(type.id) : [
        `${scope.effect("Schema")}.Codec.Encoded<typeof `,
        scope.nameOf(type.id),
        ">",
      ];
    case "array":
      return [
        "ReadonlyArray<",
        encodedTypeDoc(scope, type.element, recursive),
        ">",
      ];
    case "tuple":
      return type.elements.length === 0 ? "readonly []" : [
        "readonly [",
        join(
          ", ",
          type.elements.map((t) => encodedTypeDoc(scope, t, recursive)),
        ),
        "]",
      ];
    case "option":
      return [
        `${scope.effect("Option")}.Option<`,
        encodedTypeDoc(scope, type.element, recursive),
        ">",
      ];
    case "record": {
      if (type.fields.length === 0) return "{}";
      const fields = type.fields.map((f) => [
        "readonly ",
        f.name,
        f.optional ? "?" : "",
        ": ",
        encodedTypeDoc(scope, f.type, recursive),
      ]);
      return group([
        "{",
        indent([line, join([";", line], fields)]),
        ifBreak(";"),
        line,
        "}",
      ]);
    }
    case "union":
      return unionDoc(
        type.members.map((m) => encodedTypeDoc(scope, m, recursive)),
      );
  }
}

/** The Effect Schema value of a type. The type has no function or provider in it. */
export function schemaDoc(
  scope: EmitNames,
  type: Type,
  recursive?: ReadonlySet<string>,
): Doc {
  const schema = scope.effect("Schema");
  if (isDeferredType(type)) {
    throw unsupported("a deferred or function type has no schema");
  }
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
      return recursive?.has(type.id)
        ? [
          `${schema}.suspend((): ${schema}.Codec<`,
          scope.nameOf(type.id),
          ", ",
          scope.encodedMirrorName(type.id),
          "> => ",
          scope.nameOf(type.id),
          ")",
        ]
        : scope.nameOf(type.id);
    case "array":
      return callWith(
        `${schema}.Array`,
        schemaDoc(scope, type.element, recursive),
      );
    case "tuple":
      return [
        `${schema}.Tuple(`,
        bracketed(
          "[",
          "]",
          type.elements.map((t) => schemaDoc(scope, t, recursive)),
          false,
        ),
        ")",
      ];
    case "option":
      return callWith(
        `${schema}.Option`,
        schemaDoc(scope, type.element, recursive),
      );
    case "record": {
      const fields = type.fields.map((f) => {
        const inner = schemaDoc(scope, f.type, recursive);
        return property(
          fieldKey(f.name),
          f.optional
            ? member(schema, "optionalKey", callWith("", inner))
            : inner,
        );
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
          type.members.map((m) => schemaDoc(scope, m, recursive)),
          false,
        ),
        ")",
      ];
    }
  }
}
