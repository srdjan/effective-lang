import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer, Schema, Stream } from "effect";
import type * as SqlConnection from "effect/sql/SqlConnection";
import { ConnectionError, SqlError, UnknownError } from "effect/sql/SqlError";
import { Runtime } from "./adapter.ts";
import { Catalog, CatalogFailure } from "./contracts.ts";

export interface IntegrationOptions {
  readonly databasePath: string;
  readonly catalogUrl: string;
  /** A test synchronization point after the real INSERT, before row validation. */
  readonly afterWrite?: () => Effect.Effect<void>;
}

const integer = Schema.Finite.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) || "expected a safe integer"
  ),
);
const priceResponse = Schema.Struct({ price: integer });
const sqlFailure = (cause: unknown, operation: string): SqlError =>
  new SqlError({ reason: new UnknownError({ cause, operation }) });

function parameter(value: unknown): SQLInputValue {
  if (
    value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "bigint" || value instanceof Uint8Array
  ) return value;
  throw new TypeError("unsupported SQLite parameter");
}

/** Real loopback HTTP and file-backed SQLite behind the existing host contract. */
export function makeIntegrationDriver(options: IntegrationOptions) {
  const events: string[] = [];
  const active = new Set<DatabaseSync>();
  let leases = 0;
  const acquire = Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new DatabaseSync(options.databasePath);
        active.add(database);
        events.push(`leased:${++leases}`);
        return database;
      },
      catch: (cause) =>
        new SqlError({
          reason: new ConnectionError({ cause, operation: "open" }),
        }),
    }),
    (database) =>
      Effect.sync(() => {
        // Closing is part of the lease finalizer, including failure and interruption.
        try {
          database.close();
        } finally {
          active.delete(database);
          events.push("closed");
        }
      }),
  ).pipe(Effect.map((database): SqlConnection.Connection => {
    const execute: SqlConnection.Connection["execute"] = (
      sql,
      params,
      transformRows,
    ) => {
      const command = sql.toUpperCase();
      const phase = command === "BEGIN" || command === "COMMIT" ||
          command === "ROLLBACK"
        ? command.toLowerCase()
        : "write";
      return Effect.try({
        try: () => {
          events.push(phase);
          const rows = database.prepare(sql).all(...params.map(parameter));
          return transformRows === undefined ? rows : transformRows(rows);
        },
        catch: (cause) => sqlFailure(cause, phase),
      }).pipe(
        Effect.tap(() =>
          phase === "write"
            ? options.afterWrite?.() ?? Effect.void
            : Effect.void
        ),
      );
    };
    const values: SqlConnection.Connection["executeValues"] = (sql, params) =>
      Effect.try({
        try: () => {
          const statement = database.prepare(sql);
          const rows = statement.all(...params.map(parameter));
          return rows.map((row) => Object.values(row));
        },
        catch: (cause) => sqlFailure(cause, "values"),
      });
    return {
      execute,
      executeRaw: (sql, params) => execute(sql, params, undefined),
      executeUnprepared: execute,
      executeValues: values,
      executeValuesUnprepared: values,
      executeStream: (sql, params, transformRows) =>
        Stream.fromEffect(execute(sql, params, transformRows)).pipe(
          Stream.flatMap(Stream.fromIterable),
        ),
    };
  }));
  const runtime = Layer.succeed(Runtime)({
    database: () => Effect.succeed({ acquire }),
  });
  const catalog = Layer.succeed(Catalog)({
    price: (sku) =>
      Effect.tryPromise({
        try: async (signal) => {
          events.push(`quote:${sku}`);
          signal.addEventListener("abort", () => events.push("http:aborted"), {
            once: true,
          });
          const url = new URL("price", options.catalogUrl);
          url.searchParams.set("sku", sku);
          const response = await fetch(url, { signal });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`catalog HTTP ${response.status}`);
          }
          return await response.json();
        },
        catch: () => new CatalogFailure({ sku }),
      }).pipe(
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(priceResponse)(body).pipe(
            Effect.mapError(() => new CatalogFailure({ sku })),
          )
        ),
        Effect.map((body) => body.price),
      ),
  });
  return {
    layer: Layer.merge(runtime, catalog),
    active,
    events,
    get leases() {
      return leases;
    },
  };
}
