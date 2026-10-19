// deno test --no-lock docs/plans/schema-adapter-probes/encoded-default.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "npm:effect@4.0.5";

class Read extends Context.Service<Read, {
  readonly parse: (value: string) => Effect.Effect<number, SchemaIssue.Issue>;
}>()("encoded-default#Read") {}
class Write extends Context.Service<Write, {
  readonly print: (value: number) => Effect.Effect<string, SchemaIssue.Issue>;
}>()("encoded-default#Write") {}
class Defaults extends Context.Service<Defaults, {
  readonly make: () => Effect.Effect<string, Schema.SchemaError>;
}>()("encoded-default#Defaults") {}

const source = Schema.String.pipe(Schema.decodeTo(
  Schema.Int,
  SchemaTransformation.transformEffect({
    decode: (value) => Read.use((service) => service.parse(value)),
    encode: (value) => Write.use((service) => service.print(value)),
  }),
));
const fallback = Effect.suspend(() =>
  Defaults.use((service) => service.make())
);

function pair(encodingStrategy: "omit" | "passthrough") {
  return [
    Schema.Struct({
      score: source.pipe(
        Schema.withDecodingDefaultKey(fallback, { encodingStrategy }),
      ),
    }),
    Schema.Struct({
      score: source.pipe(Schema.withDecodingDefaultTypeKey(
        Effect.flatMap(fallback, Schema.decodeUnknownEffect(source)),
        { encodingStrategy },
      )),
    }),
  ] as const;
}

function error(exit: Exit.Exit<unknown, Schema.SchemaError>) {
  assert(Exit.isFailure(exit));
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(failure instanceof Schema.SchemaError);
  return failure;
}

Deno.test("encoded defaults share decode behavior but omit still runs the encoder", async () => {
  for (const strategy of ["passthrough", "omit"] as const) {
    const traces: string[][] = [];
    for (const schema of pair(strategy)) {
      const calls: string[] = [];
      let defaults = 0;
      const services = Layer.mergeAll(
        Layer.succeed(Read)({
          parse: (value) =>
            Effect.sync(() => {
              calls.push("read:" + value);
              return Number(value) + 1;
            }),
        }),
        Layer.succeed(Defaults)({
          make: () =>
            Effect.sync(() => {
              calls.push("default");
              return String(++defaults);
            }),
        }),
      );
      const decode: Effect.Effect<
        { readonly score: number },
        Schema.SchemaError,
        Read | Defaults
      > = Schema.decodeUnknownEffect(schema)({});
      assertEquals(calls, []);
      assertEquals(
        await Effect.runPromise(decode.pipe(Effect.provide(services))),
        { score: 2 },
      );
      assertEquals(
        await Effect.runPromise(decode.pipe(Effect.provide(services))),
        { score: 3 },
      );
      assertEquals(
        await Effect.runPromise(
          Schema.decodeUnknownEffect(schema)({ score: "40" }).pipe(
            Effect.provide(services),
          ),
        ),
        { score: 41 },
      );
      for (
        const input of [{ score: undefined }, { score: null }, { score: false }]
      ) {
        const failure = error(
          await Effect.runPromiseExit(
            Schema.decodeUnknownEffect(schema)(input).pipe(
              Effect.provide(services),
            ),
          ),
        );
        assert(failure.message.includes("score"));
      }
      const write = Layer.succeed(Write)({
        print: (value) =>
          Effect.sync(() => {
            calls.push("write:" + value);
            return String(value - 1);
          }),
      });
      const encode: Effect.Effect<
        { readonly score?: string },
        Schema.SchemaError,
        Write
      > = Schema.encodeEffect(schema)({ score: 41 });
      // @ts-expect-error Both variants retain the encoder requirement, even for omit.
      const noWrite: Effect.Effect<
        { readonly score?: string },
        Schema.SchemaError
      > = encode;
      void noWrite;
      assertEquals(
        await Effect.runPromise(encode.pipe(Effect.provide(write))),
        strategy === "omit" ? {} : { score: "40" },
      );
      traces.push(calls);
    }
    assertEquals(traces[0], [
      "default",
      "read:1",
      "default",
      "read:2",
      "read:40",
      "write:41",
    ]);
    assertEquals(
      traces[1],
      strategy === "omit" ? traces[0].slice(0, -1) : traces[0],
    );
  }
});

