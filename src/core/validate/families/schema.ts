// Validation of the Schema builtins: the Schema constructors and the make, decode, and encode
// operations. The table of the constructors sits here.

import {
  type Expr,
  type FunctionType,
  SCHEMA_ERROR_ID,
  SCHEMA_ISSUE_ID,
  type Type,
} from "../../ir.ts";
import { AREA } from "../report.ts";
import { exprChildren } from "../expr_walk.ts";
import {
  combine,
  invocationOf,
  isQuiet,
  QUIET,
  sortedUnique,
} from "../sets.ts";
import { asFunction, dataOnly, fits, same, STRING, unfold } from "../typing.ts";
import {
  type Comp,
  derivedResult,
  type Out,
  type ValidatorCore,
} from "./context.ts";

type SchemaExpr = Extract<Expr, { kind: "schema" }>;

type SchemaOp = SchemaExpr["op"];

type SchemaType = Extract<Type, { kind: "schema" }>;

type DefaultKeyOp = Extract<
  SchemaOp,
  "default-key" | "default-null-key" | "default-encoded-key"
>;

const DEFAULT_KEY_NAMES: Record<DefaultKeyOp, string> = {
  "default-key": "schemaDefaultKey",
  "default-null-key": "schemaDefaultNullKey",
  "default-encoded-key": "schemaDefaultEncodedKey",
};

/** The Schema operation under validation: the node, its path, and its checked arguments. */
interface SchemaCall {
  readonly e: SchemaExpr;
  readonly path: string;
  readonly args: readonly Out[];
}

/**
 * How a Schema operation passes the self reference of a recursive Schema body.
 * - none: the operation cannot hold the reference.
 * - default: argument 0 holds it, and the later arguments must not.
 * - optional: arguments 0 and 1 hold it, and the callbacks after them must not.
 * - guarding: every argument holds it, and the operation guards the recursion.
 * - passing: every argument holds it, and the guard state passes through.
 */
type SchemaRecursion = "none" | "default" | "optional" | "guarding" | "passing";

interface SchemaRow {
  readonly run: (c: ValidatorCore, call: SchemaCall) => Comp;
  /** The input Schema may carry a constructor default. */
  readonly acceptsDefault: boolean;
  readonly recursion: SchemaRecursion;
}

function schemaIssueType(): Type {
  return { kind: "named", id: SCHEMA_ISSUE_ID };
}

/** The function has no failure outside `allowed`, and at most one failure. */
function failsOnly(fn: FunctionType, allowed: readonly string[]): boolean {
  const { failures } = fn.effects;
  return failures.length === 0 ||
    (failures.length === 1 && allowed.includes(failures[0]));
}

function validSchemaCallback(fn: FunctionType | undefined): boolean {
  return fn !== undefined && failsOnly(fn, [SCHEMA_ISSUE_ID]) &&
    (fn.execution !== "pure" ||
      (fn.effects.failures.length === 0 &&
        fn.effects.requirements.length === 0));
}

/** The requirement sets of a Schema made from a source, a target, and two callbacks. */
function directionalRequirements(
  source: SchemaType,
  target: SchemaType,
  decode: FunctionType,
  encode: FunctionType,
): Pick<SchemaType, "decodeRequirements" | "encodeRequirements"> {
  return {
    decodeRequirements: sortedUnique([
      ...source.decodeRequirements,
      ...target.decodeRequirements,
      ...decode.effects.requirements,
    ]),
    encodeRequirements: sortedUnique([
      ...source.encodeRequirements,
      ...target.encodeRequirements,
      ...encode.effects.requirements,
    ]),
  };
}

function inheritedDefault(
  target: SchemaType,
): Pick<SchemaType, "constructorDefault"> {
  return target.constructorDefault === true ? { constructorDefault: true } : {};
}

function inheritedMakeInput(target: SchemaType): Pick<SchemaType, "makeInput"> {
  return target.makeInput === undefined ? {} : { makeInput: target.makeInput };
}

/**
 * One row for each Schema operation. A new operation is a compile error
 * until it has a row. The columns are the handler, whether `schemaOf`
 * accepts an input with a constructor default, and the role of the
 * operation in a recursive Schema body.
 */
