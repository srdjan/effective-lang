import { assert, assertEquals } from "@std/assert";
import { Cause, Deferred, Effect, Exit, Option } from "effect";
import { platformLayer } from "./backend.ts";
import { InvalidArticle, RevisionExhausted } from "./domain.ts";
import { MissingArticle, PublishConflict } from "./feature.ts";
import { makeMemoryPlatform, type MemoryPlatform } from "./memory.ts";
import {
  CompareConflict,
  InvalidKey,
  InvalidPayload,
  Key,
  type KeyValue,
  Payload,
  PlatformUnavailable,
  WriteUncertain,
} from "./platform.ts";
import { Corrupt, StorageUnavailable, StorageUncertain } from "./ports.ts";
import { publishAll, publishArticle } from "./publisher.ts";
import { makeRunner } from "./runner.ts";

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value;
};
const articleKey = (id: string) => Key.make(`articles/${id}`);
const payload = (value: unknown) => Payload.make(JSON.stringify(value));
const draft = (id: string, fields: Readonly<Record<string, unknown>> = {}) => ({
  kind: "draft",
  id,
  revision: 0,
  title: "Title",
  body: "Body",
  ...fields,
});
const published = (
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
) => ({
  kind: "published",
  id,
  revision: 1,
  title: "Title",
  body: "Body",
  publishedAt: 10,
  ...fields,
});
const seed = async (memory: MemoryPlatform, id: string, value: unknown) => {
  await Effect.runPromise(
    memory.control.set(articleKey(id), payload(value), Option.none()),
  );
};
const read = async (memory: MemoryPlatform, id: string): Promise<unknown> => {
  const found = await Effect.runPromise(memory.control.get(articleKey(id)));
  assert(Option.isSome(found));
  return JSON.parse(found.value.payload) as unknown;
};
const wrappedLayer = (
  memory: MemoryPlatform,
  wrap: (operations: KeyValue) => KeyValue,
) => platformLayer({ acquire: memory.backend.acquire.pipe(Effect.map(wrap)) });

Deno.test("publishes a valid draft and reads time once", async () => {
  const memory = makeMemoryPlatform();
  let times = 0;
  await seed(memory, "a", draft("a"));
  const runner = makeRunner({
    memory,
    nowMillis: () => {
      times++;
      return 42;
    },
  });
  assertEquals(await runner.run(publishArticle("a")), {
    id: "a",
    revision: 1,
    outcome: "published",
  });
  assertEquals(await read(memory, "a"), published("a", { publishedAt: 42 }));
  assertEquals([times, memory.active()], [1, 0]);
});

Deno.test("blank title and body fail before time and writes", async () => {
  for (const [field, value] of [["title", "   "], ["body", "\n\t"]] as const) {
    const memory = makeMemoryPlatform();
    let times = 0;
    await seed(memory, field, draft(field, { [field]: value }));
    const runner = makeRunner({
      memory,
      nowMillis: () => {
        times++;
        return 42;
      },
    });
    const error = failure(await runner.runExit(publishArticle(field)));
    assert(error instanceof InvalidArticle);
    assertEquals(error.field, field);
    assertEquals(await read(memory, field), draft(field, { [field]: value }));
    assertEquals(times, 0);
  }
});

Deno.test("missing and already-published articles do not read time", async () => {
  const memory = makeMemoryPlatform();
  let times = 0;
  await seed(memory, "done", published("done"));
  const runner = makeRunner({
    memory,
    nowMillis: () => {
      times++;
      return 42;
    },
  });
  assert(
    failure(await runner.runExit(publishArticle("missing"))) instanceof
      MissingArticle,
  );
  assertEquals(
    (await runner.run(publishArticle("done"))).outcome,
    "already-published",
  );
  assertEquals(times, 0);
});

Deno.test("revision exhaustion fails before time and writes", async () => {
  const memory = makeMemoryPlatform();
  let times = 0;
  await seed(
    memory,
    "max",
    draft("max", { revision: Number.MAX_SAFE_INTEGER }),
  );
  const runner = makeRunner({
    memory,
    nowMillis: () => {
      times++;
      return 42;
    },
  });
  assert(
    failure(await runner.runExit(publishArticle("max"))) instanceof
      RevisionExhausted,
  );
  assertEquals(times, 0);
  assertEquals(
    await read(memory, "max"),
    draft("max", { revision: Number.MAX_SAFE_INTEGER }),
  );
});

