import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { type PlatformBackend, platformLayer } from "./backend.ts";
import { InvalidArticle } from "./domain.ts";
import {
  type KeyValueContractFixture,
  registerKeyValueContract,
} from "./kv_contract.ts";
import { makeMemoryPlatform } from "./memory.ts";
import {
  CompareConflict,
  Key,
  type KeyValue,
  Payload,
  PlatformUnavailable,
  WriteUncertain,
} from "./platform.ts";
import { StorageUncertain } from "./ports.ts";
import { publishArticle } from "./publisher.ts";
import { makeRunner } from "./runner.ts";
import { makeSqlitePlatform, type SqlitePlatform } from "./sqlite.ts";
import { storedArticleSchema } from "./storage.ts";

const sqliteFixture = (): KeyValueContractFixture => {
  const directory = Deno.makeTempDirSync({
    dir: Deno.cwd(),
    prefix: "publisher-kv-",
  });
  return {
    platform: makeSqlitePlatform(`${directory}/store.sqlite`),
    cleanup: () => Deno.removeSync(directory, { recursive: true }),
  };
};

registerKeyValueContract("memory", () => ({
  platform: makeMemoryPlatform(),
}));
registerKeyValueContract("SQLite", sqliteFixture);

const errorOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value;
};

const withDatabase = async (
  use: (databasePath: string) => Promise<void>,
): Promise<void> => {
  const directory = Deno.makeTempDirSync({
    dir: Deno.cwd(),
    prefix: "publisher-sqlite-",
  });
  try {
    await use(`${directory}/publisher.sqlite`);
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
};

const withStore = <A, E>(
  platform: SqlitePlatform,
  use: (store: KeyValue) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* platform.backend.acquire;
        return yield* use(store);
      }),
    ),
  );

const draftPayload = Payload.make(JSON.stringify({
  kind: "draft",
  id: "a",
  revision: 0,
  title: "Portable publishing",
  body: "One source workflow",
}));

Deno.test("one generated publisher runs unchanged against memory and SQLite", async () => {
  await withDatabase(async (databasePath) => {
    const results: unknown[] = [];
    for (
      const platform of [makeMemoryPlatform(), makeSqlitePlatform(databasePath)]
    ) {
      const key = Key.make("articles/a");
      await withStore(
        platform,
        (store) => store.set(key, draftPayload, Option.none()),
      );
      let times = 0;
      const runner = makeRunner({
        platformLayer: platform.layer,
        nowMillis: () => {
          times++;
          return 42;
        },
      });
      const receipt = await runner.run(publishArticle("a"));
      for (const id of ["\ud800", "\udc00"]) {
        const error = errorOf(await runner.runExit(publishArticle(id)));
        assert(error instanceof InvalidArticle);
        assertEquals(error.field, "id");
      }
      const entry = await withStore(platform, (store) => store.get(key));
      assert(Option.isSome(entry));
      const article = Schema.decodeUnknownOption(storedArticleSchema)(
        JSON.parse(entry.value.payload) as unknown,
      );
      assert(Option.isSome(article));
      results.push({ receipt, article: article.value });
      assertEquals(times, 1);
      assertEquals(platform.active(), 0);
    }
    assertEquals(results[0], results[1]);
  });
});

Deno.test("a second SQLite lease invalidates the first lease's observed token", async () => {
  await withDatabase(async (databasePath) => {
    const platform = makeSqlitePlatform(databasePath);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const first = yield* platform.backend.acquire;
      const second = yield* platform.backend.acquire;
      const key = Key.make("shared");
      const initial = yield* first.set(
        key,
        Payload.make("initial"),
        Option.none(),
      );
      const observed = yield* second.get(key);
      assert(Option.isSome(observed));
      assertEquals(observed.value.version, initial);
      const replacement = yield* second.set(
        key,
        Payload.make("replacement"),
        Option.some(observed.value.version),
      );
      const refused = yield* Effect.exit(
        first.set(key, Payload.make("stale"), Option.some(initial)),
      );
      assert(errorOf(refused) instanceof CompareConflict);
      const current = yield* first.get(key);
      assert(Option.isSome(current));
      assertEquals(current.value, {
        payload: Payload.make("replacement"),
        version: replacement,
      });
    })));
    assertEquals(platform.active(), 0);
  });
});

