// Tests for the four checks of a borrowed local in src/core/check_expr.ts: a
// borrowed fiber (`withFiber`), a scoped operation record (`withResource` over a
// record), a borrowed host handle (`withResource` over an opaque type or a
// `borrow` parameter), and a borrowed group (`mapGroups`). Each row gives a
// program and the number of reports of the check's message. Every test runs
// through the public entry `checkProject`.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { memoryHost } from "../src/core/source.ts";

const FIBER = "a borrowed fiber may only be joined or interrupted directly";
const RECORD =
  "a scoped operation record may only be used as the direct receiver of an operation call";
const HANDLE = "a borrowed handle may only pass to a borrow-qualified method";
const GROUP =
  "a borrowed group permits at most one direct terminal use and cannot escape or be captured";

interface Row {
  readonly name: string;
  readonly body: string;
  readonly reports: number;
}

function reportsOf(
  files: Record<string, string>,
  entry: string,
  message: string,
): number {
  const result = checkProject(memoryHost(files), "", [entry]);
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics.filter((d) => d.message === message).length;
}

function single(text: string): Record<string, string> {
  return { "effective.json": "{}", "m.eff": text };
}

// ------------------------------------------------------------------ fiber

const FIBER_ROWS: readonly Row[] = [
  { name: "join directly", body: "joinFiber(fiber)", reports: 0 },
  { name: "interrupt directly", body: "interruptFiber(fiber)", reports: 0 },
  {
    name: "join twice",
    body: "{ joinFiber(fiber); joinFiber(fiber) }",
    reports: 0,
  },
  { name: "return the fiber", body: "fiber", reports: 1 },
  {
    name: "copy the fiber",
    body: "{ const copy = fiber; joinFiber(copy) }",
    reports: 1,
  },
  {
    name: "join inside an arrow",
    body: "{ const later = () => joinFiber(fiber); 1 }",
    reports: 1,
  },
  { name: "pass to a function", body: "keep(fiber)", reports: 1 },
  {
    name: "pass as the second argument",
    body: "pair(1, fiber)",
    reports: 1,
  },
  {
    name: "one good use and one bad use",
    body: "{ joinFiber(fiber); keep(fiber) }",
    reports: 1,
  },
];

for (const row of FIBER_ROWS) {
  Deno.test(`borrowed fiber: ${row.name}`, () => {
    const text = `
type Int = int
const keep = (fiber: Fiber<Int, never>): Int => 1
const pair = (n: Int, fiber: Fiber<Int, never>): Int => 1
const probe = (): Int => withFiber(defer(() => 1), (fiber) => ${row.body})
`;
    assertEquals(reportsOf(single(text), "m.eff", FIBER), row.reports);
  });
}

// ------------------------------------------------------------------ scoped record

const RECORD_ROWS: readonly Row[] = [
  { name: "call an operation", body: "file.read()", reports: 0 },
  {
    name: "call two operations",
    body: "{ file.read(); file.read() }",
    reports: 0,
  },
  { name: "return the record", body: "file", reports: 1 },
  { name: "read a field without a call", body: "file.read", reports: 1 },
  {
    name: "copy the record",
    body: "{ const copy = file; copy.read() }",
    reports: 1,
  },
  {
    name: "call inside an arrow",
    body: "{ const later = () => file.read(); later() }",
    reports: 1,
  },
  {
    name: "field of a field",
    body: "{ const saved = { saved: file }; saved }",
    reports: 1,
  },
  {
    name: "one good use and one bad use",
    body: "{ file.read(); file }",
    reports: 1,
  },
];

for (const row of RECORD_ROWS) {
  Deno.test(`scoped operation record: ${row.name}`, () => {
    const text = `
type Text = string
service Files { open(): { read: () => Text, close: () => void } }
const probe = () => withResource(() => Files.open(), (file) => ${row.body}, (file) => file.close())
`;
    assertEquals(reportsOf(single(text), "m.eff", RECORD), row.reports);
  });
}

// ------------------------------------------------------------------ borrowed handle

function handleProject(main: string): Record<string, string> {
  return {
    "effective.json": JSON.stringify({
      host: { files: { interface: "./host.effi", module: "./host.ts" } },
    }),
    "host.effi": `
export opaque type Handle
export type Text = string
export service Files {
  open(): Handle
  read(borrow handle: Handle): Text
  plain(handle: Handle): Text
  both(borrow first: Handle, borrow second: Handle): Text
  second(first: Handle, borrow second: Handle): Text
  close(borrow handle: Handle): void
}
`,
    "main.eff": `
import { Handle, Text, Files } from "host:files"
const borrowed = (borrow handle: Handle): Text uses Files.read => Files.read(handle)
const unborrowed = (handle: Handle): Text => "x"
${main}
`,
  };
}

