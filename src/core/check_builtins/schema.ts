// Schema construction, directional transformations, defaults and recursion checks.
import { SCHEMA_ERROR_ID, SCHEMA_ISSUE_ID } from "../ir.ts";
import { kindOf, type NodeId, SyntaxKind } from "../syntax.ts";
import { literalOf } from "../syntax_queries.ts";
import {
  combine,
  type NodeFact,
  type NodeInfo,
  PURE_EFFECTS,
} from "../tables.ts";
import { dataOnly, type TypeNode, type TypeRef } from "../types.ts";
import type {
  Arg,
  BuiltinContext,
  FactView,
  FactWriter,
  ResolveView,
  SyntaxView,
} from "./context.ts";
import type {
  BuiltinRow,
  PreludeCallName,
  Rows,
  SharedPrologue,
} from "./rows.ts";

export interface SchemaContext extends
  Pick<
    BuiltinContext,
    | "table"
    | "argInfo"
    | "callback"
    | "finish"
    | "fits"
    | "functionOf"
    | "isError"
    | "report"
  >,
  SyntaxView,
  ResolveView,
  FactView,
  FactWriter {
  readonly infos: ReadonlyMap<NodeId, NodeInfo>;
  kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[];
  expr(node: NodeId, expected?: TypeRef): NodeInfo;
  fieldParts(
    field: NodeId,
  ): {
    readonly label: string;
    readonly labelNode: NodeId;
    readonly value: NodeId | undefined;
  } | undefined;
}

/** A Schema type node. */
type SchemaNode = Extract<TypeNode, { kind: "schema" }>;

/**
 * True when `failures` is known and holds no failure or exactly one failure
 * from `allowed`. A set with two failures fails the test, even when both are
 * allowed.
 */
function failsOnlyWith(
  failures: readonly string[] | undefined,
  allowed: readonly string[],
): boolean {
  return failures !== undefined && failures.length <= 1 &&
    failures.every((id) => allowed.includes(id));
}

/** The Schema op of a builtin. */
type SchemaOp = Extract<NodeFact, { kind: "schema" }>["op"];

/**
 * Where `self` may occur below a call of a Schema builtin in a recursive body.
 * - "guard": the argument is below a guard, so `self` is allowed there.
 * - "container": the arguments keep the guard state that the call has.
 * - "pass-first": `self` may occur only in the first argument. A later one is a callback.
 * - "pass-two": `self` may occur only in the first two arguments.
 * - "reject": `self` may not occur below the call.
 */
type RecursionRole =
  | "guard"
  | "container"
  | "pass-first"
  | "pass-two"
  | "reject";

/** How `schemaCall` treats one Schema builtin. */
export interface SchemaBuiltin {
  readonly op: SchemaOp;
  /** The number of arguments. */
  readonly arity: number;
  /** A third options argument is also accepted. */
  readonly acceptsOptions?: true;
  /** The Schema argument may carry a constructor default. */
  readonly acceptsDefault: boolean;
  /** Constructor make-input metadata passes through this builtin. */
  readonly preservesMakeInput: boolean;
  /** How a recursive Schema body may hold its `self` below a call of this builtin. */
  readonly recursion: RecursionRole;
}

export const SCHEMA_BUILTINS = {
  schema: {
    op: "identity",
    arity: 0,
    acceptsDefault: false,
    preservesMakeInput: false,
    recursion: "reject",
  },
  schemaArray: {
    op: "array",
    arity: 1,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "guard",
  },
  schemaStruct: {
    op: "struct",
    arity: 1,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "container",
  },
  schemaOptionalKey: {
    op: "optional-key",
    arity: 1,
    acceptsDefault: true,
    preservesMakeInput: true,
    recursion: "guard",
  },
  schemaNullToMissingKey: {
    op: "null-to-missing-key",
    arity: 1,
    acceptsDefault: true,
    preservesMakeInput: true,
    recursion: "guard",
  },
  schemaOptionFromOptionalKey: {
    op: "option-from-optional-key",
    arity: 1,
    acceptsDefault: true,
    preservesMakeInput: true,
    recursion: "reject",
  },
  schemaDefaultKey: {
    op: "default-key",
    arity: 2,
    acceptsOptions: true,
    acceptsDefault: true,
    preservesMakeInput: true,
    recursion: "pass-first",
  },
  schemaConstructorDefault: {
    op: "constructor-default",
    arity: 2,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "pass-first",
  },
  schemaOptionalTransform: {
    op: "optional-transform",
    arity: 4,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "pass-two",
  },
  schemaOptionalFromRequired: {
    op: "optional-from-required",
    arity: 4,
    acceptsDefault: true,
    preservesMakeInput: true,
    recursion: "pass-two",
  },
  schemaUnion: {
    op: "union",
    arity: 1,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "container",
  },
  schemaTransform: {
    op: "transform",
    arity: 4,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "reject",
  },
  schemaRecursive: {
    op: "recursive",
    arity: 1,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "reject",
  },
  schemaDecode: {
    op: "decode",
    arity: 2,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "reject",
  },
  schemaEncode: {
    op: "encode",
    arity: 2,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "reject",
  },
  schemaMake: {
    op: "make",
    arity: 2,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "reject",
  },
  schemaInvalid: {
    op: "invalid",
    arity: 1,
    acceptsDefault: false,
    preservesMakeInput: false,
    recursion: "reject",
  },
  schemaAt: {
    op: "at",
    arity: 2,
    acceptsDefault: false,
    preservesMakeInput: false,
    recursion: "reject",
  },
  schemaBoth: {
    op: "both",
    arity: 3,
    acceptsDefault: false,
    preservesMakeInput: true,
    recursion: "reject",
  },
} as const satisfies Record<string, SchemaBuiltin>;

