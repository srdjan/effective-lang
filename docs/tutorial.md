# Tutorial: build a small library application

This tutorial shows how to write an Effektive application and run it as Effect-TS. You build a book lending service in two source modules. Then you supply the services from TypeScript and run the program.

The complete project is in [fixtures/tutorial/](../fixtures/tutorial/). Tests check the code blocks against that project, reproduce the Step 7 diagnostic, and build and run the completed program.

## Before you start

You need Deno 2.9.8. The generated TypeScript uses Effect 4.0.5. The first `--tsc` build downloads Effect from npm, so it needs network access once.

Run all shell commands from the repository root in the same shell. The commands use `deno task effektive`. If you installed the command-line tool (see [installation.md](installation.md)), use `effektive` in place of `deno task effektive`.

## Step 1: create the project

A project is a directory with an `effektive.json` file. Create a temporary directory for your work and print its path:

```sh
tutorial_dir=$(mktemp -d)
echo "$tutorial_dir"
```

Create all tutorial files in this directory. Keep the shell open so later commands can use `$tutorial_dir`. The completed project will contain:

```text
effektive.json
deno.json
library.eff
loans.eff
main.ts
```

Create `$tutorial_dir/effektive.json`. This project needs no settings:

```json
{}
```

The generated modules are ordinary TypeScript files that import `effect`. Create `$tutorial_dir/deno.json` to map `effect` to a fixed version. The compiler emits code for strict type checking, so keep the strict options:

```json
{
  "imports": {
    "effect": "npm:effect@4.0.5"
  },
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  }
}
```

## Step 2: declare the domain

Create `library.eff`. Start with the types:

```eff
export type Title = string
export type Count = int

export nominal BookId = string

export type Book = {
  id: BookId,
  title: Title,
  copies: Count
}
```

A `type` declaration gives a name to a type. The names `string`, `int`, `number`, and `boolean` can occur only inside a `type`, `nominal`, or `error` declaration. A parameter or a field uses a declared name, such as `Title` or `Count`. Thus each value in a contract has a domain name.

A `nominal` type is a new type with its own identity. A `string` does not fit `BookId`, and a `BookId` does not fit another nominal type over `string`. A `BookId` still fits where a `string` is necessary.

Next, declare the errors and the service:

```eff
export error BookMissing = { id: BookId }
export error NoCopies = { id: BookId }
export error StoreDown = { message: string }

export service Shelf {
  find(id: BookId): Option<Book> fails StoreDown
  all(): Book[] fails StoreDown
  save(book: Book): void fails StoreDown
}
```

An `error` is a typed failure with fields. A `service` lists operations that the host supplies at run time. Each operation gives its own failures with `fails`. The source code calls a service operation, but it does not implement the operation.

## Step 3: write a pure function

Add a function that returns the titles of the books with copies:

```eff
export const inStock = (books: Book[]): Title[] =>
  books
    |> filter(book => book.copies > 0)
    |> map(book => book.title)
```

The `|>` operator gives the value on its left to the stage on its right. `filter` and `map` need pure callbacks. A pure callback has no failures, calls no services, and performs no effectful operations. Empty `fails` and `uses` sets alone do not make a callback pure.

The callback `book => book.copies > 0` has one parameter without parentheses. This form is correct for one parameter without a type annotation. The compiler gets the type of `book` from `filter`. A parameter with an annotation, or two or more parameters, needs parentheses, as in `(sum, amount) => sum + amount`.

An exported function writes its parameter types and its result type. Other modules use this contract, so the compiler does not infer it.

## Step 4: call a service

Add a function that finds a book or fails:

```eff
export const findBook = (id: BookId): Book
  fails BookMissing | StoreDown
  uses Shelf.find =>
  Shelf.find(id) ?? fail(BookMissing({ id }))
```

The contract has three parts. The result is `Book`. The `fails` clause lists every error that the function can fail with. The `uses` clause lists every service operation that the function needs. An exported function must write each clause that is not empty. The compiler compares each clause with the body.

`Shelf.find` returns an `Option<Book>`. The `??` operator gives the value in `Some`. For `None`, it evaluates the expression on its right. Here, that expression is `fail(BookMissing({ id }))`, so the function fails with `BookMissing`. The right side runs only for `None`. `{ id }` is the short form of `{ id: id }`.

## Step 5: recover from an error

Add a function that gives a default title when the book is missing:

```eff
export const titleOf = (id: BookId): Title
  fails StoreDown
  uses Shelf.find =>
  try {
    findBook(id).title
  } catch {
    BookMissing(missing) => "Unknown"
  }
```

The `catch` block handles `BookMissing`, so `BookMissing` is not in the `fails` clause of `titleOf`. `StoreDown` has no handler, so it stays in the clause.

## Step 6: use a local helper

Add a helper that is not exported, and a function that uses it:

```eff
const takeCopy = (book: Book) => {
  const { id, copies } = book
  if (copies <= 0) { fail(NoCopies({ id })) } else {}
  { ...book, copies: copies - 1 }
}

export const lend = (id: BookId): Book
  fails BookMissing | NoCopies | StoreDown
  uses Shelf.find | Shelf.save => {
  const lent = findBook(id) |> takeCopy
  Shelf.save(lent)
  lent
}
```

`takeCopy` is not exported, so it needs no result type, no `fails` clause, and no `uses` clause. The compiler infers that it returns a `Book` and can fail with `NoCopies`.

