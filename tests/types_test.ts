// Tests for the type intern table and the compatibility rules.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
} from "@std/assert";
import type { ErrorId, Type, TypeId } from "../src/core/ir.ts";
import { canonicalJson, type TypeRef, TypeTable } from "../src/core/types.ts";

const USER = "type:m#User" as TypeId;
const ID_A = "type:m#IdA" as TypeId;
const ID_B = "type:m#IdB" as TypeId;
const MISSING = "error:m#Missing" as ErrorId;
const OTHER_FAIL = "error:m#Other" as ErrorId;

function fresh(): TypeTable {
  return new TypeTable();
}

Deno.test("redefining a type replaces alias, brand, opaque and recursive metadata", () => {
  const t = fresh();
  const named = t.named(USER);
  t.defineAlias(USER, t.int);
  assert(t.isAssignable(t.int, named));
  t.defineBrand(USER, t.int);
  assert(!t.isAssignable(t.int, named));
  assertEquals(t.unfold(named), named);
  t.markOpaque(USER);
  t.defineBrand(USER, t.string);
  assert(!t.isOpaque(USER));
  assertEquals(t.brandBaseOf(USER), t.string);
  t.defineAlias(USER, t.int);
  assertEquals(t.brandBaseOf(USER), undefined);
  assert(t.isAssignable(t.int, named));

  t.markGuardedAlias(USER);
  t.defineAlias(USER, t.array(t.int));
  assert(t.exceedsDepth(named, 2, new Map()));
  t.markGuardedAlias(USER);
  t.markOpaque(USER);
  t.defineBrand(USER, t.int);
  assert(!t.isOpaque(USER));
  assertEquals(t.aliasOf(USER), undefined);
});

Deno.test("CloseableScope is an abstract leaf through aliases and IR conversion", () => {
  const t = fresh();
  const owner = t.fromIr({ kind: "closeable-scope" });
  assertEquals(owner, t.closeableScope);
  assertEquals(t.show(owner), "CloseableScope");
  assertEquals(t.toIr(owner), { kind: "closeable-scope" });
  t.defineAlias(USER, owner);
  assert(t.isAssignable(t.named(USER), owner));
  assert(t.isAssignable(owner, t.named(USER)));
  assert(!t.isAssignable(t.record([]), owner));
  assert(!t.isAssignable(owner, t.record([])));
});

function field(name: string, type: TypeRef, optional = false) {
  return { name, type, optional };
}

function pureFn(
  t: TypeTable,
  parameters: TypeRef[],
  result: TypeRef,
) {
  return t.function({
    execution: "pure",
    parameters,
    result,
    failures: [],
    requirements: [],
  });
}

function effectFn(
  t: TypeTable,
  parameters: TypeRef[],
  result: TypeRef,
  failures: ErrorId[] = [],
) {
  return t.function({
    execution: "effect",
    parameters,
    result,
    failures,
    requirements: [],
  });
}

// ------------------------------------------------------------------ interning

Deno.test("Sink leftovers are covariant and preserve legacy IR defaults", () => {
  const t = fresh();
  const legacy: Type = {
    kind: "sink",
    input: { kind: "primitive", name: "int" },
    result: { kind: "primitive", name: "unit" },
    effects: { failures: [], requirements: [] },
  };
  const omitted = t.fromIr(legacy);
  const explicit = t.fromIr({
    ...legacy,
    leftover: { kind: "primitive", name: "never" },
  });
  assertEquals(omitted, explicit);
  assertEquals(t.toIr(explicit), legacy);
  const narrow = t.sink(t.number, t.unit, [], [], t.int);
  const broad = t.sink(t.int, t.unit, [], [], t.number);
  assert(t.isAssignable(narrow, broad));
  assert(!t.isAssignable(broad, narrow));
  assert(t.isAssignable(omitted, broad));
  assert(!t.isAssignable(broad, omitted));
  assertEquals(t.fromIr(t.toIr(narrow)), narrow);
  assertEquals(t.show(narrow), "Sink<number, void, never, never, int>");
  const nested = t.sink(t.int, t.unit, [], [], t.array(t.array(t.int)));
  assert(t.exceedsDepth(nested, 3, new Map()));
});

