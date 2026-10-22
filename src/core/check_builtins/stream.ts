// Stream and Sink construction, callbacks, execution and group lifetimes.
import { type LocalId, type Result, SCOPE_CAPABILITY } from "../ir.ts";
import { isErrorId } from "../ids.ts";
import { flattenMembers } from "../patterns.ts";
import { kindOf, type NodeId, SyntaxKind } from "../syntax.ts";
import { isPatternKind, isTypeKind, literalOf } from "../syntax_queries.ts";
import {
  combine,
  EFFECT_ONLY,
  type NodeInfo,
  PURE_EFFECTS,
  without,
} from "../tables.ts";
import { dataOnly, type TypeNode, type TypeRef } from "../types.ts";
import type {
  Arg,
  BuiltinContext,
  ConcurrencyOperation,
  FactView,
  FactWriter,
  LiteralField,
  LocalUseView,
  ResolveView,
  SyntaxView,
} from "./context.ts";
import {
  direct,
  optionalLast,
  type PreludeCallName,
  type Rows,
} from "./rows.ts";
export interface StreamContext
  extends
    BuiltinContext,
    SyntaxView,
    ResolveView,
    FactView,
    FactWriter,
    LocalUseView {
  literalRecord(
    arg: Arg,
    count: number,
  ): Result<ReadonlyMap<string, LiteralField>, "shape">;
  concurrencyBound(
    arg: Arg,
    name: Extract<ConcurrencyOperation, "mapEffect" | "flatMapStreams">,
  ): number | "unbounded" | undefined;
  noPipeline(name: string, args: readonly Arg[]): void;
}

/** Pure and effect specializations, also used by dispatch during recovery. */
export const STREAM_PREDICATE_FACTS = {
  filterEffectStream: { pure: "filter-stream", effect: "filter-effect-stream" },
  takeWhileEffectStream: {
    pure: "take-while-stream",
    effect: "take-while-effect-stream",
  },
  takeUntilEffectStream: {
    pure: "take-until-stream",
    effect: "take-until-effect-stream",
  },
  dropWhileEffectStream: {
    pure: "drop-while-stream",
    effect: "drop-while-effect-stream",
  },
} as const;

/** True when a checked value has no invocation effects. */
function isPureInfo(info: NodeInfo): boolean {
  return info.mode === "pure" && info.failures.length === 0 &&
    info.requirements.length === 0;
}

export function unfoldCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("unfold", args[1]);
  const seed = c.argInfo(args[0]);
  const state = c.widen(seed.type);
  const next = c.callback("unfold", args[1], [state], undefined, true);
  const fn = c.functionOf(next.info.type);
  const option = c.table.node(c.table.unfold(next.result));
  const pair = option.kind === "option"
    ? c.table.node(c.table.unfold(option.element))
    : undefined;
  let element = c.table.error;
  if (pair?.kind !== "tuple" || pair.elements.length !== 2) {
    if (!c.isError(next.result)) {
      c.report(
        "type-mismatch/010",
        "`unfold` callback must return Option<[Element, State]>",
        args[1].node,
      );
    }
  } else {
    element = pair.elements[0];
    c.fits(args[1].node, pair.elements[1], state, "the next stream state");
  }
  const type = c.table.stream(
    element,
    fn?.failures ?? [],
    fn?.requirements ?? [],
  );
  return c.finish(node, type, combine([seed, next.info]));
}

export function mapEffectCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const concurrency = args[2] === undefined
    ? undefined
    : c.concurrencyBound(args[2], "mapEffect");
  c.noPipeline("mapEffect", args);
  c.inlineStreamCallback("mapEffect", args[1]);
  const { info: stream, source, element } = streamArg(c, "mapEffect", args[0]);
  const transform = c.callback(
    "mapEffect",
    args[1],
    [element],
    undefined,
    true,
  );
  const fn = c.functionOf(transform.info.type);
  // Only a pure callback without options compiles to the pure operation.
  c.fact(
    node,
    args[2] === undefined && fn !== undefined && fn.execution === "pure" &&
      fn.failures.length === 0 && fn.requirements.length === 0
      ? { kind: "map-stream" }
      : { kind: "map-effect", concurrency },
  );
  const type = c.table.stream(transform.result, [
    ...(source.kind === "stream" ? source.failures : []),
    ...(fn?.failures ?? []),
  ], [
    ...(source.kind === "stream" ? source.requirements : []),
    ...(fn?.requirements ?? []),
  ]);
  return c.finish(
    node,
    type,
    combine([
      stream,
      transform.info,
      ...(args[2] === undefined ? [] : [c.argInfo(args[2])]),
    ]),
  );
}