Deno.test("SQLite open failure preserves its cause and leaves no active lease", async () => {
  await withDatabase(async (databasePath) => {
    const platform = makeSqlitePlatform(`${databasePath}/missing/store.sqlite`);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(platform.backend.acquire),
    );
    const error = errorOf(exit);
    assert(error instanceof PlatformUnavailable);
    assert(error.cause instanceof Error);
    assertEquals(platform.active(), 0);
  });
});

Deno.test({
  name:
    "SQLite publisher persists an article and its version across independent leases",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    await withDatabase(async (databasePath) => {
      const key = Key.make("articles/a");
      const seedPlatform = makeSqlitePlatform(databasePath);
      const seedVersion = await withStore(
        seedPlatform,
        (store) => store.set(key, draftPayload, Option.none()),
      );
      assertEquals(seedPlatform.active(), 0);

      const publishedAt = 1700000000123;
      const publisherPlatform = makeSqlitePlatform(databasePath);
      const runner = makeRunner({
        platformLayer: publisherPlatform.layer,
        nowMillis: () => publishedAt,
      });
      assertEquals(await runner.run(publishArticle("a")), {
        id: "a",
        revision: 1,
        outcome: "published",
      });
      assertEquals(publisherPlatform.active(), 0);

      const reopened = makeSqlitePlatform(databasePath);
      const persisted = await withStore(reopened, (store) => store.get(key));
      assert(Option.isSome(persisted));
      assertNotEquals(persisted.value.version, seedVersion);
      const decoded = Schema.decodeUnknownOption(storedArticleSchema)(
        JSON.parse(persisted.value.payload) as unknown,
      );
      assert(Option.isSome(decoded));
      assertEquals(decoded.value, {
        kind: "published",
        id: "a",
        revision: 1,
        title: "Portable publishing",
        body: "One source workflow",
        publishedAt,
      });
      assertEquals(reopened.active(), 0);
    });
  },
});

Deno.test({
  name:
    "simulated lost acknowledgement reports uncertainty without retrying the committed write",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    await withDatabase(async (databasePath) => {
      const key = Key.make("articles/a");
      const sqlite = makeSqlitePlatform(databasePath);
      await withStore(
        sqlite,
        (store) => store.set(key, draftPayload, Option.none()),
      );

      let writes = 0;
      const uncertainBackend: PlatformBackend = {
        acquire: sqlite.backend.acquire.pipe(
          Effect.map((store): KeyValue => ({
            get: (requested) => store.get(requested),
            set: (requested, payload, expected) =>
              Effect.gen(function* () {
                writes++;
                yield* store.set(
                  requested,
                  payload,
                  expected,
                );
                return yield* Effect.fail(
                  new WriteUncertain({
                    cause: "simulated lost acknowledgement after commit",
                  }),
                );
              }),
          })),
        ),
      };
      const runner = makeRunner({
        platformLayer: platformLayer(uncertainBackend),
        nowMillis: () => 1700000000456,
      });
      const exit = await runner.runExit(publishArticle("a"));
      assert(errorOf(exit) instanceof StorageUncertain);
      assertEquals(writes, 1);
      assertEquals(sqlite.active(), 0);

      const reopened = makeSqlitePlatform(databasePath);
      const persisted = await withStore(reopened, (store) => store.get(key));
      assert(Option.isSome(persisted));
      const decoded = Schema.decodeUnknownOption(storedArticleSchema)(
        JSON.parse(persisted.value.payload) as unknown,
      );
      assert(Option.isSome(decoded));
      assertEquals(decoded.value.kind, "published");
      assertEquals(decoded.value.revision, 1);
      assertEquals(decoded.value.publishedAt, 1700000000456);
      assertEquals(reopened.active(), 0);
    });
  },
});