`Count = int` permits negative values, so the guard rejects both zero and negative inventory.

`const { id, copies } = book` reads two fields of `book` into two local names. This record destructuring is legal only inside a block. To use another local name, write `copies: left`.

`{ ...book, copies: copies - 1 }` makes a copy of `book` with a new `copies` value. The last expression of a block is its result.

## Step 7: read a contract error

The compiler compares each contract with its body. To see this check, remove `Shelf.save` from the `uses` clause of `lend`, and check the project:

```sh
deno task effektive check "$tutorial_dir"
```

The compiler reports the operation that the clause does not list:

```text
library.eff:49:22: error requirement-contract/001: the body requires Shelf.save, which the `uses` clause does not list
1 module, 1 diagnostic
```

Put `Shelf.save` back before you continue.

## Step 8: manage a resource

Create a second module, `loans.eff`. It records each loan in a ledger. The ledger must close after each write, also when the write fails:

```eff
import { Book, BookId, BookMissing, NoCopies, StoreDown, Shelf, lend } from "./library.eff"

export type Line = string
export type LedgerId = int

export service Ledger {
  open(): LedgerId
  write(id: LedgerId, line: Line): void
  close(id: LedgerId): void
}
```

An `import` names each declaration that the module uses from another module. Only exported declarations can be imported.

Next, add the function that writes to the ledger:

```eff
const record = (book: Book) =>
  using (ledger = {
      const id = Ledger.open()
      {
        write: () => Ledger.write(id, book.title),
        close: () => Ledger.close(id)
      }
    }) {
    ledger.write()
  } finally {
    ledger.close()
  }
```

A `using` expression has three parts:

1. The acquisition after `=` opens the ledger. It returns a record of operations.
2. The block after `)` uses the resource. The value of this block is the value of the `using` expression.
3. Once acquisition succeeds, the `finally` block releases the resource when the use block succeeds, fails, or is interrupted. If acquisition fails, neither the use block nor the `finally` block runs.

The name `ledger` is visible only in the use block and in the `finally` block. The compiler does not let the resource escape: the code cannot return it, store it, or give it to another function. The `finally` block is necessary, and the compiler does not infer a close operation.

Last, add the exported function:

```eff
export const checkout = (id: BookId): Book
  fails BookMissing | NoCopies | StoreDown
  uses Shelf.find | Shelf.save | Ledger => {
  const book = lend(id)
  record(book)
  book
}
```

`uses Ledger` lists all operations of `Ledger`. To list only some operations, write them one at a time, as in `Shelf.find | Shelf.save`.

## Step 9: build the project

Build the project:

```sh
deno task effektive build "$tutorial_dir" --validate --tsc
```

The build writes `library.ts` and `loans.ts` next to the sources, each with a source map. `--validate` checks the typed intermediate code with a second, independent validator. `--tsc` runs `deno check` on the generated TypeScript.

The generated code is ordinary Effect-TS. For example, `findBook` becomes a function that returns `Effect.Effect<Book, BookMissing | StoreDown, Shelf>`. The `fails` clause becomes the error channel, and the `uses` clause becomes the requirement channel. `Shelf` becomes a `Context.Service` class, and each error becomes a `Schema.TaggedError` class.

## Step 10: supply the services and run

The source code does not implement `Shelf` or `Ledger`. The host supplies them as Effect layers. Create `main.ts` next to the sources. Start with the imports and an in-memory shelf:

```ts
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
```

`BookId.make` makes a `BookId` from a `string`. TypeScript rejects a plain `string` where the generated code needs a `BookId`.

Next, add a ledger that keeps its lines in an array:

```ts
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
```

Last, run two checkouts. The second book has no copies, so the program handles `NoCopies`:

```ts
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
```

The tag of a generated error is `<module>#<Name>`, so the tag of `NoCopies` is `library#NoCopies`.

Type-check `main.ts`, then run the program. The earlier build's `--tsc` checks the generated modules; it does not check this standalone host entry point:

```sh
deno check --config "$tutorial_dir/deno.json" "$tutorial_dir/main.ts"
deno run --config "$tutorial_dir/deno.json" "$tutorial_dir/main.ts"
```

The output is:

```text
{"dune":1,"emma":"no copies of b2","lines":["lent Dune","closed"]}
```

The first checkout takes one copy of Dune and writes one ledger line. Then the ledger closes. The second checkout fails with `NoCopies` before it opens the ledger.

This run demonstrates cleanup after a successful write. `Ledger` declares no typed failures, and this host implementation always succeeds. The `using` cleanup guarantee also covers failures and interruptions during use, but this run does not exercise them.

## Work in an editor

`watch` builds the project again after each change to a source file:

```sh
deno task effektive watch "$tutorial_dir" --tsc
```

The VS Code extension shows diagnostics, hover, references, rename, completion, and quick fixes for contracts. It writes the generated files when you save. [editor.md](editor.md) describes the extension, and [installation.md](installation.md) tells how to install it.

## Next steps

- [language-rules.md](language-rules.md) gives each language rule that the compiler uses.
- [fixtures/examples/](../fixtures/examples/) shows a host interface file (`.effi`). With this file, the source code can name a host provider and call `provide` itself.
- [fixtures/applications/](../fixtures/applications/) has larger applications with streams, schedules, Schema decoding, and retries.
- [api.md](api.md) describes the command-line tool, the language server, and the playground.