export function mapGroupsCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("mapGroups", args[1]);
  c.inlineStreamCallback("mapGroups", args[2]);
  const bufferSize = streamBufferCapacity(
    c,
    args[3],
    "mapGroups",
    "bufferSize",
  );
  c.fact(node, { kind: "map-groups", bufferSize });
  const { info: stream, source, element } = streamArg(c, "mapGroups", args[0]);
  const key = c.callback("mapGroups key", args[1], [element], undefined);
  if (groupKeyClass(c, key.result) === undefined && !c.isError(key.result)) {
    c.report(
      "type-mismatch/010",
      "`mapGroups` keys must share one string, boolean, int, or primitive brand class",
      args[1].node,
    );
  }
  const group = c.table.stream(element, [], []);
  const use = c.callback(
    "mapGroups use",
    args[2],
    [key.result, group],
    undefined,
    true,
  );
  const fn = c.functionOf(use.info.type);
  // A wider annotated parameter must not erase the special borrowed Stream.
  if (
    fn !== undefined && fn.parameters[1] !== undefined &&
    (!c.table.isAssignable(fn.parameters[1], group) ||
      !c.table.isAssignable(group, fn.parameters[1]))
  ) {
    c.report(
      "type-mismatch/010",
      "the group parameter must have exactly the supplied Stream type",
      args[2].node,
    );
  }
  if (!dataOnly(c.table, use.result, "value")) {
    c.report(
      "type-mismatch/010",
      "the group use result must be data only",
      args[2].node,
    );
  }
  const fact = c.facts.get(args[2].node);
  if (fact?.kind === "arrow" && fact.parameters[1]?.id !== undefined) {
    const body = c.kids(args[2].node).at(-1);
    if (body !== undefined) {
      groupUses(c, body, fact.parameters[1].id);
    }
  }
  return c.finish(
    node,
    c.table.stream(use.result, [
      ...(source.kind === "stream" ? source.failures : []),
      ...(fn?.failures ?? []),
    ], [
      ...(source.kind === "stream" ? source.requirements : []),
      ...without(fn?.requirements ?? [], [SCOPE_CAPABILITY]),
    ]),
    combine([stream, key.info, use.info]),
  );
}

export function scanStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("scanStream", args[2]);
  const { stream, seed, source, element } = seededStream(c, "scanStream", args);
  const update = c.callback(
    "scanStream",
    args[2],
    [seed.type, element],
    seed.type,
  );
  c.fits(
    args[2].node,
    update.result,
    seed.type,
    "the scanStream update result",
  );
  const type = c.table.stream(
    seed.type,
    source.kind === "stream" ? source.failures : [],
    source.kind === "stream" ? source.requirements : [],
  );
  return c.finish(node, type, combine([stream, seed, update.info]));
}

export function mapAccumStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("mapAccumStream", args[2]);
  if (
    kindOf(c.tree, args[2].node) === SyntaxKind.ArrowExpr &&
    !c.kids(args[2].node).some((kid) => isTypeKind(kindOf(c.tree, kid)))
  ) {
    c.report(
      "type-mismatch/011",
      "`mapAccumStream` callback needs an explicit [State, Output[]] result type",
      args[2].node,
    );
  }
  const { stream, seed, source, element } = seededStream(
    c,
    "mapAccumStream",
    args,
  );
  const update = c.callback(
    "mapAccumStream",
    args[2],
    [seed.type, element],
    undefined,
  );
  const result = c.table.node(c.table.unfold(update.result));
  const state = result.kind === "tuple" && result.elements.length === 2
    ? result.elements[0]
    : c.table.error;
  const outputs = result.kind === "tuple" && result.elements.length === 2
    ? c.table.node(c.table.unfold(result.elements[1]))
    : undefined;
  if (
    result.kind !== "tuple" || result.elements.length !== 2 ||
    !c.table.isAssignable(state, seed.type) || outputs?.kind !== "array"
  ) {
    c.report(
      "type-mismatch/003",
      "`mapAccumStream` callback must return [State, Output[]]",
      args[2].node,
    );
  }
  const type = c.table.stream(
    outputs?.kind === "array" ? outputs.element : c.table.error,
    source.kind === "stream" ? source.failures : [],
    source.kind === "stream" ? source.requirements : [],
  );
  return c.finish(node, type, combine([stream, seed, update.info]));
}

export function foldStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("foldStream", args[2]);
  const { stream, seed, source, element } = seededStream(c, "foldStream", args);
  const update = c.callback(
    "foldStream",
    args[2],
    [seed.type, element],
    seed.type,
  );
  c.fits(
    args[2].node,
    update.result,
    seed.type,
    "the foldStream update result",
  );
  return c.finish(
    node,
    seed.type,
    combine([stream, seed, update.info, {
      failures: source.kind === "stream" ? source.failures : [],
      requirements: source.kind === "stream" ? source.requirements : [],
      mode: "effect",
    }]),
  );
}

export function foldEffectStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("foldEffectStream", args[2]);
  const { stream, seed, source, element } = seededStream(
    c,
    "foldEffectStream",
    args,
  );
  const update = c.callback(
    "foldEffectStream",
    args[2],
    [seed.type, element],
    seed.type,
    true,
  );
  c.fits(
    args[2].node,
    update.result,
    seed.type,
    "the foldEffectStream update result",
  );
  const fn = c.functionOf(update.info.type);
  return c.finish(
    node,
    seed.type,
    combine([stream, seed, update.info, {
      failures: [
        ...(source.kind === "stream" ? source.failures : []),
        ...(fn?.failures ?? []),
      ],
      requirements: [
        ...(source.kind === "stream" ? source.requirements : []),
        ...(fn?.requirements ?? []),
      ],
      mode: "effect",
    }]),
  );
}

export function flatMapStreamsCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const concurrency = args[2] === undefined
    ? undefined
    : c.concurrencyBound(args[2], "flatMapStreams");
  c.fact(node, { kind: "flat-map-streams", concurrency });
  c.noPipeline("flatMapStreams", args);
  const { stream, transform, type } = innerStreams(c, "flatMapStreams", args);
  return c.finish(
    node,
    type,
    combine([
      stream,
      transform,
      ...(args[2] === undefined ? [] : [c.argInfo(args[2])]),
    ]),
  );
}

