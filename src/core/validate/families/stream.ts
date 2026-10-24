// Validation of the Stream builtins: the sources, the element operators, the sinks, the
// groups, the merges, and the Stream runners. The tables of the operator kinds sit here.

import { type Expr, SCOPE_CAPABILITY, type Type } from "../../ir.ts";
import { AREA } from "../report.ts";
import {
  combine,
  invocationOf,
  isQuiet,
  minus,
  QUIET,
  sortedUnique,
  unionEffects,
} from "../sets.ts";
import {
  asFunction,
  BOOLEAN,
  dataOnly,
  fits,
  INT,
  isUnknown,
  members,
  NEVER,
  same,
  unfold,
  unionOf,
  UNIT,
} from "../typing.ts";
import { walkExprs } from "../expr_walk.ts";
import {
  type Comp,
  derivedResult,
  streamState,
  type ValidatorCore,
} from "./context.ts";

/** The Stream operators that run a Stream to one value, with the result type. */
type StreamTerminal = Extract<
  Expr,
  {
    kind: "collect-stream" | "head-stream" | "last-stream" | "drain-stream";
  }
>;

const STREAM_TERMINALS: Record<
  StreamTerminal["kind"],
  { readonly name: string; readonly result: (element: Type) => Type }
> = {
  "collect-stream": {
    name: "collectStream",
    result: (element) => ({ kind: "array", element }),
  },
  "head-stream": {
    name: "headStream",
    result: (element) => ({ kind: "option", element }),
  },
  "last-stream": {
    name: "lastStream",
    result: (element) => ({ kind: "option", element }),
  },
  "drain-stream": { name: "drainStream", result: () => UNIT },
};

/** The Stream operators that flatten a Stream of Streams, with the operator name. */
type StreamFlatten = Extract<
  Expr,
  { kind: "flat-map-streams" | "switch-map-streams" }
>;

const STREAM_FLATTENS: Record<StreamFlatten["kind"], string> = {
  "flat-map-streams": "flatMapStreams",
  "switch-map-streams": "switchMapStreams",
};

/** The Stream operators that map the elements, with the callback rule and the message. */
type StreamMap = Extract<Expr, { kind: "map-effect" | "map-stream" }>;

const STREAM_MAPS: Record<
  StreamMap["kind"],
  {
    readonly name: string;
    /** The callback must be pure. Its effects then stay out of the result. */
    readonly pure: boolean;
    readonly needs: string;
  }
> = {
  "map-effect": {
    name: "mapEffect",
    pure: false,
    needs: "mapEffect needs a Stream and an element callback",
  },
  "map-stream": {
    name: "mapStream",
    pure: true,
    needs: "mapStream needs a Stream and a pure element callback",
  },
};

/** The Stream operators that carry a state through a callback of two arguments. */
type StreamAccumulator = Extract<
  Expr,
  {
    kind:
      | "scan-stream"
      | "map-accum-stream"
      | "fold-stream"
      | "fold-effect-stream";
  }
>;

const STREAM_ACCUMULATORS: Record<
  StreamAccumulator["kind"],
  {
    readonly name: string;
    /** The callback must be pure. Its effects then stay out of the result. */
    readonly pure: boolean;
    /** The operator runs the Stream to the final state instead of returning a Stream. */
    readonly terminal: boolean;
    readonly needs: string;
  }
> = {
  "scan-stream": {
    name: "scanStream",
    pure: true,
    terminal: false,
    needs: "scanStream needs a Stream and a pure state update callback",
  },
  "map-accum-stream": {
    name: "mapAccumStream",
    pure: true,
    terminal: false,
    needs:
      "mapAccumStream needs a Stream and a pure callback returning [State, Output[]]",
  },
  "fold-stream": {
    name: "foldStream",
    pure: true,
    terminal: true,
    needs: "foldStream needs a Stream and a pure state update callback",
  },
  "fold-effect-stream": {
    name: "foldEffectStream",
    pure: false,
    terminal: true,
    needs:
      "foldEffectStream needs a Stream and a compatible state update callback",
  },
};