const schemaRows: Record<SchemaOp, SchemaRow> = {
  "identity": {
    run: (c, call) => schemaIdentity(c, call),
    acceptsDefault: false,
    recursion: "none",
  },
  "array": {
    run: (c, call) => schemaArray(c, call),
    acceptsDefault: false,
    recursion: "guarding",
  },
  "struct": {
    run: (c, call) => schemaStruct(c, call),
    acceptsDefault: false,
    recursion: "passing",
  },
  "optional-key": {
    run: (c, call) => schemaOptionalKey(c, call),
    acceptsDefault: true,
    recursion: "guarding",
  },
  "null-to-missing-key": {
    run: (c, call) => schemaNullToMissingKey(c, call),
    acceptsDefault: true,
    recursion: "guarding",
  },
  "option-from-optional-key": {
    run: (c, call) => schemaOptionFromOptionalKey(c, call),
    acceptsDefault: true,
    recursion: "none",
  },
  "default-key": {
    run: (c, call) => schemaDefaultKey(c, call, "default-key"),
    acceptsDefault: true,
    recursion: "default",
  },
  "constructor-default": {
    run: (c, call) => schemaConstructorDefault(c, call),
    acceptsDefault: false,
    recursion: "default",
  },
  "default-null-key": {
    run: (c, call) => schemaDefaultKey(c, call, "default-null-key"),
    acceptsDefault: true,
    recursion: "default",
  },
  "default-encoded-key": {
    run: (c, call) => schemaDefaultKey(c, call, "default-encoded-key"),
    acceptsDefault: true,
    recursion: "default",
  },
  "optional-transform": {
    run: (c, call) => schemaOptionalTransform(c, call),
    acceptsDefault: false,
    recursion: "optional",
  },
  "optional-from-required": {
    run: (c, call) => schemaOptionalFromRequired(c, call),
    acceptsDefault: true,
    recursion: "optional",
  },
  "union": {
    run: (c, call) => schemaUnion(c, call),
    acceptsDefault: false,
    recursion: "passing",
  },
  "transform": {
    run: (c, call) => schemaTransform(c, call),
    acceptsDefault: false,
    recursion: "none",
  },
  "recursive": {
    run: (c, call) => schemaRecursive(c, call),
    acceptsDefault: false,
    recursion: "none",
  },
  "invalid": {
    run: (c, call) => schemaInvalid(c, call),
    acceptsDefault: false,
    recursion: "none",
  },
  "at": {
    run: (c, call) => schemaAt(c, call),
    acceptsDefault: false,
    recursion: "none",
  },
  "both": {
    run: (c, call) => schemaBoth(c, call),
    acceptsDefault: false,
    recursion: "none",
  },
};

/**
 * The validator reads IR that can be forged, so an operation can lie
 * outside the type. The table is read only for an operation that it names.
 */
function isSchemaOp(op: string): op is SchemaOp {
  return Object.hasOwn(schemaRows, op);
}

export function schema(c: ValidatorCore, e: SchemaExpr, path: string): Comp {
  const call: SchemaCall = {
    e,
    path,
    args: e.arguments.map((arg, i) => c.check(arg, `${path}.arguments[${i}]`)),
  };
  if (!isSchemaOp(e.op)) {
    return schemaBad(c, call, "unknown schema constructor");
  }
  return schemaRows[e.op].run(c, call);
}

/** The Schema that the operation accepts as input, or undefined. */
function schemaOf(
  c: ValidatorCore,
  call: SchemaCall,
  type: Type,
): SchemaType | undefined {
  const found = unfold(c.env, type);
  const { e } = call;
  return found.kind === "schema" &&
      (e.op === "constructor-default" || (found.optionalKey !== true &&
        found.encodedOptionalKey !== true &&
        found.decodedOptionalKey !== true)) &&
      (schemaRows[e.op].acceptsDefault ||
        found.constructorDefault !== true) &&
      (found.makeInput === undefined ||
        same(c.env, found.makeInput, found.decoded) ||
        // "invalid" and "at" return before any Schema is read, so only
        // "identity" is left out of the make-input operations.
        e.op !== "identity")
    ? found
    : undefined;
}

/** The accepted input Schema at an argument position. */
function schemaArg(
  c: ValidatorCore,
  call: SchemaCall,
  index: number,
): SchemaType | undefined {
  const arg = call.args[index];
  return arg === undefined ? undefined : schemaOf(c, call, arg.type);
}