Deno.test("invalid defaults and wrapped decoder failures preserve observable messages and paths", async () => {
  const issue = new SchemaIssue.InvalidValue({ message: "read blocked" });
  for (
    const make of [
      () => Effect.succeed("bad"),
      () => Effect.succeed("blocked"),
      () =>
        Effect.fail(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({ message: "default blocked" }),
          ),
        ),
    ]
  ) {
    const messages: string[] = [];
    for (const schema of pair("passthrough")) {
      const services = Layer.merge(
        Layer.succeed(Read)({
          parse: (value) =>
            value === "blocked"
              ? Effect.fail(issue)
              : Effect.succeed(Number(value)),
        }),
        Layer.succeed(Defaults)({ make }),
      );
      const failure = error(
        await Effect.runPromiseExit(
          Schema.decodeUnknownEffect(schema)({}).pipe(Effect.provide(services)),
        ),
      );
      assert(failure.message.includes("score"));
      messages.push(failure.message);
    }
    assertEquals(messages[0], messages[1]);
  }
});

Deno.test("decoder and default defects keep their channels under both forms", async () => {
  for (const point of ["read", "default"] as const) {
    for (const schema of pair("passthrough")) {
      const services = Layer.merge(
        Layer.succeed(Read)({
          parse: () =>
            point === "read" ? Effect.die("boom") : Effect.succeed(1),
        }),
        Layer.succeed(Defaults)({
          make: () =>
            point === "default" ? Effect.die("boom") : Effect.succeed("1"),
        }),
      );
      const exit = await Effect.runPromiseExit(
        Schema.decodeUnknownEffect(schema)({}).pipe(Effect.provide(services)),
      );
      assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    }
  }
});

Deno.test("cancellation waits for default generation and wrapped decoding cleanup", async () => {
  for (const point of ["read", "default"] as const) {
    for (const schema of pair("passthrough")) {
      await Effect.runPromise(Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let released = false;
        const pending = Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Effect.sync(() => {
          released = true;
        })));
        const services = Layer.merge(
          Layer.succeed(Read)({
            parse: () => point === "read" ? pending : Effect.succeed(1),
          }),
          Layer.succeed(Defaults)({
            make: () => point === "default" ? pending : Effect.succeed("1"),
          }),
        );
        const fiber = yield* Effect.forkChild(
          Schema.decodeUnknownEffect(schema)({}).pipe(Effect.provide(services)),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        assert(released);
      }));
    }
  }
});

Deno.test("encoded-default omission propagates encoder failures, defects and cancellation", async () => {
  const [native, composed] = pair("omit");
  const issue = new SchemaIssue.InvalidValue({ message: "write blocked" });
  const blocked = Layer.succeed(Write)({ print: () => Effect.fail(issue) });
  const failure = error(
    await Effect.runPromiseExit(
      Schema.encodeEffect(native)({ score: 1 }).pipe(Effect.provide(blocked)),
    ),
  );
  assert(
    failure.message.includes("score") &&
      failure.message.includes("write blocked"),
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(composed)({ score: 1 }).pipe(Effect.provide(blocked)),
    ),
    {},
  );
  const defective = Layer.succeed(Write)({ print: () => Effect.die("boom") });
  const exit = await Effect.runPromiseExit(
    Schema.encodeEffect(native)({ score: 1 }).pipe(Effect.provide(defective)),
  );
  assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(composed)({ score: 1 }).pipe(
        Effect.provide(defective),
      ),
    ),
    {},
  );
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const pending = Layer.succeed(Write)({
      print: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Effect.sync(() => {
          released = true;
        }))),
    });
    const fiber = yield* Effect.forkChild(
      Schema.encodeEffect(native)({ score: 1 }).pipe(Effect.provide(pending)),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert(released);
  }));
});

Deno.test("encoded defaults and omitted encoder results still validate refined E", async () => {
  let decoded = 0;
  const refined = Schema.Int.pipe(Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => {
        decoded++;
        return String(value);
      },
      encode: (_value: string) => 0.5,
    }),
  ));
  const invalidDefault = Schema.Struct({
    value: refined.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(0.5)),
    ),
  });
  const failure = error(
    await Effect.runPromiseExit(Schema.decodeUnknownEffect(invalidDefault)({})),
  );
  assert(failure.message.includes("value"));
  assertEquals(decoded, 0);
  const omitted = Schema.Struct({
    value: refined.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(1), {
        encodingStrategy: "omit",
      }),
    ),
  });
  const invalidEncode = error(
    await Effect.runPromiseExit(
      Schema.encodeEffect(omitted)({ value: "valid" }),
    ),
  );
  assert(invalidEncode.message.includes("value"));
});
