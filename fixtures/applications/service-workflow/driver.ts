import { Cause, Effect, Layer, Schema, Stream } from "effect";
import type * as SqlConnection from "effect/sql/SqlConnection";
import {
  ConnectionError,
  ConstraintError,
  SqlError,
} from "effect/sql/SqlError";
import { type Backend, Runtime } from "./adapter.ts";
import {
  Catalog,
  CatalogFailure,
  type Receipt,
  type StoreFailure,
} from "./contracts.ts";

export type Phase = "begin" | "write" | "commit" | "rollback";
export interface DriverOptions {
  readonly connect?: () => Effect.Effect<void, StoreFailure>;
  readonly price?: (sku: string) => Effect.Effect<number, CatalogFailure>;
  readonly lease?: (id: number) => Effect.Effect<void, SqlError>;
  readonly execute?: (
    phase: Phase,
    id: number,
  ) => Effect.Effect<void, SqlError>;
  readonly release?: (id: number) => Effect.Effect<void>;
  readonly rows?: (receipt: Receipt) => ReadonlyArray<unknown>;
}
export const sqlFailure = (retryable: boolean, operation: string): SqlError =>
  new SqlError({
    reason: retryable
      ? new ConnectionError({ cause: "busy", operation })
      : new ConstraintError({ cause: "rejected", operation }),
  });
const integer = Schema.Finite.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) || "expected a safe integer"
  ),
);

/** One recording SQL statement shape; this driver performs no external I/O. */
export function makeDriver(options: DriverOptions = {}) {
  const events: string[] = [];
  const active = new Set<number>();
  const staged = new Map<number, ReadonlyArray<Receipt>>();
  const committed: Receipt[] = [];
  const statements: { sql: string; params: ReadonlyArray<unknown> }[] = [];
  let leases = 0;
  const acquire = Effect.acquireRelease(
    Effect.gen(function* () {
      const id = ++leases;
      events.push(`lease:${id}`);
      yield* options.lease?.(id) ?? Effect.void;
      active.add(id);
      events.push(`leased:${id}`);
      let pending: Receipt[] = [];
      const execute = (
        sql: string,
        params: ReadonlyArray<unknown>,
      ): Effect.Effect<ReadonlyArray<unknown>, SqlError> =>
        Effect.gen(function* () {
          const command = sql.toUpperCase();
          const phase: Phase = command === "BEGIN"
            ? "begin"
            : command === "COMMIT"
            ? "commit"
            : command === "ROLLBACK"
            ? "rollback"
            : "write";
          events.push(`${phase}:${id}`);
          let receipt: Receipt | undefined;
          if (phase === "write") {
            statements.push({ sql, params: [...params] });
            const [sku, quantity, total] = params;
            if (
              !command.startsWith("INSERT INTO ORDERS ") ||
              typeof sku !== "string" || typeof quantity !== "number" ||
              typeof total !== "number"
            ) return yield* Effect.fail(sqlFailure(false, "write"));
            receipt = { sku, quantity, total };
            pending.push(receipt);
            staged.set(id, [...pending]);
          }
          yield* options.execute?.(phase, id) ?? Effect.void;
          if (phase === "commit") {
            committed.push(...pending);
            pending = [];
            staged.delete(id);
          }
          if (phase === "rollback") {
            pending = [];
            staged.delete(id);
          }
          return receipt === undefined
            ? []
            : options.rows?.(receipt) ?? [receipt];
        });
      const connection: SqlConnection.Connection = {
        execute,
        executeRaw: execute,
        executeUnprepared: execute,
        executeValues: () => Effect.succeed([]),
        executeValuesUnprepared: () => Effect.succeed([]),
        executeStream: (sql, params) =>
          Stream.fromEffect(execute(sql, params)).pipe(
            Stream.flatMap(Stream.fromIterable),
          ),
      };
      return { id, connection };
    }),
    ({ id }) =>
      Effect.suspend(() => {
        events.push(`release:${id}`);
        return (options.release?.(id) ?? Effect.void).pipe(
          Effect.ensuring(Effect.sync(() => {
            staged.delete(id);
            active.delete(id);
            events.push(`released:${id}`);
          })),
        );
      }),
  ).pipe(Effect.map(({ connection }) => connection));
  const backend: Backend = { acquire };
  const runtime = Layer.succeed(Runtime)({
    database: () =>
      Effect.suspend(() => {
        events.push("connect");
        return (options.connect?.() ?? Effect.void).pipe(Effect.as(backend));
      }),
  });
  const catalog = Layer.succeed(Catalog)({
    price: (sku) =>
      Effect.suspend(() => {
        events.push(`quote:${sku}`);
        const result = (options.price?.(sku) ?? Effect.succeed(12)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(integer)),
        );
        return Effect.catchCause(result, (cause) =>
          Effect.failCause(Cause.map(cause, () =>
            new CatalogFailure({ sku }))));
      }),
  });
  return {
    layer: Layer.merge(runtime, catalog),
    events,
    active,
    staged,
    committed,
    statements,
    get leases() {
      return leases;
    },
  };
}