/** The optional-key Schema at an argument position. */
function optionalArg(
  c: ValidatorCore,
  call: SchemaCall,
  index: number,
): SchemaType | undefined {
  const arg = call.args[index];
  if (arg === undefined) return undefined;
  const found = unfold(c.env, arg.type);
  return found.kind === "schema" && found.optionalKey === true &&
      found.encodedOptionalKey !== true &&
      found.decodedOptionalKey !== true
    ? found
    : undefined;
}

/** The function type at an argument position. */
function functionArg(
  c: ValidatorCore,
  call: SchemaCall,
  index: number,
): FunctionType | undefined {
  const arg = call.args[index];
  return arg === undefined ? undefined : asFunction(c.env, arg.type);
}

/** The unfolded type at an argument position. */
function typeArg(
  c: ValidatorCore,
  call: SchemaCall,
  index: number,
): Type | undefined {
  const arg = call.args[index];
  return arg === undefined ? undefined : unfold(c.env, arg.type);
}

/** Whether the node holds an inline closure at an argument position. */
function closureArg(
  call: SchemaCall,
  index: number,
): boolean {
  return call.e.arguments[index]?.kind === "closure";
}

function schemaBad(c: ValidatorCore, call: SchemaCall, message: string): Comp {
  c.add(AREA.types, call.path, message, call.e.span);
  return c.poison();
}

function schemaResult(call: SchemaCall, type: Type): Comp {
  return derivedResult(type, combine(call.args));
}

function schemaInvalid(c: ValidatorCore, call: SchemaCall): Comp {
  const { args } = call;
  if (args.length !== 1 || !fits(c.env, args[0].type, STRING)) {
    return schemaBad(c, call, "schemaInvalid needs a string message");
  }
  return schemaResult(call, schemaIssueType());
}

function schemaAt(c: ValidatorCore, call: SchemaCall): Comp {
  const { args } = call;
  if (
    args.length !== 2 ||
    !fits(c.env, args[0].type, {
      kind: "union",
      members: [
        { kind: "primitive", name: "string" },
        { kind: "primitive", name: "int" },
      ],
    }) || !fits(c.env, args[1].type, schemaIssueType())
  ) return schemaBad(c, call, "schemaAt needs a key and a SchemaIssue");
  return schemaResult(call, schemaIssueType());
}

function schemaBoth(c: ValidatorCore, call: SchemaCall): Comp {
  const { args } = call;
  if (
    args.length !== 3 || schemaArg(c, call, 0) === undefined ||
    !fits(c.env, args[1].type, schemaIssueType()) ||
    !fits(c.env, args[2].type, schemaIssueType())
  ) {
    return schemaBad(c, call, "schemaBoth needs a Schema and two issues");
  }
  return schemaResult(call, schemaIssueType());
}

function schemaIdentity(c: ValidatorCore, call: SchemaCall): Comp {
  const hint = schemaOf(c, call, call.e.type);
  if (
    call.args.length !== 0 || hint === undefined ||
    !same(c.env, hint.decoded, hint.encoded) ||
    hint.decodeRequirements.length || hint.encodeRequirements.length ||
    !dataOnly(c.env, hint.decoded, "value")
  ) {
    return schemaBad(
      c,
      call,
      "schema() needs an identity data Schema with no services",
    );
  }
  return derivedResult(hint, QUIET);
}

function schemaConstructorDefault(c: ValidatorCore, call: SchemaCall): Comp {
  const source = schemaArg(c, call, 0);
  const fn = functionArg(c, call, 1);
  if (
    call.args.length !== 2 || source === undefined || fn === undefined ||
    !closureArg(call, 1) ||
    fn.parameters.length !== 0 || fn.effects.requirements.length !== 0 ||
    !failsOnly(fn, [SCHEMA_ISSUE_ID]) ||
    (fn.execution === "pure" && fn.effects.failures.length !== 0) ||
    !fits(c.env, fn.result, source.makeInput ?? source.decoded)
  ) {
    return schemaBad(
      c,
      call,
      "schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure",
    );
  }
  return schemaResult(call, { ...source, constructorDefault: true });
}

function schemaArray(c: ValidatorCore, call: SchemaCall): Comp {
  const input = schemaArg(c, call, 0);
  if (call.args.length !== 1 || input === undefined) {
    return schemaBad(c, call, "schemaArray needs one Schema");
  }
  return schemaResult(call, {
    kind: "schema",
    decoded: { kind: "array", element: input.decoded },
    encoded: { kind: "array", element: input.encoded },
    makeInput: {
      kind: "array",
      element: input.makeInput ?? input.decoded,
    },
    decodeRequirements: input.decodeRequirements,
    encodeRequirements: input.encodeRequirements,
  });
}

