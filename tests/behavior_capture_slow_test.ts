// Slow tests of the behavior capture. They write an instrumented copy of the
// sources into a temporary directory, so they need write permission, which the
// fast suite does not have.

import { assert, assertEquals } from "@std/assert";
import { countKinds, writeInstrumentedTree } from "./behavior_capture_tree.ts";

Deno.test("a CLI build subprocess without environment permission writes records", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "effective-capture-slow-" });
  try {
    const records = `${dir}/capture.records`;
    writeInstrumentedTree(dir, records);
    const project = `${dir}/project`;
    Deno.mkdirSync(project);
    Deno.writeTextFileSync(`${project}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${project}/m.eff`,
      "export const f = (): Int => 1\ntype Int = int\n",
    );
    // The task `effective` of the copied deno.json has no --allow-env.
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["task", "effective", "build", project, "--validate"],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    const kinds = countKinds(Deno.readTextFileSync(records));
    for (const kind of ["program", "lower", "emit", "validate"]) {
      assert((kinds.get(kind) ?? 0) > 0, `no ${kind} record: ${stderr}`);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

type Core = typeof import("../src/core/mod.ts");

const PROJECT = {
  "effective.json": "{}",
  "m.eff": "export const f = (): Int => 1\ntype Int = int\n",
  // A type error: the checker reports it, and the module does not lower.
  "bad.eff": 'export const x: Int = "no"\ntype Int = int\n',
};

/** Runs every hooked entry point on the same sources, with a success and a failure for each. */
function exercise(core: Core): void {
  const host = core.memoryHost(PROJECT);
  const checked = core.checkProject(host, "", ["m.eff", "bad.eff"]);
  assert(checked.ok);
  const lowered = core.lowerProject(checked.value);
  const config = checked.value.analysis.project.config;
  core.emitProject(lowered, { config });
  core.validateProject(checked.value.analysis.project, lowered);
  // A failed lowering: the module name is unknown.
  assert(!core.lowerModule(checked.value, "missing").ok);
  // A failed emission: the host module is not in the project file.
  const hostFiles = {
    "effective.json": JSON.stringify({
      host: { p: { interface: "./host/p.effi", module: "./live.ts" } },
    }),
    "host/p.effi":
      'import { S } from "../s.eff"\nexport provider L provides S\n',
    "s.eff": "export service S { f(): Int }\ntype Int = int\n",
    "h.eff":
      'import { L } from "host:p"\nexport const g = (): Int => provide(L, () => 1)\ntype Int = int\n',
  };
  const hostChecked = core.checkProject(core.memoryHost(hostFiles), "", [
    "s.eff",
    "h.eff",
  ]);
  assert(hostChecked.ok);
  const hostLowered = core.lowerModule(hostChecked.value, "h");
  assert(hostLowered.ok);
  assert(
    !core.emitModule(hostLowered.value, { config: { host: new Map() } }).ok,
  );
  // The program: one revision, and one failed configuration.
  const program = new core.Program("");
  assert(program.update({ set: PROJECT }).ok);
  assert(!new core.Program("").update({ set: { "m.eff": "" } }).ok);
}

Deno.test("two captures of the same program give equal records of every kind", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "effective-capture-test-" });
  try {
    const records = `${dir}/capture.records`;
    writeInstrumentedTree(dir, records);
    const core: Core = await import(
      new URL(`file://${dir}/src/core/mod.ts`).href
    );
    const captureOnce = (): string => {
      Deno.writeTextFileSync(records, "");
      exercise(core);
      return Deno.readTextFileSync(records);
    };
    const first = captureOnce();
    const second = captureOnce();
    const kinds = countKinds(first);
    for (
      const kind of [
        "check",
        "program",
        "program-error",
        "lower",
        "lower-error",
        "emit",
        "emit-error",
        "validate",
      ]
    ) {
      assert((kinds.get(kind) ?? 0) > 0, `no ${kind} record: ${first}`);
    }
    assertEquals(second.split("\n").sort(), first.split("\n").sort());
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