export function switchMapStreamsCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.fact(node, { kind: "switch-map-streams" });
  const { stream, transform, type } = innerStreams(c, "switchMapStreams", args);
  return c.finish(node, type, combine([stream, transform]));
}

export function catchStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.fact(node, { kind: "catch-stream" });
  c.inlineStreamCallback("catchStream", args[1]);
  const { info: stream, source } = streamArg(c, "catchStream", args[0]);
  const errors = source.kind === "stream"
    ? c.table.union(source.failures.map((id) => c.table.named(id)))
    : c.table.error;
  const recover = c.callback("catchStream", args[1], [errors], undefined);
  const replacement = c.table.node(c.table.unfold(recover.result));
  if (replacement.kind !== "stream" && !c.isError(recover.result)) {
    c.report(
      "type-mismatch/010",
      "`catchStream` callback must return a Stream value",
      args[1].node,
    );
  }
  const type = c.table.stream(
    c.table.union([
      source.kind === "stream" ? source.element : c.table.error,
      replacement.kind === "stream" ? replacement.element : c.table.error,
    ]),
    replacement.kind === "stream" ? replacement.failures : [],
    [
      ...(source.kind === "stream" ? source.requirements : []),
      ...(replacement.kind === "stream" ? replacement.requirements : []),
    ],
  );
  return c.finish(node, type, combine([stream, recover.info]));
}

export function retryStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.fact(node, { kind: "retry-stream" });
  const stream = c.argInfo(args[0]);
  const policy = c.argInfo(args[1]);
  const source = streamOf(c, "retryStream", args[0], stream);
  const schedule = c.table.node(c.table.unfold(policy.type));
  if (schedule.kind !== "retry-schedule" && !c.isError(policy.type)) {
    c.report(
      "type-mismatch/010",
      "`retryStream` needs a RetrySchedule value",
      args[1].node,
    );
  }
  if (source.kind === "stream" && schedule.kind === "retry-schedule") {
    for (const failure of source.failures) {
      if (!c.table.isAssignable(c.table.named(failure), schedule.error)) {
        c.report(
          "type-mismatch/003",
          `the retry schedule does not accept ${failure}`,
          args[1].node,
        );
      }
    }
  }
  if (!isPureInfo(policy)) {
    c.report(
      "execution-mode/001",
      "`retryStream` policy must be pure",
      args[1].node,
    );
  }
  const type = source.kind === "stream"
    ? c.table.stream(source.element, source.failures, source.requirements)
    : c.table.error;
  return c.finish(node, type, combine([stream, policy]));
}

export function debounceStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const { info: stream } = streamArg(c, "debounceStream", args[0]);
  const delayNode = args[1].node;
  const delay = args[1].pre === undefined &&
      kindOf(c.tree, delayNode) === SyntaxKind.LiteralExpr
    ? literalOf(c.tree, delayNode)
    : undefined;
  const delayMs = typeof delay === "number" &&
      Number.isSafeInteger(delay) && delay >= 0
    ? delay
    : undefined;
  if (delayMs === undefined) {
    c.report(
      "type-mismatch/010",
      "`debounceStream` needs a nonnegative safe integer millisecond literal",
      delayNode,
    );
  } else {
    c.finish(delayNode, c.table.int, PURE_EFFECTS);
  }
  c.fact(node, { kind: "debounce-stream", delayMs });
  return c.finish(node, stream.type, stream);
}

export function throttleStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const { info: stream } = streamArg(c, "throttleStream", args[0]);
  const options = streamThrottleOptions(c, args[1]);
  c.fact(node, {
    kind: "throttle-stream",
    units: options?.units,
    durationMs: options?.durationMs,
    strategy: options?.strategy,
  });
  return c.finish(node, stream.type, stream);
}

/** A terminal over a Stream: it runs the Stream and gives `result(element)`. */
export function terminalStreamCall(
  c: StreamContext,
  node: NodeId,
  name: "collectStream" | "headStream" | "lastStream" | "drainStream",
  args: readonly Arg[],
  result: (element: TypeRef) => TypeRef,
): NodeInfo {
  const stream = c.argInfo(args[0]);
  const source = streamOf(c, name, args[0], stream);
  if (source.kind !== "stream") {
    return c.finish(node, c.table.error, combine([stream, EFFECT_ONLY]));
  }
  return c.finish(
    node,
    result(source.element),
    combine([stream, {
      failures: source.failures,
      requirements: source.requirements,
      mode: "effect",
    }]),
  );
}

/** `takeStream` and `dropStream`: a Stream and a pure Int count. `label` names the count. */
export function countStreamCall(
  c: StreamContext,
  node: NodeId,
  name: "takeStream" | "dropStream",
  args: readonly Arg[],
  label: "take" | "drop",
): NodeInfo {
  const stream = c.argInfo(args[0]);
  const count = c.argInfo(args[1], c.table.int);
  streamOf(c, name, args[0], stream);
  c.fits(args[1].node, count.type, c.table.int, `the ${label} count`);
  if (!isPureInfo(count)) {
    c.report(
      "execution-mode/001",
      `\`${name}\` count must be pure`,
      args[1].node,
    );
  }
  return c.finish(node, stream.type, combine([stream, count]));
}