/** The Stream operators that take a pure Int count, with the operator name. */
type StreamCount = Extract<Expr, { kind: "take-stream" | "drop-stream" }>;

const STREAM_COUNTS: Record<StreamCount["kind"], string> = {
  "take-stream": "takeStream",
  "drop-stream": "dropStream",
};

/** The Stream operators that take a pure boolean predicate, with the operator name. */
type PureStreamPredicate = Extract<
  Expr,
  {
    kind:
      | "drop-while-stream"
      | "filter-stream"
      | "take-while-stream"
      | "take-until-stream";
  }
>;

const PURE_STREAM_PREDICATES: Record<PureStreamPredicate["kind"], string> = {
  "drop-while-stream": "dropWhileStream",
  "filter-stream": "filterStream",
  "take-while-stream": "takeWhileStream",
  "take-until-stream": "takeUntilStream",
};

export function unfoldStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "unfold" }>,
  path: string,
): Comp {
  const seed = c.check(e.seed, `${path}.seed`);
  const next = c.check(e.next, `${path}.next`);
  const fn = asFunction(c.env, next.type);
  if (e.next.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.next`,
      "unfold requires an inline closure",
      e.next.span,
    );
  }
  const state = streamState(c.env, seed.type);
  if (
    fn === undefined || fn.parameters.length !== 1 ||
    !fits(c.env, state, fn.parameters[0])
  ) {
    c.add(
      AREA.types,
      `${path}.next`,
      "unfold needs a callback accepting the state",
      e.next.span,
    );
    return c.poison();
  }
  const option = unfold(c.env, fn.result);
  const pair = option.kind === "option"
    ? unfold(c.env, option.element)
    : undefined;
  if (
    pair?.kind !== "tuple" || pair.elements.length !== 2 ||
    !fits(c.env, pair.elements[1], state)
  ) {
    c.add(
      AREA.types,
      `${path}.next`,
      "unfold callback must return Option<[Element, State]>",
      e.next.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: pair.elements[0],
    effects: fn.effects,
  }, combine([seed, next]));
}

export function mapElements(
  c: ValidatorCore,
  e: StreamMap,
  path: string,
): Comp {
  const row = STREAM_MAPS[e.kind];
  if (e.kind === "map-effect") c.checkConcurrency(e, path, row.name);
  const stream = c.check(e.stream, `${path}.stream`);
  const transform = c.check(e.transform, `${path}.transform`);
  const source = unfold(c.env, stream.type);
  const fn = asFunction(c.env, transform.type);
  if (e.transform.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.transform`,
      `${row.name} requires an inline closure`,
      e.transform.span,
    );
  }
  if (
    source.kind !== "stream" || fn === undefined ||
    fn.parameters.length !== 1 ||
    !fits(c.env, source.element, fn.parameters[0]) ||
    (row.pure && !isQuiet(invocationOf(fn)))
  ) {
    c.add(AREA.types, path, row.needs, e.span);
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: fn.result,
    effects: row.pure
      ? source.effects
      : { ...unionEffects(source.effects, fn.effects) },
  }, combine([stream, transform]));
}