Deno.test("equal structural types share one id", () => {
  const t = fresh();
  assertStrictEquals(t.array(t.int), t.array(t.int));
  assertNotEquals(t.array(t.int), t.array(t.number));
  assertStrictEquals(t.option(t.string), t.option(t.string));
  assertStrictEquals(t.tuple([t.int, t.string]), t.tuple([t.int, t.string]));
  assertNotEquals(t.tuple([t.int, t.string]), t.tuple([t.string, t.int]));
  assertStrictEquals(t.literal("a"), t.literal("a"));
  assertNotEquals(t.literal("1"), t.literal(1));
  assertStrictEquals(t.named(USER), t.named(USER));
  assertStrictEquals(t.primitive("int"), t.int);
});

Deno.test("records sort by field name, so field order does not matter", () => {
  const t = fresh();
  const a = t.record([field("b", t.int), field("a", t.string)]);
  const b = t.record([field("a", t.string), field("b", t.int)]);
  assertEquals(a, b);
  const node = t.node(a);
  assert(node.kind === "record");
  assertEquals(node.fields.map((f) => f.name), ["a", "b"]);
  const optional = t.record([
    field("a", t.string, true),
    field("b", t.int),
  ]);
  assertNotEquals(a, optional);
});

Deno.test("unions flatten, deduplicate, and sort; a one-member union is the member", () => {
  const t = fresh();
  const ab = t.union([t.literal("a"), t.literal("b")]);
  const ba = t.union([t.literal("b"), t.literal("a"), t.literal("b")]);
  assertEquals(ab, ba);
  const nested = t.union([t.union([t.literal("a")]), t.literal("b")]);
  assertEquals(nested, ab);
  const withThird = t.union([ab, t.literal("c")]);
  const node = t.node(withThird);
  assert(node.kind === "union");
  assertEquals(node.members.length, 3);
  assertEquals([...node.members], [...node.members].sort((x, y) => x - y));
  assertEquals(t.union([t.int]), t.int);
  assertEquals(t.union([t.int, t.int]), t.int);
  assertEquals(t.union([]), t.never);
});

Deno.test("a union with the error type is the error type", () => {
  const t = fresh();
  assertEquals(t.union([t.int, t.error]), t.error);
});

Deno.test("function types sort and deduplicate their sets", () => {
  const t = fresh();
  const a = t.function({
    execution: "effect",
    parameters: [t.int],
    result: t.string,
    failures: [OTHER_FAIL, MISSING, MISSING],
    requirements: ["cap:m#S.b", "cap:m#S.a"],
  });
  const b = t.function({
    execution: "effect",
    parameters: [t.int],
    result: t.string,
    failures: [MISSING, OTHER_FAIL],
    requirements: ["cap:m#S.a", "cap:m#S.b"],
  });
  assertEquals(a, b);
  const node = t.node(a);
  assert(node.kind === "function");
  assertEquals(node.failures, [MISSING, OTHER_FAIL]);
  assertEquals(node.requirements, ["cap:m#S.a", "cap:m#S.b"]);
  const pure = t.function({
    execution: "pure",
    parameters: [t.int],
    result: t.string,
    failures: [],
    requirements: [],
  });
  assertNotEquals(pure, effectFn(t, [t.int], t.string));
});

Deno.test("provider types sort what they provide", () => {
  const t = fresh();
  const a = t.provider({
    provides: ["cap:m#S.b", "cap:m#S.a"],
    execution: "effect",
    failures: [],
    requirements: [],
  });
  const b = t.provider({
    provides: ["cap:m#S.a", "cap:m#S.b"],
    execution: "effect",
    failures: [],
    requirements: [],
  });
  assertEquals(a, b);
});

// ------------------------------------------------------------------ IR conversion

Deno.test("fromIr and toIr round trip, and equal IR gives an equal ref", () => {
  const t = fresh();
  const ir: Type = {
    kind: "function",
    execution: "effect",
    parameters: [
      { kind: "array", element: { kind: "named", id: USER } },
      { kind: "option", element: { kind: "primitive", name: "int" } },
    ],
    result: {
      kind: "union",
      members: [
        { kind: "literal", value: "paid" },
        { kind: "literal", value: "pending" },
      ],
    },
    effects: { failures: [MISSING], requirements: ["cap:m#S.find"] },
  };
  const ref = t.fromIr(ir);
  assertEquals(canonicalJson(t.toIr(ref)), canonicalJson(ir));
  assertEquals(t.fromIr(t.toIr(ref)), ref);
});