export function effectStreamPredicateCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
  name:
    | "filterEffectStream"
    | "takeWhileEffectStream"
    | "takeUntilEffectStream"
    | "dropWhileEffectStream",
): NodeInfo {
  c.inlineStreamCallback(name, args[1]);
  const stream = c.argInfo(args[0]);
  const source = c.table.node(c.table.unfold(stream.type));
  if (source.kind !== "stream" && !c.isError(stream.type)) {
    c.report("type-mismatch/010", `${name} needs a Stream value`, args[0].node);
  }
  const element = source.kind === "stream" ? source.element : c.table.error;
  const predicate = c.callback(name, args[1], [element], c.table.boolean, true);
  c.fits(
    args[1].node,
    predicate.result,
    c.table.boolean,
    `the ${name} predicate`,
  );
  const fn = c.functionOf(predicate.info.type);
  // A pure callback compiles to the pure stream operation, and the
  // stream type (an alias too) stays as it is.
  if (
    fn !== undefined && fn.execution === "pure" &&
    fn.failures.length === 0 && fn.requirements.length === 0
  ) {
    c.fact(node, { kind: STREAM_PREDICATE_FACTS[name].pure });
    return c.finish(node, stream.type, combine([stream, predicate.info]));
  }
  c.fact(node, { kind: STREAM_PREDICATE_FACTS[name].effect });
  const type = c.table.stream(element, [
    ...(source.kind === "stream" ? source.failures : []),
    ...(fn?.failures ?? []),
  ], [
    ...(source.kind === "stream" ? source.requirements : []),
    ...(fn?.requirements ?? []),
  ]);
  return c.finish(node, type, combine([stream, predicate.info]));
}

export function sinkForEachCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("sinkForEach", args[0]);
  const consume = c.argInfo(args[0]);
  const fn = c.functionOf(consume.type);
  if (fn === undefined || fn.parameters.length !== 1) {
    if (!c.isError(consume.type)) {
      c.report(
        "type-mismatch/010",
        "`sinkForEach` needs a one-argument callback with an annotated input",
        args[0].node,
      );
    }
    return c.finish(node, c.table.error, consume);
  }
  c.fits(args[0].node, fn.result, c.table.unit, "the sink callback result");
  const type = c.table.sink(
    fn.parameters[0],
    c.table.unit,
    fn.failures,
    fn.requirements,
  );
  return c.finish(node, type, consume);
}

export function takeSinkCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
  expected: TypeRef | undefined,
): NodeInfo {
  const literal = args[0].pre === undefined &&
      kindOf(c.tree, args[0].node) === SyntaxKind.LiteralExpr
    ? literalOf(c.tree, args[0].node)
    : undefined;
  const count = typeof literal === "number" && Number.isSafeInteger(literal) &&
      literal > 0
    ? literal
    : undefined;
  if (count === undefined) {
    c.argInfo(args[0]);
    c.report(
      "type-mismatch/010",
      "`takeSink` needs a positive safe integer literal count",
      args[0].node,
    );
  } else {
    c.finish(args[0].node, c.table.int, PURE_EFFECTS);
  }
  c.fact(node, { kind: "take-sink", count });
  const hint = expected === undefined
    ? undefined
    : c.table.node(c.table.unfold(expected));
  if (hint?.kind !== "sink") {
    c.report(
      "type-mismatch/010",
      "`takeSink` needs an expected Sink type to determine its input",
      node,
    );
    return c.finish(node, c.table.error, PURE_EFFECTS);
  }
  return c.finish(
    node,
    c.table.sink(hint.input, c.table.array(hint.input), [], [], hint.input),
    PURE_EFFECTS,
  );
}

export function aggregateWithinStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const stream = c.argInfo(args[0]);
  const producer = c.table.node(c.table.unfold(stream.type));
  const sink = c.argInfo(args[1], takeSinkHint(c, stream.type, args[1]));
  const schedule = c.argInfo(args[2]);
  const consumer = c.table.node(c.table.unfold(sink.type));
  const policy = c.table.node(c.table.unfold(schedule.type));
  if (
    producer.kind !== "stream" || consumer.kind !== "sink" ||
    policy.kind !== "schedule"
  ) {
    c.report(
      "type-mismatch/010",
      "`aggregateWithinStream` needs Stream, Sink, and Schedule values",
      node,
    );
    return c.finish(node, c.table.error, combine([stream, sink, schedule]));
  }
  c.fits(args[0].node, producer.element, consumer.input, "the sink input");
  c.fits(
    args[1].node,
    consumer.leftover,
    consumer.input,
    "the replayed sink leftovers",
  );
  if (c.table.unfold(policy.input) !== c.table.unknown) {
    c.fits(
      args[2].node,
      c.table.option(consumer.result),
      policy.input,
      "the schedule input",
    );
  }
  return c.finish(
    node,
    c.table.stream(consumer.result, [
      ...producer.failures,
      ...consumer.failures,
      ...policy.failures,
    ], [
      ...producer.requirements,
      ...consumer.requirements,
      ...policy.requirements,
    ]),
    combine([stream, sink, schedule]),
  );
}

