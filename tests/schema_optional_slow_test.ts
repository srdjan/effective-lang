import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-optional-union.eff", import.meta.url),
);

function checked(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("optional fields, tagged union, authored issues, and finite recursion compile and run", async () => {
  const project = checked(fixture);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  const dir = Deno.makeTempDirSync({ prefix: "effective-schema-optional-" });
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { effect: "npm:effect@4.0.5" },
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
      }),
    );
    for (
      const result of emitProject(lowered, {
        config: project.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { Read, Write, choice, optional, optionalNode, taggedNode, readChoice, readOptional, readPositive, writeChoice, writeOptional, writePositive } from "./main.ts";

const events: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => {
  events.push("read:" + value);
  return Option.some(value + 1);
}) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => {
  events.push("write:" + value);
  return Option.some(value - 1);
}) });
if (events.length !== 0 || !choice || !optional) throw new Error("eager schema");
const absent = await Effect.runPromise(readOptional({}).pipe(Effect.provide(read)));
const absentEncoded = await Effect.runPromise(writeOptional({}).pipe(Effect.provide(write)));
if (JSON.stringify(absent) !== "{}" || JSON.stringify(absentEncoded) !== "{}" || events.length !== 0) throw new Error("missing optional field ran");
const present = await Effect.runPromise(readOptional({ value: 1 }).pipe(Effect.provide(read)));
const encoded = await Effect.runPromise(writeOptional({ value: 2 }).pipe(Effect.provide(write)));
if (JSON.stringify(present) !== '{"value":2}' || JSON.stringify(encoded) !== '{"value":1}') throw new Error("present optional field");
const right = await Effect.runPromise(readChoice({ kind: "right", value: 7 }).pipe(Effect.provide(read)));
const left = await Effect.runPromise(readChoice({ kind: "left", value: 1 }).pipe(Effect.provide(read)));
const leftEncoded = await Effect.runPromise(writeChoice({ kind: "left", value: 2 }).pipe(Effect.provide(write)));
const again = await Effect.runPromise(readOptional({ value: 1 }).pipe(Effect.provide(read)));
if (JSON.stringify(right) !== '{"kind":"right","value":7}' || JSON.stringify(left) !== '{"kind":"left","value":2}' || JSON.stringify(leftEncoded) !== '{"kind":"left","value":1}') throw new Error("tag dispatch");
if (JSON.stringify(again) !== '{"value":2}' || events.join(",") !== "read:1,write:2,read:1,write:2,read:1") throw new Error("wrong field effects or replay: " + events.join(","));
const invalid = await Effect.runPromiseExit(readOptional({ value: undefined }).pipe(Effect.provide(read)));
if (!Exit.isFailure(invalid) || !(Option.getOrUndefined(Cause.findErrorOption(invalid.cause)) instanceof Schema.SchemaError)) throw new Error("present undefined accepted");
const issueExit = await Effect.runPromiseExit(readPositive(0));
if (!Exit.isFailure(issueExit)) throw new Error("positive schema accepted zero");
const issue = Option.getOrUndefined(Cause.findErrorOption(issueExit.cause));
if (!(issue instanceof Schema.SchemaError) || !issue.message.includes("not positive") || !issue.message.includes("try another value") || !JSON.stringify(issue.issue).includes('"path":["value"]')) throw new Error("lost authored issue tree");
const encodeIssueExit = await Effect.runPromiseExit(writePositive(0));
if (!Exit.isFailure(encodeIssueExit)) throw new Error("encode issue accepted zero");
const encodeIssue = Option.getOrUndefined(Cause.findErrorOption(encodeIssueExit.cause));
if (!(encodeIssue instanceof Schema.SchemaError) || !encodeIssue.message.includes("cannot encode zero") || !JSON.stringify(encodeIssue.issue).includes('"path":["encode"]')) throw new Error("lost encode issue");
const optionalValue = { next: { next: {} } };
const taggedValue = { kind: "more", next: { kind: "end" } } as const;
if (JSON.stringify(await Effect.runPromise(Schema.decodeUnknownEffect(optionalNode)(optionalValue))) !== JSON.stringify(optionalValue)) throw new Error("optional recursion decode");
if (JSON.stringify(await Effect.runPromise(Schema.encodeEffect(optionalNode)(optionalValue))) !== JSON.stringify(optionalValue)) throw new Error("optional recursion encode");
if (JSON.stringify(await Effect.runPromise(Schema.decodeUnknownEffect(taggedNode)(taggedValue))) !== JSON.stringify(taggedValue)) throw new Error("tagged recursion decode");
if (JSON.stringify(await Effect.runPromise(Schema.encodeEffect(taggedNode)(taggedValue))) !== JSON.stringify(taggedValue)) throw new Error("tagged recursion encode");
const defect = Layer.succeed(Read)({ next: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(readOptional({ value: 1 }).pipe(Effect.provide(defect)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("defect translated");
const blocked = Layer.succeed(Read)({ next: () => Effect.never });
const fiber = Effect.runFork(readOptional({ value: 1 }).pipe(Effect.provide(blocked)));
await Effect.runPromise(Fiber.interrupt(fiber));
const interrupted = await Effect.runPromise(Fiber.await(fiber));
if (!Exit.isFailure(interrupted) || !Cause.hasInterrupts(interrupted.cause)) throw new Error("interruption translated");
`,
    );
    for (const command of ["check", "run"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [command, "--no-lock", "run.ts"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        new TextDecoder().decode(result.stderr) +
          new TextDecoder().decode(result.stdout),
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("independent validator rejects duplicate tags, forged optionality, and unguarded self use", () => {
  const project = checked(fixture);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  const result = [...lowered.values()][0];
  assert(result.ok, JSON.stringify(result));
  const sources = new Map([["main.eff", fixture]]);

  const duplicate = structuredClone(result.value);
  const choice = duplicate.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "choice"
  );
  assert(choice?.kind === "constant" && choice.value.kind === "schema");
  const list = choice.value.arguments[0];
  assert(list?.kind === "tuple");
  assert(list.type.kind === "tuple");
  Object.assign(list, {
    elements: [list.elements[0], list.elements[0]],
    type: {
      kind: "tuple",
      elements: [list.type.elements[0], list.type.elements[0]],
    },
  });
  assert(
    validateModule(duplicate, sources).some((diagnostic) =>
      diagnostic.message.includes("schemaUnion")
    ),
  );

  const optional = structuredClone(result.value);
  const descriptor = optional.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "optionalField"
  );
  assert(descriptor?.kind === "constant" && descriptor.value.kind === "schema");
  assert(descriptor.value.type.kind === "schema");
  Object.assign(descriptor.value.type, { optionalKey: undefined });
  assert(
    validateModule(optional, sources).some((diagnostic) =>
      diagnostic.message.includes("type") ||
      diagnostic.message.includes("optional")
    ),
  );

  const immediate = structuredClone(result.value);
  const node = immediate.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "optionalNode"
  );
  assert(node?.kind === "constant" && node.value.kind === "schema");
  const callback = node.value.arguments[0];
  assert(callback?.kind === "closure" && callback.body.kind === "schema");
  const record = callback.body.arguments[0];
  assert(record?.kind === "record");
  const next = record.fields.find((field) => field.name === "next");
  assert(next !== undefined);
  Object.assign(next, {
    value: {
      kind: "reference",
      target: callback.parameters[0].id,
      type: callback.parameters[0].type,
      execution: "pure",
      effects: { failures: [], requirements: [] },
      span: next.value.span,
    },
  });
  assert(
    validateModule(immediate, sources).some((diagnostic) =>
      diagnostic.message.includes("schemaRecursive needs")
    ),
  );
});