Deno.test("toIr sorts union members by text, not by ref number", () => {
  const first = fresh();
  first.literal("zzz");
  const a = first.union([first.literal("b"), first.literal("a")]);
  const second = fresh();
  second.literal("a");
  const b = second.union([second.literal("b"), second.literal("a")]);
  assertEquals(
    canonicalJson(first.toIr(a)),
    canonicalJson(second.toIr(b)),
  );
});

Deno.test("the error type becomes unknown in IR", () => {
  const t = fresh();
  assertEquals(t.toIr(t.error), { kind: "primitive", name: "unknown" });
});

Deno.test("canonicalJson sorts object keys and keeps array order", () => {
  assertEquals(
    canonicalJson({ b: 1, a: [3, { z: 1, y: 2 }], c: undefined }),
    '{"a":[3,{"y":2,"z":1}],"b":1}',
  );
  assertEquals(canonicalJson(null), "null");
  assertEquals(canonicalJson("x"), '"x"');
});

// ------------------------------------------------------------------ compatibility

Deno.test("never fits every type, and the error type fits both ways", () => {
  const t = fresh();
  for (const target of [t.int, t.string, t.array(t.int), t.named(USER)]) {
    assert(t.isAssignable(t.never, target));
    assert(t.isAssignable(t.error, target));
    assert(t.isAssignable(target, t.error));
  }
  assert(!t.isAssignable(t.int, t.never));
});

Deno.test("int fits number, and number does not fit int", () => {
  const t = fresh();
  assert(t.isAssignable(t.int, t.number));
  assert(!t.isAssignable(t.number, t.int));
  assert(!t.isAssignable(t.int, t.string));
  assert(!t.isAssignable(t.boolean, t.int));
});

Deno.test("unknown is not a top type", () => {
  const t = fresh();
  assert(!t.isAssignable(t.int, t.unknown));
  assert(!t.isAssignable(t.unknown, t.int));
  assert(t.isAssignable(t.unknown, t.unknown));
});

Deno.test("a literal fits its primitive and a union that holds it", () => {
  const t = fresh();
  assert(t.isAssignable(t.literal("a"), t.string));
  assert(!t.isAssignable(t.literal("a"), t.int));
  assert(t.isAssignable(t.literal(true), t.boolean));
  assert(t.isAssignable(t.literal(3), t.number));
  assert(t.isAssignable(t.literal(3), t.int));
  assert(!t.isAssignable(t.literal(1.5), t.int));
  assert(!t.isAssignable(t.string, t.literal("a")));
  const status = t.union([t.literal("pending"), t.literal("paid")]);
  assert(t.isAssignable(t.literal("paid"), status));
  assert(!t.isAssignable(t.literal("late"), status));
  assert(!t.isAssignable(t.string, status));
});

Deno.test("a union source needs every member to fit; a union target needs one member", () => {
  const t = fresh();
  const small = t.union([t.literal("a"), t.literal("b")]);
  const large = t.union([t.literal("a"), t.literal("b"), t.literal("c")]);
  assert(t.isAssignable(small, large));
  assert(!t.isAssignable(large, small));
  assert(t.isAssignable(small, t.string));
  assert(
    t.isAssignable(t.union([t.int, t.string]), t.union([t.number, t.string])),
  );
  assert(!t.isAssignable(t.union([t.int, t.boolean]), t.string));
});

