// Unit tests for `fits` and `same` of the independent validator, for the
// compound types that carry variance rules: Schema, Schedule, Sink,
// RetrySchedule, Codec, Fiber, CloseableScope, and null against unit. Each test
// builds Type values by hand and checks both directions of `fits`, and `same`.

import { assert, assertEquals } from "@std/assert";
import type { Field, Type } from "../src/core/ir.ts";
import { fits, same, type TypeEnv } from "../src/core/validate/typing.ts";

const ENV: TypeEnv = {
  module: "m",
  aliases: new Map<string, Type>([
    ["type:m#Alias", { kind: "primitive", name: "string" }],
  ]),
  brands: new Map<string, Type>(),
  data: new Map(),
  errors: new Map<string, readonly Field[]>(),
  opaque: new Set<string>(),
  sealed: new Set<string>(),
};

const INT: Type = { kind: "primitive", name: "int" };
const NUMBER: Type = { kind: "primitive", name: "number" };
const STRING: Type = { kind: "primitive", name: "string" };
const UNIT: Type = { kind: "primitive", name: "unit" };
const NEVER: Type = { kind: "primitive", name: "never" };
const UNKNOWN: Type = { kind: "primitive", name: "unknown" };
const NULL: Type = { kind: "literal", value: null };
const ALIAS: Type = { kind: "named", id: "type:m#Alias" };

const A = "cap:m#A";
const B = "cap:m#B";
const E = "error:m#E";
const F = "error:m#F";

interface Relation {
  /** `fits(a, b)` */
  readonly forward: boolean;
  /** `fits(b, a)` */
  readonly backward: boolean;
  /** `same(a, b)`. `same` is symmetric. */
  readonly same: boolean;
}

/** Checks both directions of `fits` and both directions of `same`. */
function relate(label: string, a: Type, b: Type, expected: Relation): void {
  assertEquals(fits(ENV, a, b), expected.forward, `${label}: fits(a, b)`);
  assertEquals(fits(ENV, b, a), expected.backward, `${label}: fits(b, a)`);
  assertEquals(same(ENV, a, b), expected.same, `${label}: same(a, b)`);
  assertEquals(same(ENV, b, a), expected.same, `${label}: same(b, a)`);
}

const EQUAL: Relation = { forward: true, backward: true, same: true };
const UNRELATED: Relation = { forward: false, backward: false, same: false };
/** The left type fits the right type, but not the reverse. */
const ONE_WAY: Relation = { forward: true, backward: false, same: false };

// ------------------------------------------------------------------- Schema

type SchemaType = Extract<Type, { kind: "schema" }>;

function schema(over: Partial<Omit<SchemaType, "kind">> = {}): Type {
  return {
    kind: "schema",
    decoded: INT,
    encoded: STRING,
    decodeRequirements: [],
    encodeRequirements: [],
    ...over,
  };
}

Deno.test("Schema: an equal Schema fits and is the same", () => {
  relate("plain", schema(), schema(), EQUAL);
  relate(
    "all flags and services",
    schema({
      optionalKey: true,
      constructorDefault: true,
      decodeRequirements: [A],
      encodeRequirements: [B],
      makeInput: NUMBER,
      decoded: NUMBER,
    }),
    schema({
      optionalKey: true,
      constructorDefault: true,
      decodeRequirements: [A],
      encodeRequirements: [B],
      makeInput: NUMBER,
      decoded: NUMBER,
    }),
    EQUAL,
  );
});

Deno.test("Schema: each of the four flags must match in both directions", () => {
  const flags = [
    "optionalKey",
    "encodedOptionalKey",
    "decodedOptionalKey",
    "constructorDefault",
  ] as const;
  for (const flag of flags) {
    relate(
      `${flag} against absent`,
      schema({ [flag]: true }),
      schema(),
      UNRELATED,
    );
    relate(
      `${flag} on both`,
      schema({ [flag]: true }),
      schema({ [flag]: true }),
      EQUAL,
    );
  }
  for (const first of flags) {
    for (const second of flags) {
      if (first === second) continue;
      relate(
        `${first} against ${second}`,
        schema({ [first]: true }),
        schema({ [second]: true }),
        UNRELATED,
      );
    }
  }
});