export function accumulateStream(
  c: ValidatorCore,
  e: StreamAccumulator,
  path: string,
): Comp {
  const row = STREAM_ACCUMULATORS[e.kind];
  const stream = c.check(e.stream, `${path}.stream`);
  const seed = c.check(e.seed, `${path}.seed`);
  const update = c.check(e.update, `${path}.update`);
  const source = unfold(c.env, stream.type);
  const fn = asFunction(c.env, update.type);
  if (e.update.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.update`,
      `${row.name} requires an inline closure`,
      e.update.span,
    );
  }
  // mapAccumStream returns [State, Output[]]. The others return the State.
  const pair = e.kind === "map-accum-stream" && fn !== undefined
    ? unfold(c.env, fn.result)
    : undefined;
  const elements = pair?.kind === "tuple" && pair.elements.length === 2
    ? pair.elements
    : undefined;
  const output = elements === undefined
    ? undefined
    : unfold(c.env, elements[1]);
  const state = e.kind === "map-accum-stream" ? elements?.[0] : fn?.result;
  if (
    source.kind !== "stream" || fn === undefined ||
    fn.parameters.length !== 2 ||
    !fits(c.env, seed.type, fn.parameters[0]) ||
    !fits(c.env, source.element, fn.parameters[1]) ||
    state === undefined || !fits(c.env, state, seed.type) ||
    (e.kind === "map-accum-stream" && output?.kind !== "array") ||
    (row.pure && !isQuiet(invocationOf(fn)))
  ) {
    c.add(AREA.types, path, row.needs, e.span);
    return c.poison();
  }
  if (!isQuiet(seed)) {
    c.add(
      AREA.execution,
      `${path}.seed`,
      `${row.name} seed must be pure`,
      e.seed.span,
    );
  }
  if (row.terminal) {
    return derivedResult(
      seed.type,
      combine([stream, seed, update, {
        ...(row.pure
          ? source.effects
          : unionEffects(source.effects, fn.effects)),
        execution: "effect",
      }]),
    );
  }
  return derivedResult({
    kind: "stream",
    element: output?.kind === "array" ? output.element : seed.type,
    effects: source.effects,
  }, combine([stream, seed, update]));
}

export function streamTerminal(
  c: ValidatorCore,
  e: StreamTerminal,
  path: string,
): Comp {
  const row = STREAM_TERMINALS[e.kind];
  const stream = c.check(e.stream, `${path}.stream`);
  const source = unfold(c.env, stream.type);
  if (source.kind !== "stream") {
    c.add(
      AREA.types,
      path,
      `${row.name} needs a Stream value`,
      e.span,
    );
    return c.poison();
  }
  return derivedResult(
    row.result(source.element),
    combine([stream, {
      failures: source.effects.failures,
      requirements: source.effects.requirements,
      execution: "effect",
    }]),
  );
}

export function mapStreams(
  c: ValidatorCore,
  e: StreamFlatten,
  path: string,
): Comp {
  const name = STREAM_FLATTENS[e.kind];
  if (e.kind === "flat-map-streams") c.checkConcurrency(e, path, name);
  const stream = c.check(e.stream, `${path}.stream`);
  const transform = c.check(e.transform, `${path}.transform`);
  const source = unfold(c.env, stream.type);
  const fn = asFunction(c.env, transform.type);
  if (e.transform.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.transform`,
      `${name} requires an inline closure`,
      e.transform.span,
    );
  }
  const inner = fn === undefined ? undefined : unfold(c.env, fn.result);
  if (
    source.kind !== "stream" || fn === undefined ||
    fn.parameters.length !== 1 ||
    !fits(c.env, source.element, fn.parameters[0]) ||
    !isQuiet(invocationOf(fn)) || inner?.kind !== "stream"
  ) {
    c.add(
      AREA.types,
      path,
      `${name} needs a Stream and a pure callback returning a Stream`,
      e.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: inner.element,
    effects: {
      ...unionEffects(source.effects, inner.effects),
    },
  }, combine([stream, transform]));
}