Deno.test("records need the same field names, optional flags, and compatible field types", () => {
  const t = fresh();
  const base = t.record([field("a", t.int), field("b", t.string)]);
  const wide = t.record([
    field("a", t.int),
    field("b", t.string),
    field("c", t.int),
  ]);
  assert(!t.isAssignable(wide, base), "no width subtyping");
  assert(!t.isAssignable(base, wide));
  const optional = t.record([
    field("a", t.int, true),
    field("b", t.string),
  ]);
  assert(!t.isAssignable(optional, base));
  assert(!t.isAssignable(base, optional));
  const renamed = t.record([field("a", t.int), field("x", t.string)]);
  assert(!t.isAssignable(renamed, base));
  const narrowFields = t.record([
    field("a", t.int),
    field("b", t.literal("x")),
  ]);
  assert(t.isAssignable(narrowFields, base));
  assert(!t.isAssignable(base, narrowFields));
  const wider = t.record([field("a", t.number), field("b", t.string)]);
  assert(t.isAssignable(base, wider));
  assert(!t.isAssignable(wider, base));
});

Deno.test("arrays, options, and tuples are covariant", () => {
  const t = fresh();
  assert(t.isAssignable(t.array(t.int), t.array(t.number)));
  assert(!t.isAssignable(t.array(t.number), t.array(t.int)));
  assert(t.isAssignable(t.option(t.int), t.option(t.number)));
  assert(t.isAssignable(t.option(t.never), t.option(t.string)));
  assert(!t.isAssignable(t.option(t.string), t.array(t.string)));
  assert(
    t.isAssignable(t.tuple([t.int, t.string]), t.tuple([t.number, t.string])),
  );
  assert(!t.isAssignable(t.tuple([t.int]), t.tuple([t.int, t.int])));
  assert(!t.isAssignable(t.tuple([t.number]), t.tuple([t.int])));
});

Deno.test("function parameters are contravariant and the result is covariant", () => {
  const t = fresh();
  const takesNumber = pureFn(t, [t.number], t.int);
  const takesInt = pureFn(t, [t.int], t.number);
  // (number) => int can stand in for (int) => number.
  assert(t.isAssignable(takesNumber, takesInt));
  assert(!t.isAssignable(takesInt, takesNumber));
  assert(
    !t.isAssignable(
      pureFn(t, [t.int], t.int),
      pureFn(t, [t.int, t.int], t.int),
    ),
  );
});

Deno.test("function effects: failures and requirements must be a subset of the target", () => {
  const t = fresh();
  const narrow = effectFn(t, [t.int], t.int, [MISSING]);
  const wide = effectFn(t, [t.int], t.int, [MISSING, OTHER_FAIL]);
  assert(t.isAssignable(narrow, wide));
  assert(!t.isAssignable(wide, narrow));
  const needs = t.function({
    execution: "effect",
    parameters: [],
    result: t.int,
    failures: [],
    requirements: ["cap:m#S.a"],
  });
  const noNeeds = effectFn(t, [], t.int);
  assert(t.isAssignable(noNeeds, needs));
  assert(!t.isAssignable(needs, noNeeds));
});

Deno.test("a pure function fits an effect target, and an effect function does not fit a pure target", () => {
  const t = fresh();
  const pure = pureFn(t, [t.int], t.int);
  const effect = effectFn(t, [t.int], t.int);
  assert(t.isAssignable(pure, effect));
  assert(!t.isAssignable(effect, pure));
  assert(t.isAssignable(pure, pure));
});

Deno.test("aliases unfold, so equal structures under different names are compatible", () => {
  const t = fresh();
  const record = t.record([field("a", t.int)]);
  t.defineAlias(USER, record);
  const other = "type:m#Other" as TypeId;
  t.defineAlias(other, record);
  assert(t.isAssignable(t.named(USER), t.named(other)));
  assert(t.isAssignable(record, t.named(USER)));
  assert(t.isAssignable(t.named(USER), record));
  assert(t.isAssignable(t.array(t.named(USER)), t.array(record)));
  assertEquals(t.unfold(t.named(USER)), record);
  const status = "type:m#Status" as TypeId;
  t.defineAlias(status, t.union([t.literal("a"), t.literal("b")]));
  assert(t.isAssignable(t.literal("a"), t.named(status)));
  assert(!t.isAssignable(t.string, t.named(status)));
});

Deno.test("an alias cycle that is left in the table ends with the error type", () => {
  const t = fresh();
  const a = "type:m#A" as TypeId;
  const b = "type:m#B" as TypeId;
  t.defineAlias(a, t.named(b));
  t.defineAlias(b, t.named(a));
  assertEquals(t.unfold(t.named(a)), t.error);
});