/** The values of the `on` option of `schemaDefaultKey`. */
const DEFAULT_KEY_ON = ["missing", "null", "encoded"] as const;

const DEFAULT_KEY_OPS = {
  missing: "default-key",
  null: "default-null-key",
  encoded: "default-encoded-key",
} as const;

export type SchemaBuiltinName = keyof typeof SCHEMA_BUILTINS;

/** The recursion role of a builtin name; a name that is not a Schema builtin rejects `self`. */
function recursionRoleOf(name: string | undefined): RecursionRole {
  return name !== undefined && isSchemaBuiltinName(name)
    ? SCHEMA_BUILTINS[name].recursion
    : "reject";
}

/** True when a builtin name is a Schema builtin. */
function isSchemaBuiltinName(name: string): name is SchemaBuiltinName {
  return Object.hasOwn(SCHEMA_BUILTINS, name);
}

/** What a Schema handler reads from the call. */
interface SchemaCall {
  readonly node: NodeId;
  readonly name: SchemaBuiltinName;
  readonly builtin: SchemaBuiltin;
  /** The op that the prologue recorded: `schemaDefaultKey` may select another with `on`. */
  readonly op: SchemaOp;
  readonly args: readonly Arg[];
  readonly expected: TypeRef | undefined;
}

type SchemaHandler = (checker: SchemaContext, call: SchemaCall) => NodeInfo;

/** One handler for each Schema op. A missing op is a compile error. */
type SchemaHandlers = { readonly [O in SchemaOp]: SchemaHandler };

/** One handler for every Schema op; missing operations fail checking. */
const SCHEMA_HANDLERS: SchemaHandlers = {
  identity: (c, call) => schemaIdentityCall(c, call),
  array: (c, call) => schemaArrayCall(c, call),
  struct: (c, call) => schemaStructCall(c, call),
  "optional-key": (c, call) => schemaOptionalKeyCall(c, call),
  "null-to-missing-key": (c, call) => schemaNullToMissingKeyCall(c, call),
  "option-from-optional-key": (c, call) =>
    schemaOptionFromOptionalKeyCall(c, call),
  "default-key": (c, call) =>
    schemaDefaultKeyCall(c, call, { direction: "decoded", nullable: false }),
  "constructor-default": (c, call) => schemaConstructorDefaultCall(c, call),
  "default-null-key": (c, call) =>
    schemaDefaultKeyCall(c, call, { direction: "decoded", nullable: true }),
  "default-encoded-key": (c, call) =>
    schemaDefaultKeyCall(c, call, { direction: "encoded", nullable: false }),
  "optional-transform": (c, call) => schemaOptionalBridgeCall(c, call, false),
  "optional-from-required": (c, call) =>
    schemaOptionalBridgeCall(c, call, true),
  union: (c, call) => schemaUnionCall(c, call),
  transform: (c, call) => schemaTransformCall(c, call),
  recursive: (c, call) => schemaRecursiveCall(c, call),
  decode: (c, call) => schemaOperationCall(c, call, "decode"),
  encode: (c, call) => schemaOperationCall(c, call, "encode"),
  make: (c, call) => schemaOperationCall(c, call, "make"),
  invalid: (c, call) => schemaInvalidCall(c, call),
  at: (c, call) => schemaAtCall(c, call),
  both: (c, call) => schemaBothCall(c, call),
};

/** The Schema operation that the prologue recorded for a Schema builtin call. */
function schemaOp(c: SchemaContext, node: NodeId): SchemaOp {
  const fact = c.facts.get(node);
  if (fact?.kind !== "schema") {
    throw new Error("internal: a Schema builtin call has no schema fact");
  }
  return fact.op;
}

/** The literal value of a field in an inline options record, by label. */
function optionsField(c: SchemaContext, record: NodeId, label: string): {
  readonly value: NodeId | undefined;
} | undefined {
  if (kindOf(c.tree, record) !== SyntaxKind.RecordExpr) {
    return undefined;
  }
  for (const field of c.kids(record)) {
    const parts = c.fieldParts(field);
    if (parts?.label === label) {
      return { value: parts.value };
    }
  }
  return undefined;
}

/**
 * The Schema operation that the `on` option of `schemaDefaultKey` selects.
 * An absent `on` means "missing". An `on` that is not one of the three
 * literals is reported here and selects the default operation.
 */
export function defaultKeyOp(
  c: SchemaContext,
  name: SchemaBuiltinName,
  options: Arg,
): "default-key" | "default-null-key" | "default-encoded-key" {
  const field = optionsField(c, options.node, "on");
  if (field === undefined) {
    return "default-key";
  }
  const value = field.value;
  const literal = value !== undefined &&
      kindOf(c.tree, value) === SyntaxKind.LiteralExpr
    ? literalOf(c.tree, value)
    : undefined;
  const on = DEFAULT_KEY_ON.find((candidate) => candidate === literal);
  if (on === undefined) {
    c.report(
      "type-mismatch/010",
      `${name} \`on\` must be a literal "missing", "null", or "encoded"`,
      value ?? options.node,
    );
    return "default-key";
  }
  return DEFAULT_KEY_OPS[on];
}