Deno.test("Schema: decoded and encoded types are invariant", () => {
  relate(
    "decoded int against number",
    schema(),
    schema({ decoded: NUMBER }),
    UNRELATED,
  );
  relate(
    "encoded string against unknown",
    schema(),
    schema({ encoded: UNKNOWN }),
    UNRELATED,
  );
  relate(
    "encoded never against string",
    schema({ encoded: NEVER }),
    schema(),
    UNRELATED,
  );
  relate(
    "an alias equals its target",
    schema({ encoded: ALIAS }),
    schema(),
    EQUAL,
  );
});

Deno.test("Schema: make input is invariant and a missing make input equals the decoded type", () => {
  relate(
    "missing against the decoded type",
    schema(),
    schema({ makeInput: INT }),
    EQUAL,
  );
  relate(
    "missing against a wider make input",
    schema(),
    schema({ makeInput: NUMBER }),
    UNRELATED,
  );
  relate(
    "int against number make input",
    schema({ makeInput: INT }),
    schema({ makeInput: NUMBER }),
    UNRELATED,
  );
  relate(
    "make input against the decoded type of the other side",
    schema({ decoded: NUMBER, makeInput: INT }),
    schema({ decoded: NUMBER }),
    UNRELATED,
  );
  relate(
    "equal make input through an alias",
    schema({ decoded: STRING, makeInput: ALIAS }),
    schema({ decoded: STRING }),
    EQUAL,
  );
});

Deno.test("Schema: requirement sets are subsets under fits and equal under same", () => {
  relate(
    "decode requirements: none against one",
    schema(),
    schema({ decodeRequirements: [A] }),
    ONE_WAY,
  );
  relate(
    "encode requirements: none against one",
    schema(),
    schema({ encodeRequirements: [A] }),
    ONE_WAY,
  );
  relate(
    "decode requirements: one against two",
    schema({ decodeRequirements: [A] }),
    schema({ decodeRequirements: [A, B] }),
    ONE_WAY,
  );
  relate(
    "decode requirements: disjoint",
    schema({ decodeRequirements: [A] }),
    schema({ decodeRequirements: [B] }),
    UNRELATED,
  );
  relate(
    "a decode service is not an encode service",
    schema({ decodeRequirements: [A] }),
    schema({ encodeRequirements: [A] }),
    UNRELATED,
  );
  relate(
    "both sets grow together",
    schema({ decodeRequirements: [A] }),
    schema({ decodeRequirements: [A], encodeRequirements: [B] }),
    ONE_WAY,
  );
});

Deno.test("Schema: a Schema is not another kind of type", () => {
  relate("against Codec", schema(), {
    kind: "codec",
    decoded: INT,
    encoded: STRING,
  }, UNRELATED);
  relate("against its decoded type", schema(), INT, UNRELATED);
});

// ----------------------------------------------------------------- Schedule

type ScheduleType = Extract<Type, { kind: "schedule" }>;

function schedule(over: Partial<Omit<ScheduleType, "kind">> = {}): Type {
  return {
    kind: "schedule",
    output: INT,
    input: INT,
    effects: { failures: [], requirements: [] },
    ...over,
  };
}

Deno.test("Schedule: output is covariant", () => {
  relate(
    "output int against number",
    schedule(),
    schedule({ output: NUMBER }),
    ONE_WAY,
  );
  relate(
    "output string against int",
    schedule({ output: STRING }),
    schedule(),
    UNRELATED,
  );
});

Deno.test("Schedule: input is contravariant", () => {
  relate(
    "input number against int",
    schedule({ input: NUMBER }),
    schedule(),
    ONE_WAY,
  );
  relate(
    "input string against int",
    schedule({ input: STRING }),
    schedule(),
    UNRELATED,
  );
});

Deno.test("Schedule: a source with unknown input fits every input, but unknown is not a top type as a target", () => {
  relate(
    "unknown against int",
    schedule({ input: UNKNOWN }),
    schedule(),
    ONE_WAY,
  );
  relate(
    "unknown against string",
    schedule({ input: UNKNOWN }),
    schedule({ input: STRING }),
    ONE_WAY,
  );
  relate(
    "unknown against unknown",
    schedule({ input: UNKNOWN }),
    schedule({ input: UNKNOWN }),
    EQUAL,
  );
});