Deno.test("malformed Unicode identifiers fail before KV access and time sampling", async () => {
  const memory = makeMemoryPlatform();
  await seed(memory, "kept", draft("kept"));
  let reads = 0;
  let writes = 0;
  let times = 0;
  const runner = makeRunner({
    memory,
    nowMillis: () => {
      times++;
      return 42;
    },
    platformLayer: wrappedLayer(memory, (base) => ({
      get: (key) => {
        reads++;
        return base.get(key);
      },
      set: (key, payload, expected) => {
        writes++;
        return base.set(key, payload, expected);
      },
    })),
  });
  for (const id of ["\ud800", "\udc00"]) {
    const error = failure(await runner.runExit(publishArticle(id)));
    assert(error instanceof InvalidArticle);
    assertEquals(error.field, "id");
  }
  assertEquals({ reads, writes, times }, { reads: 0, writes: 0, times: 0 });
  assertEquals(await read(memory, "kept"), draft("kept"));
  assertEquals(memory.active(), 0);
});

Deno.test("corrupt payload and identity mismatch are typed failures", async () => {
  const malformed = makeMemoryPlatform();
  await Effect.runPromise(malformed.control.set(
    articleKey("broken"),
    Payload.make("{broken"),
    Option.none(),
  ));
  assert(
    failure(
      await makeRunner({ memory: malformed }).runExit(
        publishArticle("broken"),
      ),
    ) instanceof Corrupt,
  );
  const mismatch = makeMemoryPlatform();
  await seed(mismatch, "expected", draft("other"));
  const error = failure(
    await makeRunner({ memory: mismatch }).runExit(publishArticle("expected")),
  );
  assert(error instanceof Corrupt);
  assertEquals(error.reason, "article identity mismatch");
});

Deno.test("published records enforce title, body, and time invariants", async () => {
  const cases = [
    ["title", published("title", { title: " " }), "blank published title"],
    ["body", published("body", { body: "\n" }), "blank published body"],
    ["missing", {
      kind: "published",
      id: "missing",
      revision: 1,
      title: "T",
      body: "B",
    }, "missing publication time"],
    [
      "negative",
      published("negative", { publishedAt: -1 }),
      "negative publication time",
    ],
  ] as const;
  for (const [id, value, reason] of cases) {
    const memory = makeMemoryPlatform();
    await seed(memory, id, value);
    const error = failure(
      await makeRunner({ memory }).runExit(publishArticle(id)),
    );
    assert(error instanceof Corrupt);
    assertEquals(error.reason, reason);
  }
});

Deno.test("a same-revision edit makes the observed token stale", async () => {
  const memory = makeMemoryPlatform();
  await seed(memory, "edited", draft("edited"));
  let reads = 0;
  const layer = wrappedLayer(memory, (base) => ({
    ...base,
    get: (key) =>
      Effect.gen(function* () {
        const found = yield* base.get(key);
        reads++;
        if (reads === 1 && Option.isSome(found)) {
          yield* memory.control.set(
            key,
            payload(draft("edited", { title: "Edited" })),
            Option.some(found.value.version),
          ).pipe(Effect.orDie);
        }
        return found;
      }),
  }));
  const error = failure(
    await makeRunner({ memory, platformLayer: layer }).runExit(
      publishArticle("edited"),
    ),
  );
  assert(error instanceof PublishConflict);
  assertEquals(
    await read(memory, "edited"),
    draft("edited", {
      title: "Edited",
    }),
  );
});

Deno.test("competing publishers both succeed after one conflict", async () => {
  const memory = makeMemoryPlatform();
  await seed(memory, "race", draft("race"));
  const ready = Deferred.makeUnsafe<void>();
  let reads = 0;
  const layer = wrappedLayer(memory, (base) => ({
    ...base,
    get: (key) =>
      Effect.gen(function* () {
        const found = yield* base.get(key);
        const readNumber = ++reads;
        if (readNumber === 2) yield* Deferred.succeed(ready, undefined);
        if (readNumber <= 2) yield* Deferred.await(ready);
        return found;
      }),
  }));
  const runner = makeRunner({ memory, platformLayer: layer });
  const receipts = await runner.run(Effect.all([
    publishArticle("race"),
    publishArticle("race"),
  ], { concurrency: "unbounded" }));
  assertEquals(receipts.map((item) => item.outcome).sort(), [
    "published",
    "settled",
  ]);
  assertEquals(
    (await read(memory, "race") as { revision?: unknown }).revision,
    1,
  );
});