export function sinkTransformStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
  name: "transduceStream" | "aggregateStream",
): NodeInfo {
  const stream = c.argInfo(args[0]);
  const producer = c.table.node(c.table.unfold(stream.type));
  const sink = c.argInfo(args[1], takeSinkHint(c, stream.type, args[1]));
  const consumer = c.table.node(c.table.unfold(sink.type));
  if (producer.kind !== "stream" || consumer.kind !== "sink") {
    c.report(
      "type-mismatch/010",
      `\`${name}\` needs Stream and Sink values`,
      node,
    );
    return c.finish(node, c.table.error, combine([stream, sink]));
  }
  c.fits(args[0].node, producer.element, consumer.input, "the sink input");
  c.fits(
    args[1].node,
    consumer.leftover,
    consumer.input,
    "the replayed sink leftovers",
  );
  return c.finish(
    node,
    c.table.stream(consumer.result, [
      ...producer.failures,
      ...consumer.failures,
    ], [...producer.requirements, ...consumer.requirements]),
    combine([stream, sink]),
  );
}

export function runStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const stream = c.argInfo(args[0]);
  const producer = c.table.node(c.table.unfold(stream.type));
  const sink = c.argInfo(args[1], takeSinkHint(c, stream.type, args[1]));
  const consumer = c.table.node(c.table.unfold(sink.type));
  if (producer.kind !== "stream" && !c.isError(stream.type)) {
    c.report(
      "type-mismatch/010",
      "`runStream` needs a Stream as its first argument",
      args[0].node,
    );
  }
  if (consumer.kind !== "sink" && !c.isError(sink.type)) {
    c.report(
      "type-mismatch/010",
      "`runStream` needs a Sink as its second argument",
      args[1].node,
    );
  }
  if (producer.kind !== "stream" || consumer.kind !== "sink") {
    return c.finish(node, c.table.error, combine([stream, sink, EFFECT_ONLY]));
  }
  c.fits(args[1].node, producer.element, consumer.input, "the sink input");
  return c.finish(
    node,
    consumer.result,
    combine([stream, sink, {
      failures: [...producer.failures, ...consumer.failures],
      requirements: [...producer.requirements, ...consumer.requirements],
      mode: "effect",
    }]),
  );
}

export function bufferStreamCall(
  c: StreamContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const { info: stream } = streamArg(c, "bufferStream", args[0]);
  const capacity = streamBufferCapacity(c, args[1]);
  c.fact(node, { kind: "buffer-stream", capacity });
  return c.finish(node, stream.type, stream);
}

/** `mergeStreams`, `zipStreams`, and `concatStreams`: two Streams give one. */
export function streamPairCall(
  c: StreamContext,
  node: NodeId,
  name: "mergeStreams" | "zipStreams" | "concatStreams",
  args: readonly Arg[],
): NodeInfo {
  const left = c.argInfo(args[0]);
  const right = c.argInfo(args[1]);
  const a = c.table.node(c.table.unfold(left.type));
  const b = c.table.node(c.table.unfold(right.type));
  if (a.kind !== "stream" || b.kind !== "stream") {
    c.report("type-mismatch/010", `\`${name}\` needs two Stream values`, node);
    return c.finish(node, c.table.error, combine([left, right]));
  }
  let element: TypeRef;
  if (name === "zipStreams") {
    element = c.table.tuple([a.element, b.element]);
  } else if (name === "concatStreams") {
    element = c.table.union([a.element, b.element]);
  } else {
    const aFitsB = c.table.isAssignable(a.element, b.element);
    const bFitsA = c.table.isAssignable(b.element, a.element);
    if (!aFitsB && !bFitsA) {
      c.report(
        "type-mismatch/010",
        "`mergeStreams` needs compatible element types",
        node,
      );
    }
    element = aFitsB ? b.element : a.element;
  }
  const type = c.table.stream(element, [...a.failures, ...b.failures], [
    ...a.requirements,
    ...b.requirements,
  ]);
  return c.finish(node, type, combine([left, right]));
}

/**
 * The Stream shape of a checked argument. When it is neither a Stream nor an
 * error, this reports `type-mismatch/010` and returns the other shape.
 */
function streamOf(
  c: StreamContext,
  name: string,
  arg: Arg,
  info: NodeInfo,
): TypeNode {
  const source = c.table.node(c.table.unfold(info.type));
  if (source.kind !== "stream" && !c.isError(info.type)) {
    c.report("type-mismatch/010", `\`${name}\` needs a Stream value`, arg.node);
  }
  return source;
}

/** Checks an argument that must be a Stream and gives its shape and element type. */
function streamArg(c: StreamContext, name: string, arg: Arg): {
  info: NodeInfo;
  source: TypeNode;
  element: TypeRef;
} {
  const info = c.argInfo(arg);
  const source = streamOf(c, name, arg, info);
  return {
    info,
    source,
    element: source.kind === "stream" ? source.element : c.table.error,
  };
}

/**
 * Checks the Stream and the seed of a fold-like call, in that order, and
 * reports a seed that is not pure.
 */
function seededStream(c: StreamContext, name: string, args: readonly Arg[]): {
  stream: NodeInfo;
  seed: NodeInfo;
  source: TypeNode;
  element: TypeRef;
} {
  const stream = c.argInfo(args[0]);
  const seed = c.argInfo(args[1]);
  const source = streamOf(c, name, args[0], stream);
  if (!isPureInfo(seed)) {
    c.report(
      "execution-mode/001",
      `\`${name}\` seed must be pure`,
      args[1].node,
    );
  }
  const element = source.kind === "stream" ? source.element : c.table.error;
  return { stream, seed, source, element };
}