Deno.test("Schedule: failure and requirement sets are subsets", () => {
  const none = { failures: [], requirements: [] };
  relate(
    "failures",
    schedule(),
    schedule({ effects: { failures: [E], requirements: [] } }),
    ONE_WAY,
  );
  relate(
    "requirements",
    schedule({ effects: none }),
    schedule({ effects: { failures: [], requirements: [A] } }),
    ONE_WAY,
  );
  relate(
    "disjoint failures",
    schedule({ effects: { failures: [E], requirements: [] } }),
    schedule({ effects: { failures: [F], requirements: [] } }),
    UNRELATED,
  );
});

// --------------------------------------------------------------------- Sink

type SinkType = Extract<Type, { kind: "sink" }>;

function sink(over: Partial<Omit<SinkType, "kind">> = {}): Type {
  return {
    kind: "sink",
    input: INT,
    result: INT,
    effects: { failures: [], requirements: [] },
    ...over,
  };
}

Deno.test("Sink: input is contravariant, result is covariant", () => {
  relate("input number against int", sink({ input: NUMBER }), sink(), ONE_WAY);
  relate(
    "input string against int",
    sink({ input: STRING }),
    sink(),
    UNRELATED,
  );
  relate(
    "result int against number",
    sink(),
    sink({ result: NUMBER }),
    ONE_WAY,
  );
  relate(
    "result string against int",
    sink({ result: STRING }),
    sink(),
    UNRELATED,
  );
});

Deno.test("Sink: leftover is covariant and a missing leftover equals never", () => {
  relate("missing against never", sink(), sink({ leftover: NEVER }), EQUAL);
  relate("missing against int", sink(), sink({ leftover: INT }), ONE_WAY);
  relate(
    "never against int",
    sink({ leftover: NEVER }),
    sink({ leftover: INT }),
    ONE_WAY,
  );
  relate(
    "int against number",
    sink({ leftover: INT }),
    sink({ leftover: NUMBER }),
    ONE_WAY,
  );
  relate(
    "string against int",
    sink({ leftover: STRING }),
    sink({ leftover: INT }),
    UNRELATED,
  );
  relate(
    "equal leftover",
    sink({ leftover: INT }),
    sink({ leftover: INT }),
    EQUAL,
  );
});

Deno.test("Sink: failure and requirement sets are subsets", () => {
  relate(
    "failures",
    sink(),
    sink({ effects: { failures: [E], requirements: [] } }),
    ONE_WAY,
  );
  relate(
    "requirements",
    sink(),
    sink({ effects: { failures: [], requirements: [A] } }),
    ONE_WAY,
  );
  relate(
    "disjoint requirements",
    sink({ effects: { failures: [], requirements: [A] } }),
    sink({ effects: { failures: [], requirements: [B] } }),
    UNRELATED,
  );
});

// ------------------------------------------------- RetrySchedule and Codec

Deno.test("RetrySchedule: the error type is invariant", () => {
  const retry = (error: Type): Type => ({ kind: "retry-schedule", error });
  relate(
    "equal",
    retry({ kind: "named", id: E }),
    retry({ kind: "named", id: E }),
    EQUAL,
  );
  relate(
    "different errors",
    retry({ kind: "named", id: E }),
    retry({ kind: "named", id: F }),
    UNRELATED,
  );
  relate("int against number", retry(INT), retry(NUMBER), UNRELATED);
  relate("an alias equals its target", retry(ALIAS), retry(STRING), EQUAL);
});

Deno.test("Codec: decoded and encoded types are invariant", () => {
  const codec = (decoded: Type, encoded: Type): Type => ({
    kind: "codec",
    decoded,
    encoded,
  });
  relate("equal", codec(INT, STRING), codec(INT, STRING), EQUAL);
  relate(
    "decoded int against number",
    codec(INT, STRING),
    codec(NUMBER, STRING),
    UNRELATED,
  );
  relate(
    "encoded string against unknown",
    codec(INT, STRING),
    codec(INT, UNKNOWN),
    UNRELATED,
  );
  relate(
    "an alias equals its target",
    codec(INT, ALIAS),
    codec(INT, STRING),
    EQUAL,
  );
});