/** Whether an options record is inline with distinct known fields. */
function defaultKeyOptionsShape(c: SchemaContext, record: NodeId): boolean {
  if (kindOf(c.tree, record) !== SyntaxKind.RecordExpr) {
    return false;
  }
  const fields = c.kids(record);
  if (fields.length < 1 || fields.length > 2) {
    return false;
  }
  const seen = new Set<string>();
  for (const field of fields) {
    const parts = kindOf(c.tree, field) === SyntaxKind.RecordField
      ? c.fieldParts(field)
      : undefined;
    if (
      parts === undefined || parts.value === undefined ||
      seen.has(parts.label) ||
      kindOf(c.tree, parts.value) !== SyntaxKind.LiteralExpr
    ) {
      return false;
    }
    seen.add(parts.label);
    if (parts.label === "encodingStrategy") {
      const strategy = literalOf(c.tree, parts.value);
      if (strategy !== "omit" && strategy !== "passthrough") {
        return false;
      }
    } else if (parts.label !== "on") {
      return false;
    }
  }
  return true;
}

export function schemaCall(
  c: SchemaContext,
  node: NodeId,
  name: SchemaBuiltinName,
  args: readonly Arg[],
  expected: TypeRef | undefined,
): NodeInfo {
  const builtin: SchemaBuiltin = SCHEMA_BUILTINS[name];
  const op = schemaOp(c, node);
  const handler = SCHEMA_HANDLERS[op];
  return handler(c, { node, name, builtin, op, args, expected });
}

function changedMakeInput(c: SchemaContext, type: SchemaNode): boolean {
  return type.makeInput !== undefined &&
    !(c.table.isAssignable(type.makeInput, type.decoded) &&
      c.table.isAssignable(type.decoded, type.makeInput));
}

/** The Schema type of a checked argument, or undefined after a report. */
function schemaOf(
  c: SchemaContext,
  call: SchemaCall,
  info: NodeInfo,
  at: NodeId,
): SchemaNode | undefined {
  const { name, builtin, op } = call;
  const type = c.table.node(c.table.unfold(info.type));
  const accepted = type.kind === "schema" &&
    (op === "constructor-default" ||
      type.presence === "required") &&
    (builtin.acceptsDefault || type.constructorDefault !== true);
  if (!accepted && !c.isError(info.type)) {
    c.report("type-mismatch/010", `\`${name}\` needs a Schema value`, at);
  }
  if (
    type.kind === "schema" && changedMakeInput(c, type) &&
    !builtin.preservesMakeInput
  ) {
    c.report(
      "type-mismatch/010",
      `${name} does not yet preserve constructor make-input metadata`,
      at,
    );
  }
  return accepted ? type : undefined;
}

/** The SchemaOptional type of a checked argument, or undefined after a report. */
function optionalOf(
  c: SchemaContext,
  call: SchemaCall,
  info: NodeInfo,
  at: NodeId,
): SchemaNode | undefined {
  const type = c.table.node(c.table.unfold(info.type));
  if (type.kind !== "schema" || type.presence !== "optional") {
    if (!c.isError(info.type)) {
      c.report(
        "type-mismatch/010",
        `\`${call.name}\` needs a SchemaOptional field`,
        at,
      );
    }
    return undefined;
  }
  return type;
}

/** Checks the first argument as the Schema that most ops wrap. */
function firstSchema(c: SchemaContext, call: SchemaCall): {
  first: NodeInfo;
  schema: SchemaNode | undefined;
} {
  const first = c.argInfo(call.args[0]);
  return { first, schema: schemaOf(c, call, first, call.args[0].node) };
}

/** The result of `schemaInvalid`, `schemaAt`, and `schemaBoth`: a SchemaIssue. */
function schemaIssue(
  c: SchemaContext,
  call: SchemaCall,
  check: (infos: NodeInfo[], issue: TypeRef) => void,
): NodeInfo {
  const infos = call.args.map((arg) => c.argInfo(arg));
  const issue = c.table.named(SCHEMA_ISSUE_ID);
  check(infos, issue);
  return c.finish(call.node, issue, combine(infos));
}

function schemaInvalidCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { args } = call;
  return schemaIssue(c, call, (infos) => {
    c.fits(args[0].node, infos[0].type, c.table.string, "schema issue message");
  });
}

function schemaAtCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { args } = call;
  return schemaIssue(c, call, (infos, issue) => {
    c.fits(
      args[0].node,
      infos[0].type,
      c.table.union([c.table.string, c.table.int]),
      "schema issue key",
    );
    c.fits(args[1].node, infos[1].type, issue, "nested schema issue");
  });
}

function schemaBothCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { args } = call;
  return schemaIssue(c, call, (infos, issue) => {
    schemaOf(c, call, infos[0], args[0].node);
    c.fits(args[1].node, infos[1].type, issue, "left schema issue");
    c.fits(args[2].node, infos[2].type, issue, "right schema issue");
  });
}

/**
 * The expected Schema type that `schema()` and `schemaRecursive` read their
 * type from, with the expected type itself. Returns undefined after a report.
 */