export function catchStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "catch-stream" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const recover = c.check(e.recover, `${path}.recover`);
  const source = unfold(c.env, stream.type);
  const fn = asFunction(c.env, recover.type);
  if (e.recover.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.recover`,
      "catchStream requires an inline closure",
      e.recover.span,
    );
  }
  const replacement = fn === undefined ? undefined : unfold(c.env, fn.result);
  const errors = source.kind === "stream"
    ? unionOf(
      c.env,
      source.effects.failures.map((id) => ({ kind: "named", id })),
    )
    : NEVER;
  if (
    source.kind !== "stream" || fn === undefined ||
    fn.parameters.length !== 1 ||
    !fits(c.env, errors, fn.parameters[0]) ||
    !isQuiet(invocationOf(fn)) || replacement?.kind !== "stream"
  ) {
    c.add(
      AREA.types,
      path,
      "catchStream needs a Stream and a pure error callback returning a Stream",
      e.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: unionOf(c.env, [source.element, replacement.element]),
    effects: {
      failures: replacement.effects.failures,
      requirements: sortedUnique([
        ...source.effects.requirements,
        ...replacement.effects.requirements,
      ]),
    },
  }, combine([stream, recover]));
}

export function retryStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "retry-stream" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const policy = c.check(e.policy, `${path}.policy`);
  const source = unfold(c.env, stream.type);
  const schedule = unfold(c.env, policy.type);
  if (source.kind !== "stream" || schedule.kind !== "retry-schedule") {
    c.add(
      AREA.types,
      path,
      "retryStream needs a Stream and a RetrySchedule",
      e.span,
    );
    return c.poison();
  }
  for (const failure of source.effects.failures) {
    if (!fits(c.env, { kind: "named", id: failure }, schedule.error)) {
      c.add(
        AREA.types,
        `${path}.policy`,
        `retry schedule does not accept ${failure}`,
        e.policy.span,
      );
    }
  }
  if (!isQuiet(policy)) {
    c.add(
      AREA.execution,
      `${path}.policy`,
      "retryStream policy must be pure",
      e.policy.span,
    );
  }
  return derivedResult(source, combine([stream, policy]));
}

export function debounceStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "debounce-stream" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const source = unfold(c.env, stream.type);
  if (source.kind !== "stream") {
    c.add(AREA.types, path, "debounceStream needs a Stream", e.span);
    return c.poison();
  }
  if (!Number.isSafeInteger(e.delayMs) || e.delayMs < 0) {
    c.add(
      AREA.control,
      `${path}.delayMs`,
      "debounceStream delay must be a nonnegative safe integer",
      e.span,
    );
  }
  return derivedResult(source, combine([stream]));
}

export function throttleStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "throttle-stream" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const source = unfold(c.env, stream.type);
  if (source.kind !== "stream") {
    c.add(AREA.types, path, "throttleStream needs a Stream", e.span);
    return c.poison();
  }
  if (
    !Number.isSafeInteger(e.units) || e.units <= 0 ||
    !Number.isSafeInteger(e.durationMs) || e.durationMs <= 0 ||
    (e.strategy !== "shape" && e.strategy !== "enforce")
  ) {
    c.add(
      AREA.control,
      path,
      "throttleStream needs positive units and duration and a known strategy",
      e.span,
    );
  }
  return derivedResult(source, combine([stream]));
}

export function streamCount(
  c: ValidatorCore,
  e: StreamCount,
  path: string,
): Comp {
  const name = STREAM_COUNTS[e.kind];
  const stream = c.check(e.stream, `${path}.stream`);
  const count = c.check(e.count, `${path}.count`);
  const source = unfold(c.env, stream.type);
  if (source.kind !== "stream" || !fits(c.env, count.type, INT)) {
    c.add(
      AREA.types,
      path,
      `${name} needs a Stream value and an Int count`,
      e.span,
    );
    return c.poison();
  }
  if (!isQuiet(count)) {
    c.add(
      AREA.execution,
      `${path}.count`,
      `${name} count must be pure`,
      e.count.span,
    );
  }
  return derivedResult(source, combine([stream, count]));
}

export function pureStreamPredicate(
  c: ValidatorCore,
  e: PureStreamPredicate,
  path: string,
): Comp {
  const name = PURE_STREAM_PREDICATES[e.kind];
  const stream = c.check(e.stream, `${path}.stream`);
  const predicate = c.check(e.predicate, `${path}.predicate`);
  const source = unfold(c.env, stream.type);
  const fn = asFunction(c.env, predicate.type);
  if (e.predicate.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.predicate`,
      `${name} requires an inline closure`,
      e.predicate.span,
    );
  }
  if (
    source.kind !== "stream" || fn === undefined ||
    fn.parameters.length !== 1 ||
    !fits(c.env, source.element, fn.parameters[0]) ||
    !fits(c.env, fn.result, BOOLEAN) ||
    !isQuiet(invocationOf(fn))
  ) {
    c.add(
      AREA.types,
      path,
      `${name} needs a Stream and a pure boolean predicate`,
      e.span,
    );
    return c.poison();
  }
  return derivedResult(source, combine([stream, predicate]));
}