Deno.test("brands are nominal: a brand fits itself and its base, never another brand or the base to it", () => {
  const t = fresh();
  t.defineBrand(ID_A, t.string);
  t.defineBrand(ID_B, t.string);
  const a = t.named(ID_A);
  const b = t.named(ID_B);
  assert(t.isAssignable(a, a));
  assert(!t.isAssignable(a, b));
  assert(t.isAssignable(a, t.string));
  assert(!t.isAssignable(t.string, a));
  assert(t.isAssignable(t.array(a), t.array(a)));
  assert(!t.isAssignable(t.array(a), t.array(b)));
  assert(t.isAssignable(t.array(a), t.array(t.string)));
  assert(!t.isAssignable(t.array(t.string), t.array(a)));
  assert(t.isAssignable(t.option(a), t.option(t.string)));
  assert(t.isAssignable(a, t.union([a, t.int])));
  assert(t.isAssignable(a, t.union([t.string, t.int])));
  assert(!t.isAssignable(a, t.union([b, t.int])));
});

function identity(t: TypeTable, id: TypeId, body: TypeRef): TypeRef {
  t.defineAlias(id, body);
  t.markIdentity(id);
  return t.named(id);
}

Deno.test("an alias with identity fits its body, takes unnamed values, and never mixes with another identity", () => {
  const t = fresh();
  const a = identity(t, ID_A, t.int);
  const b = identity(t, ID_B, t.int);
  const number = identity(t, USER, t.number);
  assert(t.isIdentity(ID_A));
  assertEquals(t.brandBaseOf(ID_A), t.int);
  assertEquals(t.unfoldTransparent(a), a);
  assertEquals(t.unfold(a), t.int);
  assert(t.isAssignable(a, t.int));
  assert(t.isAssignable(t.int, a));
  assert(t.isAssignable(t.literal(5), a));
  assert(!t.isAssignable(t.string, a));
  // Two different identities never mix, with equal bodies, or int into number.
  assert(!t.isAssignable(a, b));
  assert(!t.isAssignable(a, number));
  // A widened value takes no other name at that level.
  assert(t.isAssignable(t.array(a), t.array(t.int)));
  assert(t.isAssignable(t.array(t.int), t.array(a)));
  assert(!t.isAssignable(t.array(a), t.array(b)));
  // Ref, Codec, and Schema positions fit in both directions.
  assert(t.isAssignable(t.ref(t.int), t.ref(a)));
  assert(t.isAssignable(t.ref(a), t.ref(t.int)));
  assert(!t.isAssignable(t.ref(a), t.ref(b)));
});

Deno.test("a body that is a name chains widening, and a sealed identity keeps its module", () => {
  const t = fresh();
  const text = identity(t, ID_B, t.string);
  const id = identity(t, ID_A, text);
  assert(t.isAssignable(id, text));
  assert(!t.isAssignable(text, id));
  t.markSealed(ID_A);
  assert(t.isSealed(ID_A));
  // A foreign module cannot widen the identity or give it an unnamed value.
  assert(!t.isAssignableIn("other", id, text));
  assert(!t.isAssignableIn("other", t.literal("x"), id));
  assert(t.isAssignableIn("m", id, text));
  assert(t.isAssignableIn("m", t.literal("x"), id));
  // `defineAlias` clears the flag, and `markSealed` needs an identity.
  t.defineAlias(ID_A, t.string);
  t.markSealed(ID_A);
  assert(!t.isSealed(ID_A));
});

Deno.test("two ids with one short name show as module#Name", () => {
  const t = fresh();
  const a = identity(t, "type:a#Text" as TypeId, t.string);
  const b = identity(t, "type:b#Text" as TypeId, t.string);
  assertEquals(t.showAll(a, b), ["a#Text", "b#Text"]);
  assertEquals(t.showAll(a, a), ["Text", "Text"]);
  assertEquals(t.showAll(t.array(a), t.int), ["Text[]", "int"]);
  assertEquals(t.show(a), "Text");
});