function schemaNullToMissingKey(c: ValidatorCore, call: SchemaCall): Comp {
  const input = schemaArg(c, call, 0);
  const nil: Type = { kind: "literal", value: null };
  if (
    call.args.length !== 1 || input === undefined ||
    fits(c.env, nil, input.decoded) || fits(c.env, nil, input.encoded)
  ) {
    return schemaBad(
      c,
      call,
      "schemaNullToMissingKey needs one ordinary Schema with nonnullable decoded and encoded types",
    );
  }
  return schemaResult(call, {
    ...input,
    encoded: { kind: "union", members: [input.encoded, nil] },
    optionalKey: true,
  });
}

function schemaOptionalKey(c: ValidatorCore, call: SchemaCall): Comp {
  const input = schemaArg(c, call, 0);
  if (call.args.length !== 1 || input === undefined) {
    return schemaBad(c, call, "schemaOptionalKey needs one ordinary Schema");
  }
  return schemaResult(call, { ...input, optionalKey: true });
}

function schemaOptionFromOptionalKey(c: ValidatorCore, call: SchemaCall): Comp {
  const input = schemaArg(c, call, 0);
  if (call.args.length !== 1 || input === undefined) {
    return schemaBad(
      c,
      call,
      "schemaOptionFromOptionalKey needs one ordinary Schema",
    );
  }
  const { constructorDefault: _constructorDefault, ...plain } = input;
  return schemaResult(call, {
    ...plain,
    decoded: { kind: "option", element: input.decoded },
    makeInput: { kind: "option", element: input.decoded },
    encodedOptionalKey: true,
  });
}

function schemaDefaultKey(
  c: ValidatorCore,
  call: SchemaCall,
  op: DefaultKeyOp,
): Comp {
  const name = DEFAULT_KEY_NAMES[op];
  const direction = op === "default-encoded-key" ? "encoded" : "decoded";
  const nil: Type = { kind: "literal", value: null };
  const input = schemaArg(c, call, 0);
  const fallback = functionArg(c, call, 1);
  const validFailure = fallback !== undefined &&
    failsOnly(fallback, [SCHEMA_ISSUE_ID, SCHEMA_ERROR_ID]);
  const options = call.e.arguments[2];
  if (options !== undefined) {
    const field = options.kind === "record" && options.fields.length === 1
      ? options.fields[0]
      : undefined;
    if (
      field?.name !== "encodingStrategy" ||
      field.value.kind !== "literal" ||
      (field.value.value !== "omit" && field.value.value !== "passthrough")
    ) {
      return schemaBad(
        c,
        call,
        `${name} options need one literal "omit" or "passthrough" encodingStrategy`,
      );
    }
  }
  if (
    (call.args.length !== 2 && call.args.length !== 3) ||
    input === undefined || fallback === undefined ||
    !closureArg(call, 1) ||
    fallback.parameters.length !== 0 ||
    !validFailure ||
    (fallback.execution === "pure" &&
      (fallback.effects.failures.length !== 0 ||
        fallback.effects.requirements.length !== 0)) ||
    !fits(c.env, fallback.result, input[direction])
  ) {
    return schemaBad(
      c,
      call,
      `${name} needs a callback returning the ${direction} field type with only SchemaIssue or SchemaError failure`,
    );
  }
  if (
    op === "default-null-key" &&
    (fits(c.env, nil, input.decoded) ||
      fits(c.env, nil, input.encoded))
  ) {
    return schemaBad(
      c,
      call,
      `${name} needs nonnullable decoded and encoded field types`,
    );
  }
  return schemaResult(call, {
    ...input,
    encoded: op === "default-null-key"
      ? { kind: "union", members: [input.encoded, nil] }
      : input.encoded,
    encodedOptionalKey: true,
    decodeRequirements: sortedUnique([
      ...input.decodeRequirements,
      ...fallback.effects.requirements,
    ]),
  });
}

