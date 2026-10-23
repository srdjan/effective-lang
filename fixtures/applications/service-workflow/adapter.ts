import { Cause, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import * as Statement from "effect/sql/Statement";
import * as Reactivity from "effect/reactivity/Reactivity";
import { type Order, Store, StoreFailure } from "./contracts.ts";
import { Runtime } from "./host.effi.ts";

export interface Backend {
  readonly acquire: SqlConnection.Acquirer;
}

// Map each typed reason without discarding a simultaneous cleanup defect.
const translate = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  map: (error: E) => StoreFailure,
): Effect.Effect<A, StoreFailure, R> =>
  Effect.catchCause(effect, (cause) => Effect.failCause(Cause.map(cause, map)));
const integer = Schema.Finite.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) || "expected a safe integer"
  ),
);
const receipts = Schema.NonEmptyArray(
  Schema.Struct({ sku: Schema.String, quantity: integer, total: integer }),
);

export const StoreLive: Layer.Layer<Store, StoreFailure, Runtime> = Layer
  .effect(Store)(Effect.gen(function* () {
    const backend = yield* translate(
      Runtime.use((runtime) => runtime.database()),
      () => new StoreFailure({ kind: "Permanent", stage: "provider" }),
    );
    const sql = yield* SqlClient.make({
      acquirer: backend.acquire,
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer));
    return {
      save: (order: Order) =>
        translate(
          sql.withTransaction(Effect.gen(function* () {
            // Classification happens here so a COMMIT error cannot masquerade as a write failure.
            const rows = yield* translate(
              sql`insert into orders (sku, quantity, total) values (${order.sku}, ${order.quantity}, ${order.total}) returning sku, quantity, total`,
              (error) =>
                new StoreFailure({
                  kind: error.isRetryable ? "Transient" : "Permanent",
                  stage: "write",
                }),
            );
            const parsed = yield* translate(
              Schema.decodeUnknownEffect(receipts)(rows),
              () => new StoreFailure({ kind: "Permanent", stage: "row" }),
            );
            return parsed[0];
          })),
          (error) =>
            error instanceof StoreFailure ? error : new StoreFailure({
              kind: "Permanent",
              stage: error.reason.operation ?? "transaction",
            }),
        ),
    };
  }));