// -------------------------------------------- Fiber and CloseableScope

Deno.test("Fiber: result is covariant and failure sets must be equal even under fits", () => {
  const fiber = (
    result: Type,
    failures: readonly (typeof E | typeof F)[],
  ): Type => ({
    kind: "fiber",
    result,
    failures,
  });
  relate("equal", fiber(INT, [E]), fiber(INT, [E]), EQUAL);
  relate(
    "result int against number",
    fiber(INT, [E]),
    fiber(NUMBER, [E]),
    ONE_WAY,
  );
  relate(
    "result string against int",
    fiber(STRING, [E]),
    fiber(INT, [E]),
    UNRELATED,
  );
  relate("a smaller failure set", fiber(INT, []), fiber(INT, [E]), UNRELATED);
  relate(
    "a larger failure set",
    fiber(INT, [E, F]),
    fiber(INT, [E]),
    UNRELATED,
  );
  relate("different failures", fiber(INT, [E]), fiber(INT, [F]), UNRELATED);
  relate(
    "failure order is irrelevant",
    fiber(INT, [E, F]),
    fiber(INT, [F, E]),
    EQUAL,
  );
  relate(
    "a covariant result does not relax the failure sets",
    fiber(INT, []),
    fiber(NUMBER, [E]),
    UNRELATED,
  );
});

Deno.test("CloseableScope: it fits only itself", () => {
  const scope: Type = { kind: "closeable-scope" };
  relate("equal", scope, { kind: "closeable-scope" }, EQUAL);
  relate("against unit", scope, UNIT, UNRELATED);
  relate("against unknown", scope, UNKNOWN, UNRELATED);
  assert(fits(ENV, NEVER, scope), "never fits a CloseableScope");
});

// ------------------------------------------------------------ null and unit

Deno.test("null and unit do not fit each other in either direction", () => {
  relate("null against unit", NULL, UNIT, UNRELATED);
  relate(
    "null literal against itself",
    NULL,
    { kind: "literal", value: null },
    EQUAL,
  );
  relate(
    "unit against itself",
    UNIT,
    { kind: "primitive", name: "unit" },
    EQUAL,
  );
  const nullable: Type = { kind: "union", members: [STRING, NULL] };
  assert(fits(ENV, NULL, nullable), "null fits a nullable union");
  assert(!fits(ENV, UNIT, nullable), "unit does not fit a nullable union");
  const optionalUnit: Type = { kind: "union", members: [STRING, UNIT] };
  assert(!fits(ENV, NULL, optionalUnit), "null does not fit a union with unit");
  relate("null against string", NULL, STRING, UNRELATED);
});

// ------------------------------------------------------------------ nominal

Deno.test("a nominal value fits its base, an opaque type does not, and a base value does not fit a nominal type", () => {
  const id: Type = { kind: "named", id: "type:m#Id" };
  const handle: Type = { kind: "named", id: "type:m#Handle" };
  const account: Type = { kind: "named", id: "type:m#Account" };
  const record: Extract<Type, { kind: "record" }> = {
    kind: "record",
    fields: [{ name: "id", type: id, optional: false }],
  };
  const env: TypeEnv = {
    ...ENV,
    brands: new Map<string, Type>([
      ["type:m#Id", STRING],
      ["type:m#Handle", UNKNOWN],
    ]),
    data: new Map([["type:m#Account", record]]),
    opaque: new Set(["type:m#Handle"]),
  };
  assertEquals(fits(env, id, STRING), true);
  assertEquals(fits(env, STRING, id), false);
  assertEquals(fits(env, account, record), true);
  assertEquals(fits(env, record, account), false);
  assertEquals(fits(env, id, { kind: "union", members: [STRING, INT] }), true);
  assertEquals(
    fits(env, { kind: "array", element: id }, {
      kind: "array",
      element: STRING,
    }),
    true,
  );
  assertEquals(
    fits(env, { kind: "ref", element: id }, { kind: "ref", element: STRING }),
    false,
  );
  assertEquals(fits(env, handle, UNKNOWN), false);
});