function expectedSchema(c: SchemaContext, call: SchemaCall): {
  schema: SchemaNode;
  type: TypeRef;
} | undefined {
  const { node, name, expected } = call;
  const hintKind = expected === undefined
    ? undefined
    : c.table.node(c.table.unfold(expected)).kind;
  const hintable = hintKind === "schema" || hintKind === "error";
  const hint = expected === undefined || !hintable
    ? undefined
    : schemaOf(c, call, {
      type: expected,
      failures: [],
      requirements: [],
      mode: "pure",
    }, node);
  if (expected === undefined || hint === undefined) {
    // `schemaOf` has already reported a rejected flag or a poisoned hint.
    if (!hintable) {
      c.report(
        "type-mismatch/010",
        `\`${name}\` needs an expected Schema type`,
        node,
      );
    }
    return undefined;
  }
  if (
    !dataOnly(c.table, hint.decoded, "value", true) ||
    !dataOnly(c.table, hint.encoded, "value", true) ||
    !dataOnly(c.table, hint.makeInput ?? hint.decoded, "value", true)
  ) {
    c.report("type-mismatch/010", "Schema data must be compiler-derived", node);
  }
  return { schema: hint, type: expected };
}

function schemaIdentityCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { node } = call;
  const hint = expectedSchema(c, call);
  if (hint === undefined) {
    return c.finish(node, c.table.error, PURE_EFFECTS);
  }
  if (
    hint.schema.decoded !== hint.schema.encoded ||
    hint.schema.decodeRequirements.length ||
    hint.schema.encodeRequirements.length
  ) {
    c.report(
      "type-mismatch/003",
      "`schema()` needs an identity Schema with no services",
      node,
    );
  }
  return c.finish(node, hint.type, PURE_EFFECTS);
}

function schemaRecursiveCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { node, name, args } = call;
  const hint = expectedSchema(c, call);
  if (hint === undefined) {
    return c.finish(
      node,
      c.table.error,
      combine(args.map((a) => c.argInfo(a))),
    );
  }
  const callback = c.callback(name, args[0], [hint.type], hint.type, false);
  if (!guardedSchemaCallback(c, args[0].node)) {
    c.report(
      "type-mismatch/010",
      "recursive schema self must occur beneath an array, optional key, or tagged union with a terminal branch",
      args[0].node,
    );
  }
  if (!c.table.isAssignable(callback.result, hint.type)) {
    c.report(
      "type-mismatch/003",
      "recursive schema body does not fit its expected Schema",
      args[0].node,
    );
  }
  return c.finish(node, hint.type, combine([callback.info]));
}

function schemaStructCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { node, args } = call;
  const input = c.argInfo(args[0]);
  const record = c.table.node(c.table.unfold(input.type));
  if (record.kind !== "record" || record.fields.some((f) => f.optional)) {
    c.report(
      "type-mismatch/010",
      "`schemaStruct` needs a record of required Schema fields",
      args[0].node,
    );
    return c.finish(node, c.table.error, combine([input]));
  }
  const fields = record.fields.flatMap((field) => {
    const schema = c.table.node(c.table.unfold(field.type));
    return schema.kind === "schema" ? [{ field, schema }] : [];
  });
  if (fields.length !== record.fields.length) {
    c.report(
      "type-mismatch/010",
      "`schemaStruct` fields must be Schema values or schemaOptionalKey descriptors",
      args[0].node,
    );
    return c.finish(node, c.table.error, combine([input]));
  }
  const decoded = c.table.record(fields.map(({ field, schema }) => ({
    name: field.name,
    type: schema.decoded,
    optional: schema.presence === "optional" ||
      schema.presence === "decoded-optional",
  })));
  const encoded = c.table.record(fields.map(({ field, schema }) => ({
    name: field.name,
    type: schema.encoded,
    optional: schema.presence === "optional" ||
      schema.presence === "encoded-optional",
  })));
  return c.finish(
    node,
    c.table.schema(
      decoded,
      encoded,
      fields.flatMap(({ schema }) => schema.decodeRequirements),
      fields.flatMap(({ schema }) => schema.encodeRequirements),
      {
        makeInput: c.table.record(fields.map(({ field, schema }) => ({
          name: field.name,
          type: schema.makeInput ?? schema.decoded,
          optional: schema.presence === "optional" ||
            schema.presence === "decoded-optional" ||
            schema.constructorDefault === true,
        }))),
      },
    ),
    combine([input]),
  );
}

function schemaUnionCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { node, args } = call;
  const list = args[0].node;
  if (kindOf(c.tree, list) !== SyntaxKind.ListExpr) {
    const input = c.argInfo(args[0]);
    c.report(
      "type-mismatch/010",
      "`schemaUnion` needs an inline list of Schema branches",
      list,
    );
    return c.finish(node, c.table.error, combine([input]));
  }
  const elements = c.kids(list);
  c.fact(list, { kind: "list", shape: "tuple" });
  const infos = elements.map((element) => c.expr(element));
  const input = c.finish(
    list,
    c.table.tuple(infos.map((info) => info.type)),
    combine(infos),
  );
  const branches = infos.map((info, index) =>
    schemaOf(c, call, info, elements[index])
  );
  if (branches.length < 2 || branches.some((branch) => branch === undefined)) {
    c.report(
      "type-mismatch/010",
      "`schemaUnion` needs at least two ordinary Schema branches",
      list,
    );
    return c.finish(node, c.table.error, combine([input]));
  }
  const schemas = branches.filter((branch) => branch !== undefined);
  return c.finish(
    node,
    c.table.schema(
      c.table.union(schemas.map((branch) => branch.decoded)),
      c.table.union(schemas.map((branch) => branch.encoded)),
      schemas.flatMap((branch) => branch.decodeRequirements),
      schemas.flatMap((branch) => branch.encodeRequirements),
      {
        makeInput: c.table.union(
          schemas.map((branch) => branch.makeInput ?? branch.decoded),
        ),
      },
    ),
    combine([input]),
  );
}