function groupKeyClass(
  c: StreamContext,
  ref: TypeRef,
  depth = 0,
): string | undefined {
  if (depth > 128) {
    return undefined;
  }
  let found: string | undefined;
  for (const member of flattenMembers(c.table, ref)) {
    const type = c.table.node(member);
    let current: string | undefined;
    if (type.kind === "literal") {
      if (type.value === null) {
        return undefined;
      }
      current = typeof type.value === "number"
        ? Number.isSafeInteger(type.value) ? "int" : undefined
        : typeof type.value;
    } else if (type.kind === "primitive") {
      if (
        type.name === "int" || type.name === "string" ||
        type.name === "boolean"
      ) {
        current = type.name;
      }
    } else if (type.kind === "named" && !isErrorId(type.id)) {
      const base = c.table.brandBaseOf(type.id);
      if (
        base !== undefined &&
        groupKeyClass(c, base, depth + 1) !== undefined
      ) {
        current = `brand:${type.id}`;
      }
    }
    if (current === undefined || (found !== undefined && found !== current)) {
      return undefined;
    }
    found = current;
  }
  return found;
}

function groupUses(c: StreamContext, body: NodeId, id: LocalId): void {
  const terminals = new Set([
    "collectStream",
    "runStream",
    "foldStream",
    "foldEffectStream",
    "headStream",
    "lastStream",
    "drainStream",
  ]);
  const uses = c.localUses(body, id, true);
  uses.forEach(({ node, parent, grandparent, nested }, references) => {
    const call = parent !== undefined &&
        kindOf(c.tree, parent) === SyntaxKind.ArgList
      ? grandparent
      : parent;
    const callee =
      call !== undefined && kindOf(c.tree, call) === SyntaxKind.CallExpr
        ? c.kids(call)[0]
        : undefined;
    const called = callee === undefined ? undefined : c.targets.get(callee);
    const first = call === undefined
      ? undefined
      : c.kids(call).slice(1).flatMap((child) =>
        kindOf(c.tree, child) === SyntaxKind.ArgList ? c.kids(child) : [child]
      )[0];
    if (
      nested || references > 0 || first !== node ||
      called?.kind !== "builtin" || !terminals.has(called.name)
    ) {
      c.report(
        "type-mismatch/010",
        "a borrowed group permits at most one direct terminal use and cannot escape or be captured",
        node,
      );
    }
  });
}

/**
 * The shared part of flatMapStreams and switchMapStreams: each element maps
 * to an inner Stream, and the result joins the channels of both.
 */
function innerStreams(
  c: StreamContext,
  name: "flatMapStreams" | "switchMapStreams",
  args: readonly Arg[],
): {
  stream: NodeInfo;
  transform: NodeInfo;
  type: TypeRef;
} {
  c.inlineStreamCallback(name, args[1]);
  const { info: stream, source, element } = streamArg(c, name, args[0]);
  const transform = c.callback(name, args[1], [element], undefined);
  const inner = c.table.node(c.table.unfold(transform.result));
  if (inner.kind !== "stream" && !c.isError(transform.result)) {
    c.report(
      "type-mismatch/010",
      `\`${name}\` callback must return a Stream value`,
      args[1].node,
    );
  }
  const type = c.table.stream(
    inner.kind === "stream" ? inner.element : c.table.error,
    [
      ...(source.kind === "stream" ? source.failures : []),
      ...(inner.kind === "stream" ? inner.failures : []),
    ],
    [
      ...(source.kind === "stream" ? source.requirements : []),
      ...(inner.kind === "stream" ? inner.requirements : []),
    ],
  );
  return { stream, transform: transform.info, type };
}

function streamThrottleOptions(c: StreamContext, arg: Arg): {
  units: number;
  durationMs: number;
  strategy: "shape" | "enforce";
} | undefined {
  const record = c.literalRecord(arg, 3);
  const values = record.ok ? record.value : undefined;
  const units = values?.get("units");
  const duration = values?.get("durationMs");
  const strategy = values?.get("strategy");
  if (
    units === undefined || duration === undefined || strategy === undefined ||
    typeof units.value !== "number" ||
    !Number.isSafeInteger(units.value) || units.value <= 0 ||
    typeof duration.value !== "number" ||
    !Number.isSafeInteger(duration.value) || duration.value <= 0 ||
    (strategy.value !== "shape" && strategy.value !== "enforce")
  ) {
    c.report(
      "type-mismatch/010",
      '`throttleStream` needs { units: U, durationMs: M, strategy: "shape" | "enforce" } with positive safe integer literals',
      arg.node,
    );
    return undefined;
  }
  c.finish(units.node, c.table.int, PURE_EFFECTS);
  c.finish(duration.node, c.table.int, PURE_EFFECTS);
  c.finish(strategy.node, c.table.literal(strategy.value), PURE_EFFECTS);
  c.finish(
    arg.node,
    c.table.record([
      { name: "units", type: c.table.int, optional: false },
      { name: "durationMs", type: c.table.int, optional: false },
      {
        name: "strategy",
        type: c.table.literal(strategy.value),
        optional: false,
      },
    ]),
    PURE_EFFECTS,
  );
  return {
    units: units.value,
    durationMs: duration.value,
    strategy: strategy.value,
  };
}

