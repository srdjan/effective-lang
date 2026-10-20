// Checker contracts for the Schema adapters that tests/ did not cover before:
// schemaOptionalFromRequired, schemaOptionalTransform, schemaDefaultKey
// failure rules, general schemaUnion, and the authored issue forms. The
// evidence probes in docs/plans/schema-adapter-probes/ are in git history at
// commit 27cd655, before their deletion.
// Each negative case pins the diagnostic code, a message fragment, and the
// source text of the offending node.

import { assertEquals } from "@std/assert";
import { checkModule } from "./helpers.ts";
import { assertDiagnostics, type Expected } from "./schema_diagnostics.ts";

/** Marks an offending node that spans the whole initializer of `bad`. */
const INITIALIZER = Symbol("initializer");

type Pending = readonly [
  code: string,
  fragment: string,
  text: string | typeof INITIALIZER,
];

interface Negative {
  readonly name: string;
  /** Declarations that come before `const bad = <initializer>`. */
  readonly before?: string;
  readonly initializer: string;
  readonly expected: readonly Pending[];
}

function check(source: string) {
  return checkModule(source, "main.eff").diagnostics;
}

function accepted(source: string): void {
  assertEquals(check(source), []);
}

function rejected(prefix: string, cases: readonly Negative[]): void {
  for (const c of cases) {
    const source = prefix + (c.before ?? "") + `const bad = ${c.initializer}`;
    assertDiagnostics(
      source,
      check(source),
      c.expected.map(([code, fragment, text]): Expected => [
        code,
        fragment,
        text === INITIALIZER ? c.initializer : text,
      ]),
      c.name,
    );
  }
}

const requiredOptionalPrefix = `type Text = string
error Other = {}
service Read { next(value: Text): Text }
const text: Schema<Text> = schema()
const optional: SchemaOptional<Text> = schemaOptionalKey(text)
`;

Deno.test("required-to-optional field forms and shadowing are accepted", () => {
  accepted(
    requiredOptionalPrefix +
      `const field: SchemaDecodedOptional<Text, Text, Read.next> =
  schemaOptionalFromRequired(text, optional,
    (value: Text): Option<Text> uses Read.next => Some(Read.next(value)),
    (value: Option<Text>): Text => match value { Some(name) => name, None => "" })
const record: Schema<{ name?: Text }, { name: Text }, Read.next> =
  schemaStruct({ name: field })`,
  );
  accepted(
    `type Int = int
const schemaOptionalFromRequired = (): Int => 7
const value = schemaOptionalFromRequired()`,
  );
});

Deno.test("required-to-optional fields reject mismatched callbacks and descriptors", () => {
  const goodDecode = "(value: Text): Option<Text> => Some(value)";
  const goodEncode =
    '(value: Option<Text>): Text => match value { Some(name) => name, None => "" }';
  rejected(requiredOptionalPrefix, [
    {
      name: "optional source",
      initializer:
        `schemaOptionalFromRequired(optional, optional, ${goodDecode}, ${goodEncode})`,
      expected: [[
        "type-mismatch/010",
        "`schemaOptionalFromRequired` needs a Schema value",
        "optional",
      ]],
    },
    {
      name: "required target",
      initializer:
        `schemaOptionalFromRequired(text, text, ${goodDecode}, ${goodEncode})`,
      expected: [[
        "type-mismatch/010",
        "`schemaOptionalFromRequired` needs a SchemaOptional field",
        "text",
      ]],
    },
    {
      name: "wrong decode result",
      initializer:
        `schemaOptionalFromRequired(text, optional, (value: Text): Text => value, ${goodEncode})`,
      expected: [[
        "type-mismatch/003",
        "decode must return optional target-encoded values and encode must return a required source-decoded value",
        INITIALIZER,
      ]],
    },
    {
      name: "wrong encode result",
      initializer:
        `schemaOptionalFromRequired(text, optional, ${goodDecode}, (value: Option<Text>): Option<Text> => value)`,
      expected: [[
        "type-mismatch/003",
        "decode must return optional target-encoded values and encode must return a required source-decoded value",
        INITIALIZER,
      ]],
    },
    {
      name: "unrelated failure",
      initializer:
        `schemaOptionalFromRequired(text, optional, (value: Text): Option<Text> fails Other => fail(Other({})), ${goodEncode})`,
      expected: [[
        "type-mismatch/010",
        "callbacks may fail only with SchemaIssue",
        INITIALIZER,
      ]],
    },
    {
      name: "SchemaError failure",
      initializer:
        `schemaOptionalFromRequired(text, optional, (value: Text): Option<Text> fails SchemaError => { const decoded = schemaDecode(text, value)\n Some(decoded) }, ${goodEncode})`,
      expected: [[
        "type-mismatch/010",
        "callbacks may fail only with SchemaIssue",
        INITIALIZER,
      ]],
    },
    {
      name: "descriptor cannot run",
      before:
        `const field = schemaOptionalFromRequired(text, optional, ${goodDecode}, ${goodEncode})\n`,
      initializer: "schemaDecode(field, {})",
      expected: [
        [
          "execution-mode/002",
          "a module constant must have a pure initializer",
          INITIALIZER,
        ],
        ["type-mismatch/010", "`schemaDecode` needs a Schema value", "field"],
      ],
    },
  ]);
});