/** `schemaOptionalTransform` and `schemaOptionalFromRequired`. */
function schemaOptionalBridgeCall(
  c: SchemaContext,
  call: SchemaCall,
  fromRequired: boolean,
): NodeInfo {
  const { node, name, args } = call;
  const sourceInfo = c.argInfo(args[0]);
  const targetInfo = c.argInfo(args[1]);
  const source = fromRequired
    ? schemaOf(c, call, sourceInfo, args[0].node)
    : optionalOf(c, call, sourceInfo, args[0].node);
  const target = optionalOf(c, call, targetInfo, args[1].node);
  if (source === undefined || target === undefined) {
    return c.finish(
      node,
      c.table.error,
      combine([
        sourceInfo,
        targetInfo,
        ...args.slice(2).map((arg) => c.argInfo(arg)),
      ]),
    );
  }
  return optionalBridge(c, node, name, args, {
    sourceInfo,
    targetInfo,
    source,
    target,
  }, fromRequired);
}

function schemaConstructorDefaultCall(
  c: SchemaContext,
  call: SchemaCall,
): NodeInfo {
  const { node, name, args } = call;
  const { first, schema } = firstSchema(c, call);
  const callback = c.callback(
    name,
    args[1],
    [],
    schema?.makeInput ?? schema?.decoded,
    true,
  );
  const fn = c.functionOf(callback.info.type);
  if (
    kindOf(c.tree, args[1].node) !== SyntaxKind.ArrowExpr ||
    fn === undefined ||
    fn.requirements.length !== 0 ||
    !failsOnlyWith(fn.failures, [SCHEMA_ISSUE_ID]) ||
    (schema !== undefined &&
      !c.table.isAssignable(
        callback.result,
        schema.makeInput ?? schema.decoded,
      ))
  ) {
    c.report(
      "type-mismatch/010",
      "schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure",
      args[1].node,
    );
  }
  return c.finish(
    node,
    schema === undefined ? c.table.error : c.table.schema(
      schema.decoded,
      schema.encoded,
      schema.decodeRequirements,
      schema.encodeRequirements,
      {
        presence: schema.presence,
        makeInput: schema.makeInput ?? schema.decoded,
        constructorDefault: true,
      },
    ),
    combine([first, callback.info]),
  );
}

function schemaNullToMissingKeyCall(
  c: SchemaContext,
  call: SchemaCall,
): NodeInfo {
  const { node, args } = call;
  const { first, schema } = firstSchema(c, call);
  const nil = c.table.literal(null);
  if (
    schema !== undefined &&
    (c.table.isAssignable(nil, schema.decoded) ||
      c.table.isAssignable(nil, schema.encoded))
  ) {
    c.report(
      "type-mismatch/010",
      "schemaNullToMissingKey needs nonnullable decoded and encoded field types",
      args[0].node,
    );
  }
  return c.finish(
    node,
    schema === undefined ? c.table.error : c.table.schema(
      schema.decoded,
      c.table.union([schema.encoded, nil]),
      schema.decodeRequirements,
      schema.encodeRequirements,
      {
        presence: "optional",
        makeInput: schema.makeInput ?? schema.decoded,
        constructorDefault: schema.constructorDefault === true,
      },
    ),
    combine([first]),
  );
}

function schemaOptionalKeyCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { first, schema } = firstSchema(c, call);
  return c.finish(
    call.node,
    schema === undefined ? c.table.error : c.table.schema(
      schema.decoded,
      schema.encoded,
      schema.decodeRequirements,
      schema.encodeRequirements,
      {
        presence: "optional",
        makeInput: schema.makeInput ?? schema.decoded,
        constructorDefault: schema.constructorDefault === true,
      },
    ),
    combine([first]),
  );
}

function schemaArrayCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { first, schema } = firstSchema(c, call);
  return c.finish(
    call.node,
    schema === undefined ? c.table.error : c.table.schema(
      c.table.array(schema.decoded),
      c.table.array(schema.encoded),
      schema.decodeRequirements,
      schema.encodeRequirements,
      { makeInput: c.table.array(schema.makeInput ?? schema.decoded) },
    ),
    combine([first]),
  );
}

function schemaOptionFromOptionalKeyCall(
  c: SchemaContext,
  call: SchemaCall,
): NodeInfo {
  const { first, schema } = firstSchema(c, call);
  return c.finish(
    call.node,
    schema === undefined ? c.table.error : c.table.schema(
      c.table.option(schema.decoded),
      schema.encoded,
      schema.decodeRequirements,
      schema.encodeRequirements,
      { presence: "encoded-optional" },
    ),
    combine([first]),
  );
}

/**
 * `schemaDefaultKey`, `schemaDefaultNullKey`, and `schemaDefaultEncodedKey`.
 * `direction` names the field type that the default callback returns.
 * `nullable` adds null to the encoded type and rejects a nullable field.
 */