/**
 * The expected Sink type for a sink argument of a stream: the stream element
 * as input, an array of it as result, and no channels. `takeSink` needs the
 * element to find its input, so the argument gets this type when a direct
 * `takeSink` call is one of its results. An expected type also constrains
 * each `if` and `match` branch, so a sink with no `takeSink` result, such as
 * a branch between named sinks, gets no expected type.
 */
function takeSinkHint(
  c: StreamContext,
  stream: TypeRef,
  sink: Arg,
): TypeRef | undefined {
  const producer = c.table.node(c.table.unfold(stream));
  if (
    producer.kind !== "stream" || sink.pre !== undefined ||
    !resultsInTakeSink(c, sink.node)
  ) {
    return undefined;
  }
  return c.table.sink(
    producer.element,
    c.table.array(producer.element),
    [],
    [],
    producer.element,
  );
}

/**
 * Whether a direct call of the `takeSink` builtin is a result of the
 * expression: the expression itself, or the result of a block, a branch of
 * an `if`, or an arm of a `match` inside it.
 */
function resultsInTakeSink(c: StreamContext, node: NodeId): boolean {
  const kids = c.kids(node);
  switch (kindOf(c.tree, node)) {
    case SyntaxKind.CallExpr: {
      const target = kids[0] === undefined ? undefined : c.targets.get(kids[0]);
      return target?.kind === "builtin" && target.name === "takeSink";
    }
    case SyntaxKind.ParenExpr:
      return kids[0] !== undefined && resultsInTakeSink(c, kids[0]);
    case SyntaxKind.Block: {
      const last = kids.at(-1);
      return last !== undefined &&
        kindOf(c.tree, last) !== SyntaxKind.ConstDecl &&
        resultsInTakeSink(c, last);
    }
    case SyntaxKind.IfExpr:
      return kids.slice(1, 3).some((branch) => resultsInTakeSink(c, branch));
    case SyntaxKind.MatchExpr:
      return kids.slice(1).some((arm) => {
        if (kindOf(c.tree, arm) !== SyntaxKind.MatchArm) {
          return false;
        }
        const parts = c.kids(arm);
        const pattern = parts.find((k) => isPatternKind(kindOf(c.tree, k)));
        const body = parts.filter((k) => k !== pattern).pop();
        return body !== undefined && resultsInTakeSink(c, body);
      });
    default:
      return false;
  }
}

function streamBufferCapacity(
  c: StreamContext,
  arg: Arg,
  operation = "bufferStream",
  fieldName = "capacity",
): number | undefined {
  const record = c.literalRecord(arg, 1);
  const capacity = record.ok ? record.value.get(fieldName) : undefined;
  const value = capacity?.value;
  if (
    capacity === undefined || typeof value !== "number" ||
    !Number.isSafeInteger(value) || value <= 0
  ) {
    c.report(
      "type-mismatch/010",
      `\`${operation}\` needs \`{ ${fieldName}: N }\` with a positive safe integer literal`,
      arg.node,
    );
    return undefined;
  }
  c.finish(capacity.node, c.table.int, PURE_EFFECTS);
  c.finish(
    arg.node,
    c.table.record([{
      name: fieldName,
      type: c.table.int,
      optional: false,
    }]),
    PURE_EFFECTS,
  );
  return value;
}