function schemaStruct(c: ValidatorCore, call: SchemaCall): Comp {
  const record = typeArg(c, call, 0);
  if (
    call.args.length !== 1 || record?.kind !== "record" ||
    record.fields.some((field) => field.optional)
  ) return schemaBad(c, call, "schemaStruct needs required Schema fields");
  const fields = record.fields.map((field) => ({
    field,
    schema: unfold(c.env, field.type),
  }));
  if (fields.some((field) => field.schema.kind !== "schema")) {
    return schemaBad(
      c,
      call,
      "schemaStruct field is not a Schema or optional descriptor",
    );
  }
  return schemaResult(call, {
    kind: "schema",
    decoded: {
      kind: "record",
      fields: fields.map(({ field, schema }) => ({
        name: field.name,
        optional: schema.kind === "schema" &&
          (schema.optionalKey === true ||
            schema.decodedOptionalKey === true),
        type: schema.kind === "schema" ? schema.decoded : field.type,
      })),
    },
    encoded: {
      kind: "record",
      fields: fields.map(({ field, schema }) => ({
        name: field.name,
        optional: schema.kind === "schema" &&
          (schema.optionalKey === true ||
            schema.encodedOptionalKey === true),
        type: schema.kind === "schema" ? schema.encoded : field.type,
      })),
    },
    makeInput: {
      kind: "record",
      fields: fields.map(({ field, schema }) => ({
        name: field.name,
        type: schema.kind === "schema"
          ? schema.makeInput ?? schema.decoded
          : field.type,
        optional: schema.kind === "schema" &&
          (schema.optionalKey === true ||
            schema.decodedOptionalKey === true ||
            schema.constructorDefault === true),
      })),
    },
    decodeRequirements: sortedUnique(
      fields.flatMap(({ schema }) =>
        schema.kind === "schema" ? schema.decodeRequirements : []
      ),
    ),
    encodeRequirements: sortedUnique(
      fields.flatMap(({ schema }) =>
        schema.kind === "schema" ? schema.encodeRequirements : []
      ),
    ),
  });
}

function schemaUnion(c: ValidatorCore, call: SchemaCall): Comp {
  const list = call.e.arguments[0];
  const tuple = typeArg(c, call, 0);
  if (
    call.args.length !== 1 || list?.kind !== "tuple" ||
    tuple?.kind !== "tuple" || tuple.elements.length < 2
  ) {
    return schemaBad(c, call, "schemaUnion needs an inline tuple of branches");
  }
  const branches = tuple.elements.map((element) => schemaOf(c, call, element));
  if (branches.some((branch) => branch === undefined)) {
    return schemaBad(
      c,
      call,
      "schemaUnion branches must be ordinary Schema values",
    );
  }
  const schemas = branches.filter((branch) => branch !== undefined);
  return schemaResult(call, {
    kind: "schema",
    decoded: { kind: "union", members: schemas.map((s) => s.decoded) },
    encoded: { kind: "union", members: schemas.map((s) => s.encoded) },
    makeInput: {
      kind: "union",
      members: schemas.map((s) => s.makeInput ?? s.decoded),
    },
    decodeRequirements: sortedUnique(
      schemas.flatMap((s) => s.decodeRequirements),
    ),
    encodeRequirements: sortedUnique(
      schemas.flatMap((s) => s.encodeRequirements),
    ),
  });
}

function schemaOptionalFromRequired(c: ValidatorCore, call: SchemaCall): Comp {
  const source = schemaArg(c, call, 0);
  const target = optionalArg(c, call, 1);
  const decode = functionArg(c, call, 2);
  const encode = functionArg(c, call, 3);
  if (
    call.args.length !== 4 || source === undefined || target === undefined ||
    !validSchemaCallback(decode) || !validSchemaCallback(encode) ||
    decode?.parameters.length !== 1 || encode?.parameters.length !== 1 ||
    !fits(c.env, source.decoded, decode.parameters[0]) ||
    !fits(
      c.env,
      { kind: "option", element: target.encoded },
      encode.parameters[0],
    ) ||
    !fits(c.env, decode.result, {
      kind: "option",
      element: target.encoded,
    }) ||
    !fits(c.env, encode.result, source.decoded) ||
    !closureArg(call, 2) ||
    !closureArg(call, 3)
  ) {
    return schemaBad(
      c,
      call,
      "schemaOptionalFromRequired needs required-to-optional callbacks with only SchemaIssue failure",
    );
  }
  return schemaResult(call, {
    kind: "schema",
    decoded: target.decoded,
    encoded: source.encoded,
    ...directionalRequirements(source, target, decode, encode),
    decodedOptionalKey: true,
    ...inheritedDefault(target),
    ...inheritedMakeInput(target),
  });
}