function schemaDefaultKeyCall(c: SchemaContext, call: SchemaCall, variant: {
  direction: "decoded" | "encoded";
  nullable: boolean;
}): NodeInfo {
  const { node, name, args } = call;
  const { direction, nullable } = variant;
  const { first, schema } = firstSchema(c, call);
  const nil = c.table.literal(null);
  if (
    nullable && schema !== undefined &&
    (c.table.isAssignable(nil, schema.decoded) ||
      c.table.isAssignable(nil, schema.encoded))
  ) {
    c.report(
      "type-mismatch/010",
      `${name} needs nonnullable decoded and encoded field types`,
      args[0].node,
    );
  }
  const defaultType = direction === "encoded"
    ? schema?.encoded
    : schema?.decoded;
  const fallback = c.callback(name, args[1], [], defaultType, true);
  const fallbackFn = c.functionOf(fallback.info.type);
  if (
    fallbackFn !== undefined &&
    !failsOnlyWith(fallbackFn.failures, [SCHEMA_ISSUE_ID, SCHEMA_ERROR_ID])
  ) {
    c.report(
      "type-mismatch/010",
      `${name} callback may fail only with SchemaIssue or SchemaError`,
      args[1].node,
    );
  }
  if (kindOf(c.tree, args[1].node) !== SyntaxKind.ArrowExpr) {
    c.report(
      "type-mismatch/010",
      `${name} needs an inline default callback`,
      args[1].node,
    );
  }
  if (
    defaultType !== undefined &&
    !c.table.isAssignable(fallback.result, defaultType)
  ) {
    c.report(
      "type-mismatch/003",
      `${name} callback must return the ${direction} field type`,
      args[1].node,
    );
  }
  const options = args[2] === undefined ? undefined : c.argInfo(
    args[2],
    c.table.record([{
      name: "on",
      type: c.table.union(DEFAULT_KEY_ON.map((on) => c.table.literal(on))),
      optional: true,
    }, {
      name: "encodingStrategy",
      type: c.table.union([
        c.table.literal("omit"),
        c.table.literal("passthrough"),
      ]),
      optional: true,
    }]),
  );
  if (options !== undefined && !defaultKeyOptionsShape(c, args[2].node)) {
    c.report(
      "type-mismatch/010",
      `${name} options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values`,
      args[2].node,
    );
  }
  return c.finish(
    node,
    schema === undefined ? c.table.error : c.table.schema(
      schema.decoded,
      nullable ? c.table.union([schema.encoded, nil]) : schema.encoded,
      [...schema.decodeRequirements, ...(fallbackFn?.requirements ?? [])],
      schema.encodeRequirements,
      {
        presence: "encoded-optional",
        makeInput: schema.makeInput ?? schema.decoded,
        constructorDefault: schema.constructorDefault === true,
      },
    ),
    combine([
      first,
      fallback.info,
      ...(options === undefined ? [] : [options]),
    ]),
  );
}

/** `schemaDecode`, `schemaEncode`, and `schemaMake`: run a Schema on a value. */
function schemaOperationCall(
  c: SchemaContext,
  call: SchemaCall,
  op: "decode" | "encode" | "make",
): NodeInfo {
  const { node, args } = call;
  const { first, schema } = firstSchema(c, call);
  const input = c.argInfo(
    args[1],
    op === "decode"
      ? undefined
      : op === "make"
      ? schema?.makeInput ?? schema?.decoded
      : schema?.decoded,
  );
  if (op !== "decode" && schema !== undefined) {
    c.fits(
      args[1].node,
      input.type,
      op === "make" ? schema.makeInput ?? schema.decoded : schema.decoded,
      `the schema ${op} input`,
    );
  }
  return c.finish(
    node,
    schema === undefined
      ? c.table.error
      : op === "encode"
      ? schema.encoded
      : schema.decoded,
    combine([first, input, {
      failures: [op === "make" ? SCHEMA_ISSUE_ID : SCHEMA_ERROR_ID],
      requirements: schema === undefined || op === "make"
        ? []
        : op === "decode"
        ? schema.decodeRequirements
        : schema.encodeRequirements,
      mode: "effect",
    }]),
  );
}