const optionalTransformPrefix = `type Int = int
type Text = string
error Other = {}
service Need { next(value: Int): Int }
const integer: Schema<Int> = schema()
const optional: SchemaOptional<Int> = schemaOptionalKey(integer)
`;

Deno.test("encoded-only optional descriptors and pure or effectful callbacks are accepted", () => {
  accepted(
    optionalTransformPrefix +
      `const option: SchemaEncodedOptional<Option<Int>, Int> = schemaOptionFromOptionalKey(integer)
const defaulted: SchemaEncodedOptional<Int> = schemaDefaultKey(integer, (): Int => 1)
const normalized: SchemaOptional<Int> = schemaOptionalTransform(optional, optional,
  (value: Option<Int>): Option<Int> => value,
  (value: Option<Int>): Option<Int> => value)
const record = schemaStruct({ option, defaulted, normalized })`,
  );
  accepted(
    optionalTransformPrefix +
      `const failingDefault = schemaDefaultKey(integer, (): Int fails SchemaIssue => fail(schemaInvalid("x")))
const effectfulDefault = schemaDefaultKey(integer, (): Int uses Need.next => Need.next(1))
const existingError = schemaDefaultKey(integer, (): Int fails SchemaError => schemaDecode(integer, 1))
const failingOptional = schemaOptionalTransform(optional, optional,
  (value: Option<Int>): Option<Int> fails SchemaIssue => fail(schemaInvalid("x")),
  (value: Option<Int>): Option<Int> => value)
const effectfulOptional = schemaOptionalTransform(optional, optional,
  (value: Option<Int>): Option<Int> uses Need.next => { const tick = Need.next(1)
    value },
  (value: Option<Int>): Option<Int> => value)`,
  );
});

Deno.test("optional descriptors cannot run and callback failures and types stay bounded", () => {
  const identity = "(value: Option<Int>): Option<Int> => value";
  rejected(optionalTransformPrefix, [
    {
      name: "descriptor cannot run",
      initializer: "schemaDecode(schemaOptionFromOptionalKey(integer), {})",
      expected: [
        [
          "execution-mode/002",
          "a module constant must have a pure initializer",
          INITIALIZER,
        ],
        [
          "type-mismatch/010",
          "`schemaDecode` needs a Schema value",
          "schemaOptionFromOptionalKey(integer)",
        ],
      ],
    },
    {
      name: "default without a callback",
      initializer: "schemaDefaultKey(integer, 1)",
      expected: [
        [
          "type-mismatch/010",
          "schemaDefaultKey needs an inline default callback",
          "1",
        ],
        [
          "type-mismatch/010",
          "the callback of `schemaDefaultKey` must be a function",
          "1",
        ],
      ],
    },
    {
      name: "wrong default type",
      initializer: 'schemaDefaultKey(integer, (): Text => "x")',
      expected: [[
        "type-mismatch/003",
        "schemaDefaultKey callback must return the decoded field type",
        '(): Text => "x"',
      ]],
    },
    {
      name: "unrelated default failure",
      initializer:
        "schemaDefaultKey(integer, (): Int fails Other => fail(Other({})))",
      expected: [[
        "type-mismatch/010",
        "callback may fail only with SchemaIssue or SchemaError",
        "(): Int fails Other => fail(Other({}))",
      ]],
    },
    {
      name: "wrong optional input",
      initializer:
        `schemaOptionalTransform(integer, optional, ${identity}, ${identity})`,
      expected: [[
        "type-mismatch/010",
        "`schemaOptionalTransform` needs a SchemaOptional field",
        "integer",
      ]],
    },
    {
      name: "wrong optional result",
      initializer:
        `schemaOptionalTransform(optional, optional, (value: Option<Int>): Int => 1, ${identity})`,
      expected: [[
        "type-mismatch/003",
        "schemaOptionalTransform callbacks must return directional Option values",
        INITIALIZER,
      ]],
    },
    {
      name: "unrelated optional failure",
      initializer:
        `schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails Other => fail(Other({})), ${identity})`,
      expected: [[
        "type-mismatch/010",
        "callbacks may fail only with SchemaIssue",
        INITIALIZER,
      ]],
    },
    {
      name: "SchemaError optional failure",
      initializer:
        `schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails SchemaError => { const decoded = schemaDecode(integer, 1)\n Some(decoded) }, ${identity})`,
      expected: [[
        "type-mismatch/010",
        "callbacks may fail only with SchemaIssue",
        INITIALIZER,
      ]],
    },
  ]);
});

