import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals } from "@std/assert";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { CatalogFailure, InvalidOrder, StoreFailure } from "./contracts.ts";
import { makeIntegrationDriver } from "./integration_driver.ts";
import { submit } from "./workflow.ts";

const request = { sku: "book", quantity: 2 };
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.timeout("5 seconds")));
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value;
};

interface Fixture {
  readonly databasePath: string;
  readonly catalogUrl: string;
  readonly requests: URL[];
  readonly rows: () => unknown[];
}
async function withFixture(
  body: (fixture: Fixture) => Promise<void>,
  options: {
    readonly handler?: (request: Request) => Response | Promise<Response>;
    readonly columns?: string;
  } = {},
) {
  // cwd is the isolated directory supplied by the outer slow-test harness.
  const dir = await Deno.makeTempDir({ dir: ".", prefix: "sqlite-" });
  const databasePath = `${Deno.cwd()}/${dir}/orders.sqlite`;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`create table orders (${
      options.columns ??
        "sku TEXT NOT NULL, quantity INTEGER NOT NULL, total INTEGER NOT NULL"
    })`);
  } finally {
    database.close();
  }
  const requests: URL[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => {
    requests.push(new URL(request.url));
    return options.handler?.(request) ?? Response.json({ price: 12 });
  });
  try {
    await body({
      databasePath,
      catalogUrl: `http://127.0.0.1:${server.addr.port}/`,
      requests,
      rows: () => {
        // Reopen the file independently; no recording-driver state is consulted.
        const reopened = new DatabaseSync(databasePath);
        try {
          return reopened.prepare("select sku, quantity, total from orders")
            .all().map((row) => ({ ...row }));
        } finally {
          reopened.close();
        }
      },
    });
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("HTTP/SQLite workflow persists bound values and closes the leased connection", async () => {
  await withFixture(async (fixture) => {
    const driver = makeIntegrationDriver(fixture);
    const input = { sku: "book' ; -- / ?", quantity: 2 };
    const expected = { ...input, total: 24 };
    assertEquals(
      await run(submit(input).pipe(Effect.provide(driver.layer))),
      expected,
    );
    assertEquals(fixture.rows(), [expected]);
    assertEquals(fixture.requests[0]?.pathname, "/price");
    assertEquals(fixture.requests[0]?.searchParams.get("sku"), input.sku);
    assertEquals(driver.events, [
      `quote:${input.sku}`,
      "leased:1",
      "begin",
      "write",
      "commit",
      "closed",
    ]);
    assertEquals(driver.active.size, 0);
  });
});

Deno.test("HTTP/SQLite invalid schema and domain input performs no external calls", async () => {
  await withFixture(async (fixture) => {
    const driver = makeIntegrationDriver(fixture);
    for (const input of [{}, { sku: "book", quantity: 1.5 }]) {
      const error = failure(
        await run(Effect.exit(
          submit(input).pipe(Effect.provide(driver.layer)),
        )),
      );
      assert(error instanceof Schema.SchemaError);
    }
    for (
      const input of [{ sku: "", quantity: 2 }, { sku: "book", quantity: 0 }]
    ) {
      const error = failure(
        await run(Effect.exit(
          submit(input).pipe(Effect.provide(driver.layer)),
        )),
      );
      assert(error instanceof InvalidOrder);
    }
    assertEquals([fixture.requests.length, driver.leases, driver.active.size], [
      0,
      0,
      0,
    ]);
    assertEquals(fixture.rows(), []);
  });
});

Deno.test("HTTP/SQLite rejects malformed, non-success and invalid catalog responses before storage", async () => {
  const responses = [
    () =>
      new Response("{broken", {
        headers: { "content-type": "application/json" },
      }),
    () => new Response("unavailable", { status: 503 }),
    () => Response.json({ price: "12" }),
    () => Response.json({ price: 1.5 }),
    () => Response.json({ price: -1 }),
    () => Response.json({ price: 100001 }),
  ];
  for (const [index, response] of responses.entries()) {
    await withFixture(async (fixture) => {
      const driver = makeIntegrationDriver(fixture);
      const error = failure(
        await run(Effect.exit(
          submit(request).pipe(Effect.provide(driver.layer)),
        )),
      );
      assert(
        index < 4
          ? error instanceof CatalogFailure
          : error instanceof InvalidOrder,
      );
      assertEquals(
        [fixture.requests.length, driver.leases, driver.active.size],
        [1, 0, 0],
      );
      assertEquals(fixture.rows(), []);
    }, { handler: response });
  }
});

Deno.test("HTTP/SQLite permanent CHECK failure rolls back without retry and closes the connection", async () => {
  await withFixture(async (fixture) => {
    const driver = makeIntegrationDriver(fixture);
    const error = failure(
      await run(Effect.exit(
        submit(request).pipe(Effect.provide(driver.layer)),
      )),
    );
    assert(error instanceof StoreFailure);
    assertEquals([error.kind, error.stage], ["Permanent", "write"]);
    assertEquals(driver.leases, 1);
    assertEquals(driver.events.slice(-3), ["write", "rollback", "closed"]);
    assertEquals(driver.active.size, 0);
    assertEquals(fixture.rows(), []);
  }, {
    columns: "sku TEXT, quantity INTEGER CHECK(quantity < 2), total INTEGER",
  });
});

Deno.test("HTTP/SQLite invalid returned row rolls back an actual inserted row", async () => {
  let inserted = false;
  await withFixture(async (fixture) => {
    const driver = makeIntegrationDriver({
      ...fixture,
      afterWrite: () =>
        Effect.sync(() => {
          inserted = true;
        }),
    });
    const error = failure(
      await run(Effect.exit(
        submit(request).pipe(Effect.provide(driver.layer)),
      )),
    );
    assert(error instanceof StoreFailure);
    assertEquals([error.kind, error.stage], ["Permanent", "row"]);
    assert(inserted);
    assertEquals(driver.events.slice(-3), ["write", "rollback", "closed"]);
    assertEquals([driver.leases, driver.active.size], [1, 0]);
    assertEquals(fixture.rows(), []);
    // SQLite's TEXT affinity returns "24" after insertion, rejected by StoreLive.
  }, { columns: "sku TEXT, quantity INTEGER, total TEXT" });
});

Deno.test("HTTP/SQLite cancellation aborts a known pending catalog request without acquiring storage", async () => {
  const entered = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<Response>();
  await withFixture(async (fixture) => {
    const driver = makeIntegrationDriver(fixture);
    try {
      await run(Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          submit(request).pipe(Effect.provide(driver.layer)),
        );
        yield* Effect.promise(() => entered.promise);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
        assert(driver.events.includes("http:aborted"));
        assertEquals([
          fixture.requests.length,
          driver.leases,
          driver.active.size,
        ], [1, 0, 0]);
        assertEquals(fixture.rows(), []);
      }));
    } finally {
      // Release the server handler even when an assertion fails; shutdown joins it.
      respond.resolve(Response.json({ price: 12 }));
    }
  }, {
    handler: () => {
      entered.resolve();
      return respond.promise;
    },
  });
});

Deno.test("HTTP/SQLite cancellation after a real INSERT awaits rollback and connection close", async () => {
  await withFixture(async (fixture) => {
    const inserted = Deferred.makeUnsafe<void>();
    const driver = makeIntegrationDriver({
      ...fixture,
      afterWrite: () =>
        Deferred.succeed(inserted, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
    });
    await run(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        submit(request).pipe(Effect.provide(driver.layer)),
      );
      yield* Deferred.await(inserted);
      assertEquals(driver.active.size, 1);
      // A second connection sees no uncommitted row while the transaction is open.
      assertEquals(fixture.rows(), []);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assertEquals(driver.events.slice(-3), ["write", "rollback", "closed"]);
      assertEquals([driver.leases, driver.active.size], [1, 0]);
      assertEquals(fixture.rows(), []);
    }));
  });
});