Deno.test("a data type widens to its record, and the record does not fit back", () => {
  const t = fresh();
  const record = t.record([field("id", t.string)]);
  const a = identity(t, ID_A, record);
  identity(t, ID_B, record);
  t.markTagged(ID_A);
  t.markTagged(ID_B);
  assert(t.isAssignable(a, record));
  assert(!t.isAssignable(record, a));
  assert(!t.isAssignable(a, t.named(ID_B)));
  assert(t.isAssignable(t.array(a), t.array(record)));
});

Deno.test("widening leaves invariant positions and parameters as they are", () => {
  const t = fresh();
  t.defineBrand(ID_A, t.string);
  const a = t.named(ID_A);
  assert(!t.isAssignable(t.ref(a), t.ref(t.string)));
  assert(!t.isAssignable(t.ref(t.string), t.ref(a)));
  assert(!t.isAssignable(t.codec(a, t.string), t.codec(t.string, t.string)));
  const fn = (parameter: TypeRef, result: TypeRef) =>
    pureFn(t, [parameter], result);
  assert(t.isAssignable(fn(t.string, t.string), fn(a, t.string)));
  assert(!t.isAssignable(fn(a, t.string), fn(t.string, t.string)));
  assert(t.isAssignable(fn(t.string, a), fn(t.string, t.string)));
});

Deno.test("an opaque type and an error do not widen", () => {
  const t = fresh();
  t.defineBrand(ID_A, t.unknown);
  t.markOpaque(ID_A);
  t.defineBrand(ID_B, t.unknown);
  assert(!t.isAssignable(t.named(ID_A), t.unknown));
  assert(t.isAssignable(t.named(ID_B), t.unknown));
});

Deno.test("errors are nominal: two errors with equal fields are different", () => {
  const t = fresh();
  const record = t.record([field("id", t.string)]);
  t.defineError(MISSING, record);
  t.defineError(OTHER_FAIL, record);
  assert(t.isAssignable(t.named(MISSING), t.named(MISSING)));
  assert(!t.isAssignable(t.named(MISSING), t.named(OTHER_FAIL)));
  assert(!t.isAssignable(t.named(MISSING), record));
  assert(!t.isAssignable(record, t.named(MISSING)));
});

Deno.test("providers fit a provider with the same provision and no larger acquisition", () => {
  const t = fresh();
  const make = (failures: ErrorId[]) =>
    t.provider({
      provides: ["cap:m#S.a"],
      execution: "effect",
      failures,
      requirements: [],
    });
  assert(t.isAssignable(make([]), make([MISSING])));
  assert(!t.isAssignable(make([MISSING]), make([])));
  assert(!t.isAssignable(make([]), pureFn(t, [], t.int)));
});

Deno.test("show prints readable names", () => {
  const t = fresh();
  assertEquals(t.show(t.unit), "void");
  assertEquals(
    t.show(t.array(t.union([t.int, t.string]))).includes("[]"),
    true,
  );
  assertEquals(t.show(t.option(t.named(USER))), "Option<User>");
  assertEquals(
    t.show(effectFn(t, [t.int], t.string, [MISSING])),
    "(int) => string fails Missing",
  );
});

Deno.test("a pure function lifts to an effect function only at the top of a value", () => {
  const t = fresh();
  const pure = pureFn(t, [t.int], t.int);
  const effect = effectFn(t, [t.int], t.int);
  assert(t.isAssignable(pure, effect));
  assert(!t.isAssignable(pure, t.union([effect, t.string])));
  // Nested positions cannot be wrapped by the emitter.
  assert(
    !t.isAssignable(
      t.record([field("f", pure)]),
      t.record([field("f", effect)]),
    ),
  );
  assert(!t.isAssignable(t.array(pure), t.array(effect)));
  assert(!t.isAssignable(t.option(pure), t.option(effect)));
  assert(!t.isAssignable(pureFn(t, [], pure), pureFn(t, [], effect)));
  // A parameter that expects a pure callback cannot receive an effect one.
  assert(!t.isAssignable(pureFn(t, [pure], t.int), pureFn(t, [effect], t.int)));
  // Equal execution still works when nested.
  assert(t.isAssignable(t.array(effect), t.array(effect)));
});