Deno.test("a failed conflict reload preserves its storage cause", async () => {
  const memory = makeMemoryPlatform();
  await seed(memory, "reload", draft("reload"));
  const cause = { operation: "reload" };
  let reads = 0;
  const layer = wrappedLayer(memory, (base) => ({
    ...base,
    get: (key) =>
      Effect.gen(function* () {
        const found = yield* base.get(key);
        reads++;
        if (reads === 1 && Option.isSome(found)) {
          yield* memory.control.set(
            key,
            payload(draft("reload", { title: "Edited" })),
            Option.some(found.value.version),
          ).pipe(Effect.orDie);
          return found;
        }
        return yield* Effect.fail(new PlatformUnavailable({ cause }));
      }),
  }));
  const error = failure(
    await makeRunner({ memory, platformLayer: layer }).runExit(
      publishArticle("reload"),
    ),
  );
  assert(error instanceof StorageUnavailable);
  assertEquals(error.cause, cause);
});

Deno.test("an uncertain committed write is not retried", async () => {
  const memory = makeMemoryPlatform();
  await seed(memory, "uncertain", draft("uncertain"));
  const cause = { operation: "commit" };
  let writes = 0;
  let times = 0;
  const layer = wrappedLayer(memory, (base) => ({
    ...base,
    set: (key, value, expected) =>
      Effect.gen(function* () {
        writes++;
        yield* base.set(key, value, expected);
        return yield* Effect.fail(new WriteUncertain({ cause }));
      }),
  }));
  const runner = makeRunner({
    memory,
    platformLayer: layer,
    nowMillis: () => {
      times++;
      return 42;
    },
  });
  const error = failure(await runner.runExit(publishArticle("uncertain")));
  assert(error instanceof StorageUncertain);
  assertEquals(error.cause, cause);
  assertEquals([writes, times], [1, 1]);
  assertEquals(
    await read(memory, "uncertain"),
    published("uncertain", {
      publishedAt: 42,
    }),
  );
});

Deno.test("serial batch stops before later commands", async () => {
  const memory = makeMemoryPlatform();
  let times = 0;
  await seed(memory, "bad", draft("bad", { title: " " }));
  await seed(memory, "later", draft("later"));
  const runner = makeRunner({
    memory,
    nowMillis: () => {
      times++;
      return 42;
    },
  });
  assert(
    failure(await runner.runExit(publishAll(["bad", "later"]))) instanceof
      InvalidArticle,
  );
  assertEquals(await read(memory, "later"), draft("later"));
  assertEquals(times, 0);
});

Deno.test("memory rejects invalid keys and payloads without writes", async () => {
  const memory = makeMemoryPlatform();
  for (const raw of ["", "\ud800", "\udc00"]) {
    const exit = await Effect.runPromiseExit(
      memory.control.set(Key.make(raw), Payload.make("x"), Option.none()),
    );
    assert(failure(exit) instanceof InvalidKey);
  }
  const badPayload = await Effect.runPromiseExit(memory.control.set(
    Key.make("valid"),
    Payload.make("\ud800"),
    Option.none(),
  ));
  assert(failure(badPayload) instanceof InvalidPayload);
  assert(Option.isNone(
    await Effect.runPromise(
      memory.control.get(Key.make("valid")),
    ),
  ));
  const first = await Effect.runPromise(memory.control.set(
    Key.make("e\u0301"),
    Payload.make("x"),
    Option.none(),
  ));
  const second = await Effect.runPromise(memory.control.set(
    Key.make("é"),
    Payload.make("y"),
    Option.none(),
  ));
  assert(first !== second);
});

Deno.test("memory compares the authoritative token and detaches reads", async () => {
  const memory = makeMemoryPlatform();
  const key = articleKey("cas");
  const first = await Effect.runPromise(
    memory.control.set(key, Payload.make("one"), Option.none()),
  );
  const observed = await Effect.runPromise(memory.control.get(key));
  assert(Option.isSome(observed));
  const second = await Effect.runPromise(
    memory.control.set(key, Payload.make("two"), Option.some(first)),
  );
  const conflict = await Effect.runPromiseExit(
    memory.control.set(key, Payload.make("three"), Option.some(first)),
  );
  assert(failure(conflict) instanceof CompareConflict);
  assertEquals(observed.value, { payload: "one", version: first });
  const current = await Effect.runPromise(memory.control.get(key));
  assert(Option.isSome(current));
  assertEquals(current.value, { payload: "two", version: second });
});