function schemaOptionalTransform(c: ValidatorCore, call: SchemaCall): Comp {
  const source = optionalArg(c, call, 0);
  const target = optionalArg(c, call, 1);
  const decode = functionArg(c, call, 2);
  const encode = functionArg(c, call, 3);
  if (
    call.args.length !== 4 || source === undefined || target === undefined ||
    !validSchemaCallback(decode) || !validSchemaCallback(encode) ||
    decode?.parameters.length !== 1 || encode?.parameters.length !== 1 ||
    !fits(
      c.env,
      { kind: "option", element: source.decoded },
      decode.parameters[0],
    ) ||
    !fits(
      c.env,
      { kind: "option", element: target.encoded },
      encode.parameters[0],
    ) ||
    !fits(c.env, decode.result, {
      kind: "option",
      element: target.encoded,
    }) ||
    !fits(c.env, encode.result, {
      kind: "option",
      element: source.decoded,
    }) ||
    !closureArg(call, 2) ||
    !closureArg(call, 3)
  ) {
    return schemaBad(
      c,
      call,
      "schemaOptionalTransform needs directional Option callbacks with only SchemaIssue failure",
    );
  }
  return schemaResult(call, {
    kind: "schema",
    decoded: target.decoded,
    encoded: source.encoded,
    ...directionalRequirements(source, target, decode, encode),
    optionalKey: true,
    ...inheritedDefault(target),
    ...inheritedMakeInput(target),
  });
}

function schemaRecursive(c: ValidatorCore, call: SchemaCall): Comp {
  const hint = schemaOf(c, call, call.e.type);
  const fn = functionArg(c, call, 0);
  if (
    call.args.length !== 1 || hint === undefined || fn === undefined ||
    fn.parameters.length !== 1 ||
    !same(c.env, fn.parameters[0], hint) ||
    !fits(c.env, fn.result, hint) || !isQuiet(invocationOf(fn)) ||
    !dataOnly(c.env, hint.decoded, "value") ||
    !dataOnly(c.env, hint.encoded, "value") ||
    !dataOnly(c.env, hint.makeInput ?? hint.decoded, "value") ||
    !guardedSchemaBody(c, call.e.arguments[0])
  ) {
    return schemaBad(
      c,
      call,
      "schemaRecursive needs a pure body from self to the expected data Schema",
    );
  }
  return schemaResult(call, hint);
}

function schemaTransform(c: ValidatorCore, call: SchemaCall): Comp {
  const source = schemaArg(c, call, 0);
  const target = schemaArg(c, call, 1);
  const decode = functionArg(c, call, 2);
  const encode = functionArg(c, call, 3);
  const callbackResult = (fn: typeof decode, value: Type) => {
    if (fn === undefined) return false;
    if (fn.effects.failures.length === 0) {
      return fits(c.env, fn.result, {
        kind: "option",
        element: value,
      });
    }
    return fn.effects.failures.length === 1 &&
      fn.effects.failures[0] === SCHEMA_ISSUE_ID &&
      fits(c.env, fn.result, value);
  };
  if (
    call.args.length !== 4 || source === undefined || target === undefined ||
    decode === undefined || encode === undefined ||
    decode.parameters.length !== 1 || encode.parameters.length !== 1 ||
    !fits(c.env, source.decoded, decode.parameters[0]) ||
    !fits(c.env, target.encoded, encode.parameters[0]) ||
    !callbackResult(decode, target.encoded) ||
    !callbackResult(encode, source.decoded) ||
    !closureArg(call, 2) ||
    !closureArg(call, 3)
  ) {
    return schemaBad(
      c,
      call,
      "schemaTransform callback types or failure channels do not match",
    );
  }
  return schemaResult(call, {
    kind: "schema",
    decoded: target.decoded,
    ...inheritedMakeInput(target),
    encoded: source.encoded,
    ...directionalRequirements(source, target, decode, encode),
  });
}

