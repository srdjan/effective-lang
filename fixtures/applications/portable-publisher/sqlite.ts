import { DatabaseSync } from "node:sqlite";
import { Effect, type Layer, Option } from "effect";
import { type PlatformBackend, platformLayer } from "./backend.ts";
import {
  CompareConflict,
  type Entry,
  InvalidKey,
  InvalidPayload,
  type KeyValue,
  Payload,
  type Platform,
  PlatformUnavailable,
  Version,
  WriteUncertain,
} from "./platform.ts";

export interface SqlitePlatform {
  readonly backend: PlatformBackend;
  readonly layer: Layer.Layer<Platform, PlatformUnavailable>;
  readonly active: () => number;
}

const validText = (value: string): boolean => value.isWellFormed();

const isSqliteError = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  typeof cause.code === "string" &&
  cause.code.startsWith("ERR_SQLITE_");

const unavailable = (cause: unknown): PlatformUnavailable =>
  new PlatformUnavailable({ cause });

const rowText = (row: unknown, field: string): string | undefined => {
  if (typeof row !== "object" || row === null || !(field in row)) {
    return undefined;
  }
  const value = Reflect.get(row, field);
  return typeof value === "string" ? value : undefined;
};

export function makeSqlitePlatform(databasePath: string): SqlitePlatform {
  let active = 0;

  const backend: PlatformBackend = {
    acquire: Effect.acquireRelease(
      Effect.suspend(() => {
        let partial: DatabaseSync | undefined;
        try {
          const database = new DatabaseSync(databasePath);
          partial = database;
          database.exec(`
            CREATE TABLE IF NOT EXISTS kv_metadata (
              singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
              sequence TEXT NOT NULL
            ) STRICT;
            INSERT OR IGNORE INTO kv_metadata (singleton, sequence)
            VALUES (1, '0');
            CREATE TABLE IF NOT EXISTS kv_entries (
              key TEXT PRIMARY KEY,
              payload TEXT NOT NULL,
              version TEXT NOT NULL
            ) STRICT;
          `);
          const lease = { open: true };
          active++;

          const operations: KeyValue = {
            get: (key) =>
              Effect.gen(function* () {
                if (key.length === 0 || !validText(key)) {
                  return yield* Effect.fail(new InvalidKey({ key }));
                }
                if (!lease.open) {
                  return yield* Effect.fail(
                    unavailable("SQLite lease is closed"),
                  );
                }
                try {
                  const row = database.prepare(
                    "SELECT payload, version FROM kv_entries WHERE key = ?",
                  ).get(key);
                  if (row === undefined) return Option.none();
                  const payload = rowText(row, "payload");
                  const version = rowText(row, "version");
                  if (payload === undefined || version === undefined) {
                    return yield* Effect.fail(
                      unavailable(new Error("invalid SQLite entry")),
                    );
                  }
                  const entry: Entry = {
                    payload: Payload.make(payload),
                    version: Version.make(version),
                  };
                  return Option.some(entry);
                } catch (cause) {
                  return isSqliteError(cause)
                    ? (yield* Effect.fail(unavailable(cause)))
                    : (yield* Effect.die(cause));
                }
              }),
            set: (key, payload, expected) =>
              Effect.gen(function* () {
                if (key.length === 0 || !validText(key)) {
                  return yield* Effect.fail(new InvalidKey({ key }));
                }
                if (!validText(payload)) {
                  return yield* Effect.fail(new InvalidPayload({}));
                }
                if (!lease.open) {
                  return yield* Effect.fail(
                    unavailable("SQLite lease is closed"),
                  );
                }

                let transactionOpen = false;
                let wrote = false;
                let commitStarted = false;
                try {
                  database.exec("BEGIN IMMEDIATE");
                  transactionOpen = true;
                  const metadata = database.prepare(
                    "SELECT sequence FROM kv_metadata WHERE singleton = 1",
                  ).get();
                  const sequence = rowText(metadata, "sequence");
                  if (
                    sequence === undefined ||
                    !/^(0|[1-9][0-9]*)$/.test(sequence)
                  ) {
                    database.exec("ROLLBACK");
                    transactionOpen = false;
                    return yield* Effect.fail(
                      unavailable(new Error("invalid SQLite sequence")),
                    );
                  }
                  const version = (BigInt(sequence) + 1n).toString();
                  const result = Option.match(expected, {
                    onNone: () =>
                      database.prepare(`
                        INSERT INTO kv_entries (key, payload, version)
                        SELECT ?, ?, ?
                        WHERE NOT EXISTS (
                          SELECT 1 FROM kv_entries WHERE key = ?
                        )
                      `).run(key, payload, version, key),
                    onSome: (current) =>
                      database.prepare(`
                        UPDATE kv_entries SET payload = ?, version = ?
                        WHERE key = ? AND version = ?
                      `).run(payload, version, key, current),
                  });
                  if (result.changes !== 1 && result.changes !== 1n) {
                    database.exec("ROLLBACK");
                    transactionOpen = false;
                    return yield* Effect.fail(new CompareConflict({}));
                  }
                  wrote = true;
                  database.prepare(`
                    UPDATE kv_metadata SET sequence = ? WHERE singleton = 1
                  `).run(version);
                  commitStarted = true;
                  database.exec("COMMIT");
                  transactionOpen = false;
                  return Version.make(version);
                } catch (cause) {
                  let rollbackCause: unknown;
                  if (transactionOpen) {
                    try {
                      database.exec("ROLLBACK");
                    } catch (error) {
                      rollbackCause = error;
                    }
                  }
                  const failure = rollbackCause === undefined
                    ? cause
                    : new AggregateError(
                      [cause, rollbackCause],
                      "SQLite transaction and rollback failed",
                    );
                  if (!isSqliteError(cause)) {
                    return yield* Effect.die(failure);
                  }
                  return commitStarted || (wrote && rollbackCause !== undefined)
                    ? (yield* Effect.fail(
                      new WriteUncertain({ cause: failure }),
                    ))
                    : (yield* Effect.fail(unavailable(failure)));
                }
              }),
          };
          return Effect.succeed({ database, lease, operations });
        } catch (cause) {
          let failure = cause;
          if (partial !== undefined) {
            try {
              partial.close();
            } catch (closeCause) {
              failure = new AggregateError(
                [cause, closeCause],
                "SQLite acquisition and close failed",
              );
            }
          }
          return isSqliteError(cause)
            ? Effect.fail(unavailable(failure))
            : Effect.die(failure);
        }
      }),
      ({ database, lease }) =>
        Effect.sync(() => {
          lease.open = false;
          try {
            database.close();
          } finally {
            active--;
          }
        }),
    ).pipe(Effect.map(({ operations }) => operations)),
  };

  return {
    backend,
    layer: platformLayer(backend),
    active: () => active,
  };
}
