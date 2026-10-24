import { Effect, Layer, Option } from "effect";
import { type Book, BookId, Shelf } from "./library.ts";
import { checkout, Ledger } from "./loans.ts";

const books = new Map<string, Book>([
  ["b1", { id: BookId.make("b1"), title: "Dune", copies: 2 }],
  ["b2", { id: BookId.make("b2"), title: "Emma", copies: 0 }],
]);

const ShelfInMemory = Layer.succeed(Shelf)({
  find: (id) => Effect.sync(() => Option.fromNullishOr(books.get(id))),
  all: () => Effect.sync(() => [...books.values()]),
  save: (book) =>
    Effect.sync(() => {
      books.set(book.id, book);
    }),
});

const lines: string[] = [];

const LedgerInMemory = Layer.succeed(Ledger)({
  open: () => Effect.succeed(1),
  write: (_id, line) =>
    Effect.sync(() => {
      lines.push(`lent ${line}`);
    }),
  close: () =>
    Effect.sync(() => {
      lines.push("closed");
    }),
});

const program = Effect.gen(function* () {
  const dune = yield* checkout(BookId.make("b1"));
  const emma = yield* checkout(BookId.make("b2")).pipe(
    Effect.map((book) => book.title),
    Effect.catchTag(
      "library#NoCopies",
      (error) => Effect.succeed(`no copies of ${error.id}`),
    ),
  );
  return { dune: dune.copies, emma, lines };
});

const report = await Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(ShelfInMemory, LedgerInMemory))),
);
console.log(JSON.stringify(report));
