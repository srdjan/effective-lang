# Phase 7 incremental stream and sink source slice

Status: the first source slice is accepted and implemented. The Effect 4 target
probe, compiler tests, source runtime test, and `build --validate --tsc` gate
pass. Buffered streams, concurrent mapping, and general sinks remain deferred.

The [target probe](phase7-probes/stream.ts) passes `deno test --no-lock` against
`effect@4.0.5`. It composes `Stream.unfold`, `Stream.mapEffect`, and
`Sink.forEach` through `Stream.run`. The producer has made zero calls before
consumption starts. Across four values, it stays at most one element ahead of
the consumer while an effectful transform and sink run. The result order is
`0, 2, 4, 6`. The
[Effect 4 stream creation guide](https://effect.website/docs/v4/stream/creating)
describes `unfold`, the
[operations guide](https://effect.website/docs/v4/stream/operations) describes
`mapEffect`, and the
[sink guide](https://effect.website/docs/v4/sink/creating) describes
`Sink.forEach`.

## Implemented first slice

```effective
error Stop = {}
service Source { next(state: int): Option<[int, int]> fails Stop }
service Transform { double(value: int): int fails Stop }
service Consumer { accept(value: int): void fails Stop }

const numbers: Stream<int, Stop, Source.next> =
  unfold(0, (state) => Source.next(state))

const doubled: Stream<int, Stop, Source.next | Transform.double> =
  mapEffect(numbers, (value) => Transform.double(value))

const consume: Sink<int, void, Stop, Consumer.accept> =
  sinkForEach((value: int) => Consumer.accept(value))

const main = (): void fails Stop
  uses Source.next | Transform.double | Consumer.accept =>
  runStream(doubled, consume)
```

`Stream<A,E,R>` is a deferred producer value; `Sink<I,O,E,R>` is a deferred
consumer value. Their failure and requirement channels describe execution,
not construction. `unfold` accepts a state and an inline callback returning
`Option<[A, State]>`; `None` ends the stream. The backend unwraps that Option
to the tuple-or-`undefined` value required by `Stream.unfold`, without running
the callback during stream construction. `mapEffect` accepts an inline effectful
callback and combines its invocation failures and requirements with those of
the source stream. `sinkForEach` accepts an inline effectful consumer callback with an annotated input and
returns a sink whose result is `void`. `runStream` activates the stream and
sink, combines their channels, and is the execution boundary.

The first slice uses one-element pull demand with no prefetch or concurrent
mapping. It must not run a producer before the terminal consumer starts. Each
consumer completion permits the next pull. This gives a concrete bounded
demand rule; later buffered or concurrent operations need separate bounds and
cancellation semantics. A producer or transform failure stops demand and
releases scoped resources before returning. The IR needs distinct stream and
sink types and operations; independent validation must rederive their deferred
and active channels.

This slice uses Phase 4 deferred values, Phase 5 scoped lifetimes, and Phase 6
cancellation. The canonical spec defines its source forms and pull rule. The
independent IR validator rederives deferred and active channels. The runtime
tests show zero producer calls before execution, at most one produced item
ahead of the consumer, and scoped release after producer failure and
interruption.