const HANDLE_ROWS: readonly Row[] = [
  { name: "borrowed method", body: "Files.read(handle)", reports: 0 },
  {
    name: "borrowed method twice",
    body: "{ Files.read(handle); Files.read(handle) }",
    reports: 0,
  },
  { name: "borrow function", body: "borrowed(handle)", reports: 0 },
  {
    name: "both arguments borrowed",
    body: "Files.both(handle, handle)",
    reports: 0,
  },
  { name: "plain method", body: "Files.plain(handle)", reports: 1 },
  { name: "plain function", body: "unborrowed(handle)", reports: 1 },
  {
    name: "first argument not borrowed",
    body: "Files.second(handle, handle)",
    reports: 1,
  },
  { name: "return the handle", body: "handle", reports: 1 },
  {
    name: "use inside an arrow",
    body: "{ const later = () => Files.read(handle); later() }",
    reports: 1,
  },
  {
    name: "copy the handle",
    body: "{ const copy = handle; Files.read(copy) }",
    reports: 1,
  },
  {
    name: "one good use and one bad use",
    body: "{ Files.read(handle); Files.plain(handle) }",
    reports: 1,
  },
];

for (const row of HANDLE_ROWS) {
  Deno.test(`borrowed handle in withResource: ${row.name}`, () => {
    const main =
      `const probe = (): Text uses Files.open | Files.read | Files.plain | Files.both | Files.second | Files.close =>
  withResource(() => Files.open(), (handle) => ${row.body}, (handle) => Files.close(handle))`;
    assertEquals(
      reportsOf(handleProject(main), "main.eff", HANDLE),
      row.reports,
    );
  });
}

const PARAMETER_ROWS: readonly Row[] = [
  { name: "borrowed method", body: "Files.read(handle)", reports: 0 },
  { name: "plain method", body: "Files.plain(handle)", reports: 1 },
  { name: "return the handle", body: '{ handle; "x" }', reports: 1 },
  {
    name: "use inside an arrow",
    body: "{ const later = () => Files.read(handle); later() }",
    reports: 1,
  },
];

for (const row of PARAMETER_ROWS) {
  Deno.test(`borrow parameter: ${row.name}`, () => {
    const main =
      `const probe = (borrow handle: Handle): Text uses Files.read | Files.plain => ${row.body}`;
    assertEquals(
      reportsOf(handleProject(main), "main.eff", HANDLE),
      row.reports,
    );
  });
}

// ------------------------------------------------------------------ borrowed group

const GROUP_ROWS: readonly Row[] = [
  { name: "collect directly", body: "collectStream(group)", reports: 0 },
  { name: "head directly", body: "headStream(group)", reports: 0 },
  {
    name: "fold directly",
    body: "foldStream(group, 0, (sum, n) => sum + n)",
    reports: 0,
  },
  { name: "return the group", body: "group", reports: 1 },
  {
    name: "two terminal uses",
    body: "{ collectStream(group); drainStream(group) }",
    reports: 1,
  },
  {
    name: "three terminal uses",
    body: "{ collectStream(group); drainStream(group); headStream(group) }",
    reports: 2,
  },
  {
    name: "non-terminal use",
    body: "collectStream(mapEffect(group, (n) => n))",
    reports: 1,
  },
  {
    name: "terminal inside an arrow",
    body: "{ const later = () => collectStream(group); 1 }",
    reports: 1,
  },
  {
    name: "group is not the first argument",
    body: "foldStream(source, group, (sum, n) => sum)",
    reports: 1,
  },
  {
    name: "group in a shorthand field",
    body: "keep({ group })",
    reports: 1,
  },
  {
    name: "group in a shorthand field before a terminal",
    body: "{ keep({ group }); collectStream(group) }",
    reports: 2,
  },
];

for (const row of GROUP_ROWS) {
  Deno.test(`borrowed group: ${row.name}`, () => {
    const text = `
type Int = int
const keep = (wrapped: { group: Stream<Int> }): Int => 1
const probe = (source: Stream<Int>) =>
  mapGroups(source, (n) => n, (key, group) => ${row.body}, { bufferSize: 1 })
`;
    assertEquals(reportsOf(single(text), "m.eff", GROUP), row.reports);
  });
}