function schemaTransformCall(c: SchemaContext, call: SchemaCall): NodeInfo {
  const { node, name, args } = call;
  const { first, schema } = firstSchema(c, call);
  const targetInfo = c.argInfo(args[1]);
  const target = schemaOf(c, call, targetInfo, args[1].node);
  if (schema === undefined || target === undefined) {
    const rest = args.slice(2).map((a) => c.argInfo(a));
    return c.finish(node, c.table.error, combine([first, targetInfo, ...rest]));
  }
  const decode = c.callback(
    name,
    args[2],
    [schema.decoded],
    c.table.option(target.encoded),
    true,
  );
  const encode = c.callback(
    name,
    args[3],
    [target.encoded],
    c.table.option(schema.decoded),
    true,
  );
  const decodeFn = c.functionOf(decode.info.type);
  const encodeFn = c.functionOf(encode.info.type);
  if (
    kindOf(c.tree, args[2].node) !== SyntaxKind.ArrowExpr ||
    kindOf(c.tree, args[3].node) !== SyntaxKind.ArrowExpr
  ) {
    c.report(
      "type-mismatch/010",
      "schemaTransform needs inline callbacks",
      node,
    );
  }
  if (
    !failsOnlyWith(decodeFn?.failures, [SCHEMA_ISSUE_ID]) ||
    !failsOnlyWith(encodeFn?.failures, [SCHEMA_ISSUE_ID])
  ) {
    c.report(
      "type-mismatch/010",
      "schema transformations may fail only with SchemaIssue",
      node,
    );
  }
  const decodeExpected = decodeFn?.failures.includes(SCHEMA_ISSUE_ID)
    ? target.encoded
    : c.table.option(target.encoded);
  const encodeExpected = encodeFn?.failures.includes(SCHEMA_ISSUE_ID)
    ? schema.decoded
    : c.table.option(schema.decoded);
  if (
    !c.table.isAssignable(decode.result, decodeExpected) ||
    !c.table.isAssignable(encode.result, encodeExpected)
  ) {
    c.report(
      "type-mismatch/003",
      "schema transformation callbacks must return Option or issue-failing values in their direction",
      node,
    );
  }
  return c.finish(
    node,
    c.table.schema(target.decoded, schema.encoded, [
      ...schema.decodeRequirements,
      ...target.decodeRequirements,
      ...(decodeFn?.requirements ?? []),
    ], [
      ...schema.encodeRequirements,
      ...target.encodeRequirements,
      ...(encodeFn?.requirements ?? []),
    ], { makeInput: target.makeInput ?? target.decoded }),
    combine([first, targetInfo, decode.info, encode.info]),
  );
}

/**
 * The shared tail of schemaOptionalTransform and schemaOptionalFromRequired.
 * Both bridge a source field to an optional target. A required source passes
 * its value to the decode callback and reads its value from the encode
 * callback. An optional source passes and reads an Option.
 */
function optionalBridge(
  c: SchemaContext,
  node: NodeId,
  name: string,
  args: readonly Arg[],
  parts: {
    readonly sourceInfo: NodeInfo;
    readonly targetInfo: NodeInfo;
    readonly source: SchemaNode;
    readonly target: SchemaNode;
  },
  fromRequired: boolean,
): NodeInfo {
  const { sourceInfo, targetInfo, source, target } = parts;
  const sourceValue = fromRequired
    ? source.decoded
    : c.table.option(source.decoded);
  const decode = c.callback(
    name,
    args[2],
    [sourceValue],
    c.table.option(target.encoded),
    true,
  );
  const encode = c.callback(
    name,
    args[3],
    [c.table.option(target.encoded)],
    sourceValue,
    true,
  );
  const decodeFn = c.functionOf(decode.info.type);
  const encodeFn = c.functionOf(encode.info.type);
  if (
    !failsOnlyWith(decodeFn?.failures, [SCHEMA_ISSUE_ID]) ||
    !failsOnlyWith(encodeFn?.failures, [SCHEMA_ISSUE_ID])
  ) {
    c.report(
      "type-mismatch/010",
      `${name} callbacks may fail only with SchemaIssue`,
      node,
    );
  }
  if (
    kindOf(c.tree, args[2].node) !== SyntaxKind.ArrowExpr ||
    kindOf(c.tree, args[3].node) !== SyntaxKind.ArrowExpr
  ) {
    c.report("type-mismatch/010", `${name} needs inline callbacks`, node);
  }
  if (
    !c.table.isAssignable(decode.result, c.table.option(target.encoded)) ||
    !c.table.isAssignable(encode.result, sourceValue)
  ) {
    c.report(
      "type-mismatch/003",
      fromRequired
        ? `${name} decode must return optional target-encoded values and encode must return a required source-decoded value`
        : `${name} callbacks must return directional Option values`,
      node,
    );
  }
  return c.finish(
    node,
    c.table.schema(target.decoded, source.encoded, [
      ...source.decodeRequirements,
      ...target.decodeRequirements,
      ...(decodeFn?.requirements ?? []),
    ], [
      ...source.encodeRequirements,
      ...target.encodeRequirements,
      ...(encodeFn?.requirements ?? []),
    ], {
      presence: fromRequired ? "decoded-optional" : "optional",
      makeInput: target.makeInput ?? target.decoded,
      constructorDefault: target.constructorDefault === true,
    }),
    combine([sourceInfo, targetInfo, decode.info, encode.info]),
  );
}