const unionPrefix = `type Int = int
type LeftTag = "left"
type RightTag = "right"
type Left = { kind: LeftTag, value: Int }
type Right = { kind: RightTag, value: Int }
const integer: Schema<Int> = schema()
const leftTag: Schema<LeftTag> = schema()
const rightTag: Schema<RightTag> = schema()
const left: Schema<Left> = schemaStruct({ kind: leftTag, value: integer })
const right: Schema<Right> = schemaStruct({ kind: rightTag, value: integer })
`;

Deno.test("optional and tagged recursion, general Schema unions, and issue values are accepted", () => {
  accepted(
    `type Int = int
type Text = string
type LeftTag = "left"
type RightTag = "right"
type Left = { kind: LeftTag, value: Int }
type Right = { kind: RightTag, value: Int }
type OptionalNode = { next?: OptionalNode }
type TaggedNode = { kind: "end" } | { kind: "more", next: TaggedNode }
const integer: Schema<Int> = schema()
const text: Schema<Text> = schema()
const leftTag: Schema<LeftTag> = schema()
const rightTag: Schema<RightTag> = schema()
const left: Schema<Left> = schemaStruct({ kind: leftTag, value: integer })
const right: Schema<Right> = schemaStruct({ kind: rightTag, value: integer })
const optional: SchemaOptional<Int> = schemaOptionalKey(integer)
const record = schemaStruct({ value: optional })
const union = schemaUnion([left, right])
const primitives = schemaUnion([integer, text])
const overlapping = schemaUnion([left, left])
const issue = schemaAt("value", schemaBoth(integer, schemaInvalid("a"), schemaInvalid("b")))`,
  );
});

Deno.test("malformed union inputs, descriptor use, issue construction, and unguarded recursion are rejected", () => {
  const ordinaryBranches =
    "`schemaUnion` needs at least two ordinary Schema branches";
  rejected(unionPrefix, [
    {
      name: "one branch",
      initializer: "schemaUnion([integer])",
      expected: [["type-mismatch/010", ordinaryBranches, "[integer]"]],
    },
    {
      name: "not a list",
      initializer: "schemaUnion(integer)",
      expected: [[
        "type-mismatch/010",
        "`schemaUnion` needs an inline list of Schema branches",
        "integer",
      ]],
    },
    {
      name: "non-Schema branch",
      initializer: "schemaUnion([integer, 3])",
      expected: [
        ["type-mismatch/010", ordinaryBranches, "[integer, 3]"],
        ["type-mismatch/010", "`schemaUnion` needs a Schema value", "3"],
      ],
    },
    {
      name: "descriptor branch",
      initializer: "schemaUnion([integer, schemaOptionalKey(integer)])",
      expected: [
        [
          "type-mismatch/010",
          ordinaryBranches,
          "[integer, schemaOptionalKey(integer)]",
        ],
        [
          "type-mismatch/010",
          "`schemaUnion` needs a Schema value",
          "schemaOptionalKey(integer)",
        ],
      ],
    },
    {
      name: "optional descriptor cannot run",
      initializer: "schemaDecode(schemaOptionalKey(integer), 1)",
      expected: [
        [
          "execution-mode/002",
          "a module constant must have a pure initializer",
          INITIALIZER,
        ],
        [
          "type-mismatch/010",
          "`schemaDecode` needs a Schema value",
          "schemaOptionalKey(integer)",
        ],
      ],
    },
    {
      name: "issue key",
      initializer: 'schemaAt(true, schemaInvalid("x"))',
      expected: [[
        "type-mismatch/003",
        "schema issue key has type boolean, but string | int is expected",
        "true",
      ]],
    },
    {
      name: "SchemaIssue is not a constructor",
      initializer: "SchemaIssue({})",
      expected: [[
        "unknown-name/001",
        "unknown name `SchemaIssue`",
        "SchemaIssue",
      ]],
    },
    {
      name: "SchemaError is not a constructor",
      initializer: 'SchemaError({ message: "x" })',
      expected: [[
        "unknown-name/001",
        "unknown name `SchemaError`",
        "SchemaError",
      ]],
    },
  ]);
  // These cases declare a type or a typed constant, so they have no `bad` initializer.
  for (
    const [name, declaration, offending] of [
      ["required cycle", "type Loop = { next: Loop }", "Loop"],
      [
        "no terminal branch",
        'type Loop = { kind: "a", next: Loop } | { kind: "b", next: Loop }',
        "Loop",
      ],
    ]
  ) {
    const source = unionPrefix + declaration;
    assertDiagnostics(source, check(source), [[
      "declaration/007",
      "the type `Loop` is defined in terms of itself",
      offending,
    ]], name);
  }
  const unguarded = unionPrefix + `type Node = { next?: Node }
const base: Schema<Node> = schema()
const bad: Schema<Node> = schemaRecursive(
  (self: Schema<Node>): Schema<Node> => schemaUnion([self, base]))`;
  assertDiagnostics(unguarded, check(unguarded), [[
    "type-mismatch/010",
    "recursive schema self must occur beneath an array, optional key, or tagged union with a terminal branch",
    "(self: Schema<Node>): Schema<Node> => schemaUnion([self, base])",
  ]], "unguarded self use");
});