/** The rows of the Stream and Sink builtins. */
export const STREAM_ROWS = {
  unfold: {
    prologue: direct(2, "pure", { fact: { kind: "unfold" } }),
    handle: (c, node, _name, args) => unfoldCall(c, node, args),
  },
  mapEffect: {
    prologue: optionalLast(
      2,
      "`mapEffect` takes a Stream, a callback, and an optional concurrency record",
    ),
    handle: (c, node, _name, args) => mapEffectCall(c, node, args),
  },
  mapGroups: {
    prologue: direct(4, "pure", {
      fact: { kind: "map-groups", bufferSize: undefined },
    }),
    handle: (c, node, _name, args) => mapGroupsCall(c, node, args),
  },
  scanStream: {
    prologue: direct(3, "pure", { fact: { kind: "scan-stream" } }),
    handle: (c, node, _name, args) => scanStreamCall(c, node, args),
  },
  mapAccumStream: {
    prologue: direct(3, "pure", { fact: { kind: "map-accum-stream" } }),
    handle: (c, node, _name, args) => mapAccumStreamCall(c, node, args),
  },
  foldStream: {
    prologue: direct(3, "effect", { fact: { kind: "fold-stream" } }),
    handle: (c, node, _name, args) => foldStreamCall(c, node, args),
  },
  foldEffectStream: {
    prologue: direct(3, "effect", { fact: { kind: "fold-effect-stream" } }),
    handle: (c, node, _name, args) => foldEffectStreamCall(c, node, args),
  },
  collectStream: {
    prologue: direct(1, "effect", { fact: { kind: "collect-stream" } }),
    handle: (c, node, name, args) =>
      terminalStreamCall(c, node, name, args, (e) => c.table.array(e)),
  },
  headStream: {
    prologue: direct(1, "effect", { fact: { kind: "head-stream" } }),
    handle: (c, node, name, args) =>
      terminalStreamCall(c, node, name, args, (e) => c.table.option(e)),
  },
  lastStream: {
    prologue: direct(1, "effect", { fact: { kind: "last-stream" } }),
    handle: (c, node, name, args) =>
      terminalStreamCall(c, node, name, args, (e) => c.table.option(e)),
  },
  drainStream: {
    prologue: direct(1, "effect", { fact: { kind: "drain-stream" } }),
    handle: (c, node, name, args) =>
      terminalStreamCall(c, node, name, args, () => c.table.unit),
  },
  flatMapStreams: {
    prologue: optionalLast(
      2,
      "`flatMapStreams` takes a Stream, a callback, and an optional concurrency record",
    ),
    handle: (c, node, _name, args) => flatMapStreamsCall(c, node, args),
  },
  switchMapStreams: {
    prologue: direct(2, "pure"),
    handle: (c, node, _name, args) => switchMapStreamsCall(c, node, args),
  },
  catchStream: {
    prologue: direct(2, "pure"),
    handle: (c, node, _name, args) => catchStreamCall(c, node, args),
  },
  retryStream: {
    prologue: direct(2, "pure"),
    handle: (c, node, _name, args) => retryStreamCall(c, node, args),
  },
  debounceStream: {
    prologue: direct(2, "pure", {
      bailFact: { kind: "debounce-stream", delayMs: undefined },
    }),
    handle: (c, node, _name, args) => debounceStreamCall(c, node, args),
  },
  throttleStream: {
    prologue: direct(2, "pure", {
      bailFact: {
        kind: "throttle-stream",
        units: undefined,
        durationMs: undefined,
        strategy: undefined,
      },
    }),
    handle: (c, node, _name, args) => throttleStreamCall(c, node, args),
  },
  takeStream: {
    prologue: direct(2, "pure", { fact: { kind: "take-stream" } }),
    handle: (c, node, name, args) =>
      countStreamCall(c, node, name, args, "take"),
  },
  dropStream: {
    prologue: direct(2, "pure", { fact: { kind: "drop-stream" } }),
    handle: (c, node, name, args) =>
      countStreamCall(c, node, name, args, "drop"),
  },
  filterEffectStream: {
    prologue: direct(2, "pure", {
      bailFact: { kind: STREAM_PREDICATE_FACTS.filterEffectStream.effect },
    }),
    handle: (c, node, name, args) =>
      effectStreamPredicateCall(c, node, args, name),
  },
  takeWhileEffectStream: {
    prologue: direct(2, "pure", {
      bailFact: { kind: STREAM_PREDICATE_FACTS.takeWhileEffectStream.effect },
    }),
    handle: (c, node, name, args) =>
      effectStreamPredicateCall(c, node, args, name),
  },
  takeUntilEffectStream: {
    prologue: direct(2, "pure", {
      bailFact: { kind: STREAM_PREDICATE_FACTS.takeUntilEffectStream.effect },
    }),
    handle: (c, node, name, args) =>
      effectStreamPredicateCall(c, node, args, name),
  },
  dropWhileEffectStream: {
    prologue: direct(2, "pure", {
      bailFact: { kind: STREAM_PREDICATE_FACTS.dropWhileEffectStream.effect },
    }),
    handle: (c, node, name, args) =>
      effectStreamPredicateCall(c, node, args, name),
  },
  sinkForEach: {
    prologue: direct(1, "pure", { fact: { kind: "sink-for-each" } }),
    handle: (c, node, _name, args) => sinkForEachCall(c, node, args),
  },
  takeSink: {
    prologue: direct(1, "pure", {
      fact: { kind: "take-sink", count: undefined },
    }),
    handle: (c, node, _name, args, expected) =>
      takeSinkCall(c, node, args, expected),
  },
  transduceStream: {
    prologue: direct(2, "pure", { fact: { kind: "transduce-stream" } }),
    handle: (c, node, name, args) =>
      sinkTransformStreamCall(c, node, args, name),
  },
  aggregateStream: {
    prologue: direct(2, "pure", { fact: { kind: "aggregate-stream" } }),
    handle: (c, node, name, args) =>
      sinkTransformStreamCall(c, node, args, name),
  },
  aggregateWithinStream: {
    prologue: direct(3, "pure", {
      fact: { kind: "aggregate-within-stream" },
    }),
    handle: (c, node, _name, args) => aggregateWithinStreamCall(c, node, args),
  },
  runStream: {
    prologue: direct(2, "effect", { fact: { kind: "run-stream" } }),
    handle: (c, node, _name, args) => runStreamCall(c, node, args),
  },
  bufferStream: {
    prologue: direct(2, "pure", {
      bailFact: { kind: "buffer-stream", capacity: undefined },
    }),
    handle: (c, node, _name, args) => bufferStreamCall(c, node, args),
  },
  mergeStreams: {
    prologue: direct(2, "pure", { fact: { kind: "merge-streams" } }),
    handle: (c, node, name, args) => streamPairCall(c, node, name, args),
  },
  zipStreams: {
    prologue: direct(2, "pure", { fact: { kind: "zip-streams" } }),
    handle: (c, node, name, args) => streamPairCall(c, node, name, args),
  },
  concatStreams: {
    prologue: direct(2, "pure", { fact: { kind: "concat-streams" } }),
    handle: (c, node, name, args) => streamPairCall(c, node, name, args),
  },
} satisfies Partial<Rows<PreludeCallName, StreamContext>>;
