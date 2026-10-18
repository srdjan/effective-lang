// This host module is copied next to emitted contracts.ts by source_slow_test.ts.
import { Context, Deferred, Effect, Layer, Metric, Schema, Stream } from "effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import * as Statement from "effect/sql/Statement";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as AiResponse from "effect/ai/Response";
import { AdapterError, Operations, Policy } from "./contracts.ts";

export const api = HttpApi.make("audit").add(HttpApiGroup.make("numbers").add(
  HttpApiEndpoint.get("read", "/number", { success: Schema.Int }),
));
export const procedure = Rpc.make("increment", {
  payload: { n: Schema.Int }, success: Schema.Int,
});
export const sqlTrace: string[] = [];
export const sqlParameters: ReadonlyArray<unknown>[] = [];
export const sqlReady = Deferred.makeUnsafe<void>();
export const cursorReady = Deferred.makeUnsafe<void>();
export let cursorCloses = 0;
export let lookups = 0;

const translate = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new AdapterError({ operation })));

const execute = (sql: string, params: ReadonlyArray<unknown>) => Effect.sync(() => {
  sqlTrace.push(sql);
  sqlParameters.push(params);
  return sql.startsWith("select") ? [{ n: params[0] }] : [];
});
const connection: SqlConnection.Connection = {
  execute, executeRaw: execute, executeUnprepared: execute,
  executeValues: () => Effect.succeed([]),
  executeValuesUnprepared: () => Effect.succeed([]),
  executeStream: (sql, params) => Stream.fromEffect(execute(sql, params)).pipe(Stream.flatMap(Stream.fromIterable)),
};

const sqlOperation = (mode: string) => translate("sql", Effect.gen(function* () {
  const sql = yield* SqlClient.make({
    acquirer: Effect.acquireRelease(
      Effect.sync(() => { sqlTrace.push("lease"); return connection; }),
      () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { sqlTrace.push("release"); }))),
    ),
    compiler: Statement.makeCompilerSqlite(), spanAttributes: [],
  });
  return yield* sql.withTransaction(Effect.gen(function* () {
    const rows = yield* sql`select ${7} as n`;
    const parsed = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })))(rows);
    if (mode === "fail") return yield* Effect.fail(new AdapterError({ operation: "sql-body" }));
    if (mode === "wait") {
      yield* Deferred.succeed(sqlReady, undefined);
      return yield* Effect.never;
    }
    return parsed[0]!.n;
  }));
}).pipe(Effect.provide(Reactivity.layer)));

const counter = Metric.counter("schema_adapter_audit_calls");

export const AdapterLive: Layer.Layer<Operations, AdapterError, Policy> = Layer.effect(Operations)(Effect.gen(function* () {
  yield* Policy.use((policy) => policy.allow());
  const model = yield* LanguageModel.make({
    generateText: () => Effect.succeed([AiResponse.makePart("text", { text: "local model" })]),
    streamText: () => Stream.empty,
  });
  return {
    lookup: (value: number) => Effect.suspend(() => {
      lookups++;
      return value < 0 ? Effect.fail(new AdapterError({ operation: "lookup" })) : Effect.succeed(value + 10);
    }),
    http: (body: string) => translate("http", HttpClientResponse.schemaJson(
      Schema.Struct({ body: Schema.Struct({ n: Schema.Int }) }),
    )(HttpClientResponse.fromWeb(HttpClientRequest.get("https://audit.invalid/number"), new Response(body, {
      headers: { "content-type": "application/json" },
    }))).pipe(Effect.map((response) => response.body.n))),
    sql: sqlOperation,
    rpc: (body: string) => translate("rpc", Effect.try(() => RpcSerialization.makeNdjson().makeUnsafe().decode(body)).pipe(
      Effect.flatMap((messages) => Schema.decodeUnknownEffect(Schema.Array(procedure.payloadSchema))(messages)),
      Effect.flatMap((messages) => Schema.decodeUnknownEffect(procedure.successSchema)((messages[0]?.n ?? 0) + 1)),
    )),
    ai: (prompt: string) => translate("ai", LanguageModel.generateText({ prompt }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model), Effect.map((response) => response.text),
    )),
    metric: () => Metric.update(counter, 1).pipe(Effect.andThen(Metric.value(counter)), Effect.map((state) => state.count)),
  };
}));

export type Session = { readonly parser: RpcSerialization.Parser; closed: boolean };
export class Cursor extends Context.Service<Cursor, {
  readonly open: () => Effect.Effect<Session>;
  readonly push: (session: Session, chunk: string) => Effect.Effect<number, AdapterError>;
  readonly close: (session: Session) => Effect.Effect<void>;
}>()("adapter#Cursor") {}

export const CursorLive = Layer.succeed(Cursor)({
  open: () => Effect.sync(() => ({ parser: RpcSerialization.makeNdjson({ maxBufferSize: 64 }).makeUnsafe(), closed: false })),
  push: (session, chunk) => Effect.suspend(() => {
    if (session.closed) return Effect.fail(new AdapterError({ operation: "closed" }));
    if (chunk === "wait") return Deferred.succeed(cursorReady, undefined).pipe(Effect.andThen(Effect.never));
    return translate("cursor", Effect.try(() => session.parser.decode(chunk).length));
  }),
  close: (session) => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
    session.closed = true;
    cursorCloses++;
  }))),
});