function guardedSchemaCallback(c: SchemaContext, node: NodeId): boolean {
  if (kindOf(c.tree, node) !== SyntaxKind.ArrowExpr) {
    return false;
  }
  const parts = c.kids(node);
  const params = parts.find((part) =>
    kindOf(c.tree, part) === SyntaxKind.ParamList
  );
  const first = params === undefined
    ? undefined
    : c.kidsOfKind(params, SyntaxKind.Param)[0];
  const name = first === undefined
    ? undefined
    : c.kidsOfKind(first, SyntaxKind.Name)[0];
  const self = name === undefined ? undefined : c.targets.get(name);
  const body = parts.at(-1);
  const builtin = (part: NodeId): string | undefined => {
    if (kindOf(c.tree, part) !== SyntaxKind.CallExpr) {
      return undefined;
    }
    const callee = c.kids(part)[0];
    const target = callee === undefined ? undefined : c.targets.get(callee);
    return target?.kind === "builtin" ? target.name : undefined;
  };
  if (
    self?.kind !== "local" || body === undefined ||
    kindOf(c.tree, body) !== SyntaxKind.CallExpr ||
    recursionRoleOf(builtin(body)) !== "container"
  ) {
    return false;
  }
  const isSelf = (part: NodeId): boolean => {
    const target = c.targets.get(part);
    return kindOf(c.tree, part) === SyntaxKind.NameExpr &&
      target?.kind === "local" && target.id === self.id;
  };
  const containsSelf = (part: NodeId): boolean =>
    isSelf(part) || c.kids(part).some(containsSelf);
  const union = builtin(body) === "schemaUnion";
  const findList = (part: NodeId): NodeId | undefined =>
    kindOf(c.tree, part) === SyntaxKind.ListExpr
      ? part
      : c.kids(part).map(findList).find((found) => found !== undefined);
  const list = union ? findList(body) : undefined;
  const tags = list === undefined ? [] : c.kids(list).map((branch) => {
    const info = c.infos.get(branch);
    const schema = info === undefined
      ? undefined
      : c.table.node(c.table.unfold(info.type));
    const decoded = schema?.kind === "schema"
      ? c.table.node(c.table.unfold(schema.decoded))
      : undefined;
    const encoded = schema?.kind === "schema"
      ? c.table.node(c.table.unfold(schema.encoded))
      : undefined;
    const candidates = new Map<string, string>();
    if (decoded?.kind !== "record" || encoded?.kind !== "record") {
      return candidates;
    }
    for (const field of decoded.fields) {
      if (field.optional) {
        continue;
      }
      const other = encoded.fields.find((item) => item.name === field.name);
      if (other === undefined || other.optional) {
        continue;
      }
      const left = c.table.node(c.table.unfold(field.type));
      const right = c.table.node(c.table.unfold(other.type));
      if (
        left.kind === "literal" && right.kind === "literal" &&
        typeof left.value === "string" && left.value === right.value
      ) {
        candidates.set(field.name, left.value);
      }
    }
    return candidates;
  });
  const tagged = tags.length >= 2 && [...tags[0].keys()].some((name) => {
    const values = tags.map((candidate) => candidate.get(name));
    return values.every((value) => value !== undefined) &&
      new Set(values).size === values.length;
  });
  const finiteChoice = list !== undefined &&
    tagged &&
    c.kids(list).some((branch) => !containsSelf(branch));
  let found = false;
  const visit = (part: NodeId, guarded: boolean): boolean => {
    if (!containsSelf(part)) {
      return true;
    }
    if (isSelf(part)) {
      found = true;
      return guarded;
    }
    if (kindOf(c.tree, part) === SyntaxKind.CallExpr) {
      const role = recursionRoleOf(builtin(part));
      const args = c.kids(part).find((child) =>
        kindOf(c.tree, child) === SyntaxKind.ArgList
      );
      const values = args === undefined ? [] : c.kids(args);
      switch (role) {
        case "pass-first":
          return values.length >= 2 &&
            values.slice(1).every((value) => !containsSelf(value)) &&
            visit(values[0], guarded);
        case "pass-two":
          return values.length === 4 &&
            values.slice(2).every((value) => !containsSelf(value)) &&
            values.slice(0, 2).every((value) => visit(value, guarded));
        case "guard":
          return values.every((value) => visit(value, true));
        case "container":
          return values.every((value) => visit(value, guarded));
        case "reject":
          return false;
        default: {
          const unreachable: never = role;
          return unreachable;
        }
      }
    }
    return c.kids(part).every((child) => visit(child, guarded));
  };
  return visit(body, finiteChoice) && found;
}

/** One prologue serves every Schema builtin. `schemaDefaultKey` selects its operation with the `on` option. */
const SCHEMA_PROLOGUE: SharedPrologue<SchemaBuiltinName, SchemaContext> = {
  arity: (name, args) => {
    const builtin: SchemaBuiltin = SCHEMA_BUILTINS[name];
    return builtin.acceptsOptions === true && args.length === 3
      ? 3
      : builtin.arity;
  },
  bail: "pure",
  pipeline: "direct",
  fact: (c, name, args) => ({
    kind: "schema",
    op: name === "schemaDefaultKey" && args.length === 3
      ? defaultKeyOp(c, name, args[2])
      : SCHEMA_BUILTINS[name].op,
  }),
};

const SCHEMA_HANDLE: BuiltinRow<SchemaBuiltinName, SchemaContext>["handle"] = (
  c,
  node,
  name,
  args,
  expected,
) => schemaCall(c, node, name, args, expected);

/** The rows of the Schema builtins. */
export const SCHEMA_ROWS = {
  schema: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaArray: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaStruct: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaOptionalKey: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaNullToMissingKey: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaOptionFromOptionalKey: {
    prologue: SCHEMA_PROLOGUE,
    handle: SCHEMA_HANDLE,
  },
  schemaDefaultKey: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaConstructorDefault: {
    prologue: SCHEMA_PROLOGUE,
    handle: SCHEMA_HANDLE,
  },
  schemaOptionalTransform: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaOptionalFromRequired: {
    prologue: SCHEMA_PROLOGUE,
    handle: SCHEMA_HANDLE,
  },
  schemaUnion: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaTransform: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaRecursive: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaDecode: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaEncode: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaMake: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaInvalid: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaAt: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
  schemaBoth: { prologue: SCHEMA_PROLOGUE, handle: SCHEMA_HANDLE },
} satisfies Partial<Rows<PreludeCallName, SchemaContext>>;
