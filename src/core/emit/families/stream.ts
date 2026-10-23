// Emission of the Stream and Sink builtins: the stream operators, the sink
// operators, and the stream folds.

import {
  at,
  callArguments,
  concurrencyArguments,
  type Emitted,
  emitted,
  type Kid,
  PREC,
} from "../emitted.ts";
import { resolvedAs } from "../scope.ts";
import type { ExprOf } from "../shape.ts";
import { channelTypeArguments, typeArguments, typeDoc } from "../types.ts";
import type { ExprCore } from "./context.ts";

export type StreamStructuralKind =
  | "unfold"
  | "map-effect"
  | "map-groups"
  | "scan-stream"
  | "map-accum-stream"
  | "flat-map-streams"
  | "debounce-stream"
  | "throttle-stream"
  | "take-sink"
  | "transduce-stream"
  | "aggregate-stream"
  | "aggregate-within-stream"
  | "buffer-stream";

export type StreamLeafKind = "fold-stream" | "fold-effect-stream";

export function streamStructural(
  c: ExprCore,
  e: ExprOf<StreamStructuralKind>,
  kid: Kid,
): Emitted {
  switch (e.kind) {
    case "unfold": {
      const stream = c.scope.effect("Stream");
      const effect = c.scope.effect("Effect");
      const option = c.scope.effect("Option");
      const state = c.scope.temp();
      const callback = c.effectCallback(e.next);
      const next = emitted([
        `${effect}.map`,
        callArguments([
          emitted([
            at(callback, PREC.member),
            callArguments([emitted(state)]),
          ]),
          emitted(`${option}.getOrUndefined`),
        ]),
      ]);
      return emitted([
        `${stream}.unfold`,
        callArguments([
          kid(e.seed),
          emitted(c.arrow(`(${state})`, next)),
        ]),
      ]);
    }
    case "map-effect": {
      const stream = c.scope.effect("Stream");
      return emitted([
        `${stream}.mapEffect`,
        callArguments([
          kid(e.stream),
          c.effectCallback(e.transform),
          ...concurrencyArguments(e.concurrency),
        ]),
      ]);
    }
    case "map-groups": {
      const stream = c.scope.effect("Stream");
      const effect = c.scope.effect("Effect");
      const key = c.scope.fresh("$key");
      const group = c.scope.fresh("$group");
      const pull = c.scope.fresh("$pull");
      const use = c.effectCallback(e.use);
      const owned = c.genCall([
        [`const ${pull} = yield* ${stream}.toPull(${group});`],
        [
          "return yield* (",
          use.doc,
          `)(${key}, ${stream}.fromPull(${effect}.succeed(${pull})));`,
        ],
      ]);
      const callback = emitted(c.arrow(
        `([${key}, ${group}])`,
        emitted([
          `${stream}.fromEffect(${effect}.scoped(`,
          owned.doc,
          "))",
        ]),
      ));
      return emitted([
        `${stream}.flatMap`,
        callArguments([
          emitted([
            `${stream}.groupByKey`,
            callArguments([
              kid(e.stream),
              c.callback(e.key, kid),
              emitted(`{ bufferSize: ${e.bufferSize} }`),
            ]),
          ]),
          callback,
          emitted('{ concurrency: "unbounded", bufferSize: 1 }'),
        ]),
      ]);
    }
    case "scan-stream": {
      const stream = c.scope.effect("Stream");
      return emitted([
        `${stream}.scan`,
        callArguments([
          kid(e.stream),
          emitted(c.arrow("()", kid(e.seed)), PREC.conditional, {
            huggable: true,
          }),
          c.callback(e.update, kid),
        ]),
      ]);
    }
    case "map-accum-stream": {
      const stream = c.scope.effect("Stream");
      return emitted([
        `${stream}.mapAccum`,
        callArguments([
          kid(e.stream),
          emitted(c.arrow("()", kid(e.seed)), PREC.conditional, {
            huggable: true,
          }),
          c.callback(e.update, kid),
        ]),
      ]);
    }
    case "flat-map-streams": {
      const stream = c.scope.effect("Stream");
      return emitted([
        `${stream}.flatMap`,
        callArguments([
          kid(e.stream),
          c.callback(e.transform, kid),
          ...concurrencyArguments(e.concurrency),
        ]),
      ]);
    }
    case "debounce-stream": {
      const stream = c.scope.effect("Stream");
      const duration = c.scope.effect("Duration");
      return emitted([
        `${stream}.debounce`,
        callArguments([
          kid(e.stream),
          emitted(`${duration}.millis(${e.delayMs})`),
        ]),
      ]);
    }
    case "throttle-stream": {
      const stream = c.scope.effect("Stream");
      const duration = c.scope.effect("Duration");
      return emitted([
        `${stream}.throttle`,
        callArguments([
          emitted([
            `${stream}.rechunk`,
            callArguments([kid(e.stream), emitted("1")]),
          ]),
          emitted(
            `{ cost: (arr) => arr.length, units: ${e.units}, duration: ${duration}.millis(${e.durationMs}), strategy: "${e.strategy}" }`,
          ),
        ]),
      ]);
    }
    case "take-sink": {
      const type = resolvedAs(
        c.scope,
        e.type,
        "sink",
        "takeSink has no Sink type",
      );
      return emitted([
        `${c.scope.effect("Sink")}.take`,
        typeArguments([typeDoc(c.scope, type.input)]),
        callArguments([emitted(String(e.count))]),
      ]);
    }
    case "transduce-stream": {
      const message = "transduction has invalid operands";
      const source = resolvedAs(c.scope, e.stream.type, "stream", message);
      const sink = resolvedAs(c.scope, e.sink.type, "sink", message);
      return emitted([
        `${c.scope.effect("Stream")}.transduce`,
        typeArguments([
          typeDoc(c.scope, sink.input),
          ...channelTypeArguments(c.scope, source.effects),
          typeDoc(c.scope, sink.result),
          ...channelTypeArguments(c.scope, sink.effects),
        ]),
        callArguments([kid(e.stream), kid(e.sink)]),
      ]);
    }
    case "aggregate-stream": {
      const message = "aggregation has invalid operands";
      const source = resolvedAs(c.scope, e.stream.type, "stream", message);
      const sink = resolvedAs(c.scope, e.sink.type, "sink", message);
      return emitted([
        `${c.scope.effect("Stream")}.aggregate`,
        typeArguments([
          typeDoc(c.scope, source.element),
          ...channelTypeArguments(c.scope, source.effects),
          typeDoc(c.scope, sink.result),
          sink.leftover === undefined
            ? "never"
            : typeDoc(c.scope, sink.leftover),
          ...channelTypeArguments(c.scope, sink.effects),
        ]),
        callArguments([kid(e.stream), kid(e.sink)]),
      ]);
    }
    case "aggregate-within-stream": {
      const message = "scheduled aggregation has invalid operands";
      const source = resolvedAs(c.scope, e.stream.type, "stream", message);
      const sink = resolvedAs(c.scope, e.sink.type, "sink", message);
      const schedule = resolvedAs(
        c.scope,
        e.schedule.type,
        "schedule",
        message,
      );
      return emitted([
        `${c.scope.effect("Stream")}.aggregateWithin`,
        typeArguments([
          typeDoc(c.scope, source.element),
          ...channelTypeArguments(c.scope, source.effects),
          typeDoc(c.scope, sink.result),
          sink.leftover === undefined
            ? "never"
            : typeDoc(c.scope, sink.leftover),
          ...channelTypeArguments(c.scope, sink.effects),
          typeDoc(c.scope, schedule.output),
          ...channelTypeArguments(c.scope, schedule.effects),
        ]),
        callArguments([kid(e.stream), kid(e.sink), kid(e.schedule)]),
      ]);
    }
    case "buffer-stream": {
      const stream = c.scope.effect("Stream");
      return emitted([
        `${stream}.buffer`,
        callArguments([
          kid(e.stream),
          emitted(`{ capacity: ${e.capacity}, strategy: "suspend" }`),
        ]),
      ]);
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function streamLeaf(
  c: ExprCore,
  e: ExprOf<StreamLeafKind>,
  children: readonly Emitted[],
): Emitted {
  switch (e.kind) {
    case "fold-stream": {
      const stream = c.scope.effect("Stream");
      return emitted([
        `${stream}.runFold`,
        callArguments([
          children[0],
          emitted(c.arrow("()", children[1]), PREC.conditional, {
            huggable: true,
          }),
          children[2],
        ]),
      ]);
    }
    case "fold-effect-stream": {
      const stream = c.scope.effect("Stream");
      return emitted([
        `${stream}.runFoldEffect`,
        callArguments([
          children[0],
          emitted(c.arrow("()", children[1]), PREC.conditional, {
            huggable: true,
          }),
          c.effectCallback(e.update),
        ]),
      ]);
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}