function guardedSchemaBody(
  c: ValidatorCore,
  callback: Expr | undefined,
): boolean {
  if (
    callback?.kind !== "closure" || callback.parameters.length !== 1 ||
    callback.body.kind !== "schema" ||
    (callback.body.op !== "struct" && callback.body.op !== "union")
  ) return false;
  const self = callback.parameters[0].id;
  const containsSelf = (value: Expr): boolean =>
    (value.kind === "reference" && value.target === self) ||
    exprChildren(value).some(containsSelf);
  const branches = callback.body.op === "union" &&
      callback.body.arguments[0]?.kind === "tuple"
    ? callback.body.arguments[0].elements
    : undefined;
  const tagMaps = (branches ?? []).map((branch) => {
    const schema = unfold(c.env, branch.type);
    const decoded = schema.kind === "schema"
      ? unfold(c.env, schema.decoded)
      : undefined;
    const encoded = schema.kind === "schema"
      ? unfold(c.env, schema.encoded)
      : undefined;
    const candidates = new Map<string, string>();
    if (decoded?.kind !== "record" || encoded?.kind !== "record") {
      return candidates;
    }
    for (const field of decoded.fields) {
      if (field.optional) continue;
      const other = encoded.fields.find((item) => item.name === field.name);
      if (other === undefined || other.optional) continue;
      const left = unfold(c.env, field.type);
      const right = unfold(c.env, other.type);
      if (
        left.kind === "literal" && right.kind === "literal" &&
        typeof left.value === "string" && left.value === right.value
      ) candidates.set(field.name, left.value);
    }
    return candidates;
  });
  const tagged = tagMaps.length >= 2 &&
    [...tagMaps[0].keys()].some((name) => {
      const values = tagMaps.map((candidate) => candidate.get(name));
      return values.every((value) => value !== undefined) &&
        new Set(values).size === values.length;
    });
  const finiteChoice = branches !== undefined && tagged &&
    branches.some((branch) => !containsSelf(branch));
  let found = false;
  const visit = (value: Expr, guarded: boolean): boolean => {
    if (!containsSelf(value)) return true;
    if (value.kind === "reference") {
      if (value.target !== self) return true;
      found = true;
      return guarded;
    }
    if (value.kind === "record") {
      return value.fields.every((field) => visit(field.value, guarded));
    }
    if (value.kind === "schema") {
      const role = isSchemaOp(value.op)
        ? schemaRows[value.op].recursion
        : "none";
      switch (role) {
        case "default":
          return value.arguments.length >= 2 &&
            value.arguments.slice(1).every((argument) =>
              !containsSelf(argument)
            ) &&
            visit(value.arguments[0], guarded);
        case "optional":
          return value.arguments.length === 4 &&
            value.arguments.slice(2).every((argument) =>
              !containsSelf(argument)
            ) &&
            value.arguments.slice(0, 2).every((argument) =>
              visit(argument, guarded)
            );
        case "guarding":
          return value.arguments.every((argument) => visit(argument, true));
        case "passing":
          return value.arguments.every((argument) => visit(argument, guarded));
        case "none":
          return false;
        default: {
          const unreachable: never = role;
          return unreachable;
        }
      }
    }
    if (value.kind === "tuple") {
      return value.elements.every((element) => visit(element, guarded));
    }
    return false;
  };
  return visit(callback.body, finiteChoice) && found;
}

export function schemaOperation(
  c: ValidatorCore,
  e: Extract<
    Expr,
    { kind: "schema-decode" | "schema-encode" | "schema-make" }
  >,
  path: string,
): Comp {
  const schema = c.check(e.schema, `${path}.schema`);
  const input = c.check(e.input, `${path}.input`);
  const type = unfold(c.env, schema.type);
  if (
    type.kind !== "schema" || type.constructorDefault === true ||
    (e.kind === "schema-make" &&
      (type.optionalKey === true || type.encodedOptionalKey === true ||
        type.decodedOptionalKey === true))
  ) {
    c.add(
      AREA.types,
      path,
      "schema runner needs an ordinary Schema value",
      e.span,
    );
    return c.poison();
  }
  if (
    e.kind !== "schema-decode" &&
    !fits(
      c.env,
      input.type,
      e.kind === "schema-make" ? type.makeInput ?? type.decoded : type.decoded,
    )
  ) {
    c.add(
      AREA.types,
      `${path}.input`,
      `${
        e.kind === "schema-make" ? "schemaMake" : "schemaEncode"
      } input does not fit decoded type`,
      e.input.span,
    );
  }
  return derivedResult(
    e.kind === "schema-encode" ? type.encoded : type.decoded,
    combine([schema, input, {
      execution: "effect",
      failures: [
        e.kind === "schema-make" ? SCHEMA_ISSUE_ID : SCHEMA_ERROR_ID,
      ],
      requirements: e.kind === "schema-make"
        ? []
        : e.kind === "schema-decode"
        ? type.decodeRequirements
        : type.encodeRequirements,
    }]),
  );
}