export function effectStreamPredicate(
  c: ValidatorCore,
  e: Extract<
    Expr,
    {
      kind:
        | "filter-effect-stream"
        | "take-while-effect-stream"
        | "take-until-effect-stream"
        | "drop-while-effect-stream";
    }
  >,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const predicate = c.check(e.predicate, `${path}.predicate`);
  const source = unfold(c.env, stream.type);
  const fn = asFunction(c.env, predicate.type);
  if (e.predicate.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.predicate`,
      "effectful stream predicate requires an inline closure",
      e.predicate.span,
    );
  }
  if (
    source.kind !== "stream" || fn === undefined ||
    fn.parameters.length !== 1 ||
    !fits(c.env, source.element, fn.parameters[0]) ||
    !fits(c.env, fn.result, BOOLEAN)
  ) {
    c.add(
      AREA.types,
      path,
      "effectful stream predicate needs a Stream and a boolean callback",
      e.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: source.element,
    effects: {
      ...unionEffects(source.effects, fn.effects),
    },
  }, combine([stream, predicate]));
}

export function sinkForEach(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "sink-for-each" }>,
  path: string,
): Comp {
  const consume = c.check(e.consume, `${path}.consume`);
  const fn = asFunction(c.env, consume.type);
  if (e.consume.kind !== "closure") {
    c.add(
      AREA.control,
      `${path}.consume`,
      "sinkForEach requires an inline closure",
      e.consume.span,
    );
  }
  if (
    fn === undefined || fn.parameters.length !== 1 ||
    !fits(c.env, fn.result, UNIT)
  ) {
    c.add(
      AREA.types,
      path,
      "sinkForEach needs a one-argument void callback",
      e.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "sink",
    input: fn.parameters[0],
    result: UNIT,
    effects: fn.effects,
  }, combine([consume]));
}

export function takeSink(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "take-sink" }>,
  path: string,
): Comp {
  if (!Number.isSafeInteger(e.count) || e.count <= 0) {
    c.add(
      AREA.control,
      path,
      "takeSink needs a positive safe integer count",
      e.span,
    );
  }
  const sink = unfold(c.env, e.type);
  if (sink.kind !== "sink") {
    c.add(AREA.types, path, "takeSink needs a Sink annotation", e.span);
    return c.poison();
  }
  return derivedResult({
    kind: "sink",
    input: sink.input,
    result: { kind: "array", element: sink.input },
    leftover: sink.input,
    effects: { failures: [], requirements: [] },
  }, QUIET);
}

export function mapGroups(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "map-groups" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const key = c.check(e.key, `${path}.key`);
  const use = c.check(e.use, `${path}.use`);
  const source = unfold(c.env, stream.type);
  const classifier = asFunction(c.env, key.type);
  const consumer = asFunction(c.env, use.type);
  if (
    source.kind !== "stream" || e.key.kind !== "closure" ||
    e.use.kind !== "closure" ||
    classifier === undefined || consumer === undefined ||
    classifier.parameters.length !== 1 || consumer.parameters.length !== 2 ||
    e.key.parameters.length !== 1 || e.use.parameters.length !== 2 ||
    e.use.parameters[0]?.id === e.use.parameters[1]?.id
  ) {
    c.add(
      AREA.control,
      path,
      "mapGroups needs a Stream and inline key/use callbacks with the declared group binding",
      e.span,
    );
    return c.poison();
  }
  if (!Number.isSafeInteger(e.bufferSize) || e.bufferSize <= 0) {
    c.add(
      AREA.control,
      path,
      "mapGroups needs a positive safe integer buffer size",
      e.span,
    );
  }
  const group: Type = {
    kind: "stream",
    element: source.element,
    effects: { failures: [], requirements: [] },
  };
  if (
    !fits(c.env, source.element, classifier.parameters[0]) ||
    !fits(c.env, classifier.result, consumer.parameters[0]) ||
    !same(c.env, group, consumer.parameters[1]) ||
    groupKeyClass(c, classifier.result) === undefined ||
    !dataOnly(c.env, consumer.result, "value")
  ) {
    c.add(
      AREA.types,
      path,
      "mapGroups needs a primitive key class, matching borrowed input, and data-only result",
      e.span,
    );
  }
  if (!isQuiet(invocationOf(classifier))) {
    c.add(
      AREA.control,
      path,
      "the group classifier must be pure",
      e.key.span,
    );
  }
  groupReferences(c, e.use.body, e.use.parameters[1].id, `${path}.use.body`);
  return derivedResult({
    kind: "stream",
    element: consumer.result,
    effects: {
      ...unionEffects(source.effects, {
        failures: consumer.effects.failures,
        requirements: minus(consumer.effects.requirements, [
          SCOPE_CAPABILITY,
        ]),
      }),
    },
  }, combine([stream, key, use]));
}

function groupKeyClass(
  c: ValidatorCore,
  type: Type,
  depth = 0,
): string | undefined {
  if (depth > 128) return undefined;
  let found: string | undefined;
  for (const member of members(c.env, type)) {
    let current: string | undefined;
    if (member.kind === "literal") {
      if (member.value === null) return undefined;
      current = typeof member.value === "number"
        ? Number.isSafeInteger(member.value) ? "int" : undefined
        : typeof member.value;
    } else if (member.kind === "primitive") {
      if (
        member.name === "int" || member.name === "string" ||
        member.name === "boolean"
      ) current = member.name;
    } else if (member.kind === "named") {
      const base = c.env.brands.get(member.id);
      if (
        base !== undefined &&
        groupKeyClass(c, base, depth + 1) !== undefined
      ) current = `brand:${member.id}`;
    }
    if (current === undefined || (found !== undefined && found !== current)) {
      return undefined;
    }
    found = current;
  }
  return found;
}

function groupReferences(
  c: ValidatorCore,
  body: Expr,
  id: string,
  path: string,
): void {
  let references = 0;
  walkExprs(body, (expr, parent, _grandparent, nested) => {
    if (expr.kind === "reference" && expr.target === id) {
      references++;
      const terminal = parent?.kind === "collect-stream" ||
        parent?.kind === "run-stream" ||
        parent?.kind === "fold-stream" ||
        parent?.kind === "fold-effect-stream" ||
        parent?.kind === "head-stream" || parent?.kind === "last-stream" ||
        parent?.kind === "drain-stream";
      if (nested || references > 1 || !terminal || parent.stream !== expr) {
        c.add(
          AREA.control,
          path,
          "a borrowed group permits at most one direct terminal use and cannot escape or be captured",
          expr.span,
        );
      }
    }
  });
}

export function transduceStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "transduce-stream" }>,
  path: string,
): Comp {
  return sinkTransformStream(c, e, path, "transduceStream");
}

export function aggregateStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "aggregate-stream" }>,
  path: string,
): Comp {
  return sinkTransformStream(c, e, path, "aggregateStream");
}

export function aggregateWithinStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "aggregate-within-stream" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const sink = c.check(e.sink, `${path}.sink`);
  const schedule = c.check(e.schedule, `${path}.schedule`);
  const source = unfold(c.env, stream.type);
  const consumer = unfold(c.env, sink.type);
  const policy = unfold(c.env, schedule.type);
  const unknownInput = policy.kind === "schedule" &&
    isUnknown(c.env, policy.input);
  if (
    source.kind !== "stream" || consumer.kind !== "sink" ||
    policy.kind !== "schedule" ||
    !fits(c.env, source.element, consumer.input) ||
    !fits(c.env, consumer.leftover ?? NEVER, consumer.input) ||
    !(unknownInput ||
      fits(
        c.env,
        { kind: "option", element: consumer.result },
        policy.input,
      ))
  ) {
    c.add(
      AREA.types,
      path,
      "aggregateWithinStream needs compatible Stream, Sink, and Schedule inputs",
      e.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: consumer.result,
    effects: {
      ...unionEffects(source.effects, consumer.effects, policy.effects),
    },
  }, combine([stream, sink, schedule]));
}

function sinkTransformStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "transduce-stream" | "aggregate-stream" }>,
  path: string,
  name: "transduceStream" | "aggregateStream",
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const sink = c.check(e.sink, `${path}.sink`);
  const source = unfold(c.env, stream.type);
  const consumer = unfold(c.env, sink.type);
  if (
    source.kind !== "stream" || consumer.kind !== "sink" ||
    !fits(c.env, source.element, consumer.input) ||
    !fits(c.env, consumer.leftover ?? NEVER, consumer.input)
  ) {
    c.add(
      AREA.types,
      path,
      `${name} needs compatible input and replayable Sink leftovers`,
      e.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: consumer.result,
    effects: {
      ...unionEffects(source.effects, consumer.effects),
    },
  }, combine([stream, sink]));
}

export function runStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "run-stream" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const sink = c.check(e.sink, `${path}.sink`);
  const source = unfold(c.env, stream.type);
  const consumer = unfold(c.env, sink.type);
  if (
    source.kind !== "stream" || consumer.kind !== "sink" ||
    !fits(c.env, source.element, consumer.input)
  ) {
    c.add(
      AREA.types,
      path,
      "runStream needs compatible Stream and Sink values",
      e.span,
    );
    return c.poison();
  }
  return derivedResult(
    consumer.result,
    combine([stream, sink, {
      ...unionEffects(source.effects, consumer.effects),
      execution: "effect",
    }]),
  );
}

export function bufferStream(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "buffer-stream" }>,
  path: string,
): Comp {
  const stream = c.check(e.stream, `${path}.stream`);
  const source = unfold(c.env, stream.type);
  if (source.kind !== "stream") {
    c.add(AREA.types, path, "bufferStream needs a Stream value", e.span);
    return c.poison();
  }
  if (!Number.isSafeInteger(e.capacity) || e.capacity <= 0) {
    c.add(
      AREA.control,
      path,
      "bufferStream capacity must be a positive safe integer",
      e.span,
    );
  }
  return derivedResult(source, combine([stream]));
}

export function mergeStreams(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "merge-streams" }>,
  path: string,
): Comp {
  const left = c.check(e.left, `${path}.left`);
  const right = c.check(e.right, `${path}.right`);
  const a = unfold(c.env, left.type);
  const b = unfold(c.env, right.type);
  if (a.kind !== "stream" || b.kind !== "stream") {
    c.add(
      AREA.types,
      path,
      "mergeStreams needs two Stream values",
      e.span,
    );
    return c.poison();
  }
  const aFitsB = fits(c.env, a.element, b.element);
  const bFitsA = fits(c.env, b.element, a.element);
  if (!aFitsB && !bFitsA) {
    c.add(
      AREA.types,
      path,
      "mergeStreams needs compatible element types",
      e.span,
    );
  }
  return derivedResult({
    kind: "stream",
    element: aFitsB ? b.element : a.element,
    effects: {
      ...unionEffects(a.effects, b.effects),
    },
  }, combine([left, right]));
}

export function zipStreams(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "zip-streams" }>,
  path: string,
): Comp {
  const left = c.check(e.left, `${path}.left`);
  const right = c.check(e.right, `${path}.right`);
  const a = unfold(c.env, left.type);
  const b = unfold(c.env, right.type);
  if (a.kind !== "stream" || b.kind !== "stream") {
    c.add(AREA.types, path, "zipStreams needs two Stream values", e.span);
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: { kind: "tuple", elements: [a.element, b.element] },
    effects: {
      ...unionEffects(a.effects, b.effects),
    },
  }, combine([left, right]));
}

export function concatStreams(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "concat-streams" }>,
  path: string,
): Comp {
  const left = c.check(e.left, `${path}.left`);
  const right = c.check(e.right, `${path}.right`);
  const a = unfold(c.env, left.type);
  const b = unfold(c.env, right.type);
  if (a.kind !== "stream" || b.kind !== "stream") {
    c.add(
      AREA.types,
      path,
      "concatStreams needs two Stream values",
      e.span,
    );
    return c.poison();
  }
  return derivedResult({
    kind: "stream",
    element: unionOf(c.env, [a.element, b.element]),
    effects: {
      ...unionEffects(a.effects, b.effects),
    },
  }, combine([left, right]));
}
