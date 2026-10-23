// Slow tests of the application fixtures under `fixtures/applications/`.
// Each test checks, lowers, and validates its application, writes the emitted
// modules and the host files into a temporary directory, and runs `deno check`,
// `deno test`, and `deno run` there. Each command must exit with code 0.

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

/** The fields of the JSON that `main.ts` prints. Each application prints its own subset. */
interface Report {
  readonly completed?: number;
  readonly last?: { readonly value: number };
  readonly receipt?: unknown;
  readonly committed?: readonly unknown[];
  readonly active?: number;
  readonly batches?: readonly (readonly { readonly id: number }[])[];
  readonly tags?: readonly string[];
  readonly states?: readonly string[];
  readonly described?: readonly string[];
  readonly sampleRulePrice?: number;
  readonly hostRulePrice?: number;
  readonly rejected?: string;
}

interface Application {
  readonly name: string;
  /** The fixture directory under `fixtures/applications/`. */
  readonly directory: string;
  /** The source files of the project, including `effective.json`. */
  readonly sources: readonly string[];
  readonly entry: string;
  readonly prefix: string;
  /** The host files that the test copies next to the emitted modules. */
  readonly hostFiles: readonly string[];
  readonly verify: (report: Report) => void;
}

const APPLICATIONS: readonly Application[] = [
  {
    name:
      "scheduled worker application passes strict emitted execution and cancellation gates",
    directory: "scheduled-worker",
    sources: ["effective.json", "contracts.eff", "worker.eff"],
    entry: "worker.eff",
    prefix: "effective-application-worker-",
    hostFiles: ["driver.ts", "reference.ts", "runtime_test.ts", "main.ts"],
    verify: (report) => {
      assertEquals(report.completed, 3);
      assertEquals(report.last?.value, 30);
    },
  },
  {
    name:
      "service workflow application passes strict registered host and transaction gates",
    directory: "service-workflow",
    sources: ["effective.json", "contracts.eff", "host.effi", "workflow.eff"],
    entry: "workflow.eff",
    prefix: "effective-application-service-",
    hostFiles: ["adapter.ts", "driver.ts", "runtime_test.ts", "main.ts"],
    verify: (report) => {
      assertEquals(report.receipt, { sku: "book", quantity: 2, total: 24 });
      assertEquals(report.committed?.length, 1);
      assertEquals(report.active, 0);
    },
  },
  {
    name:
      "stream processor application passes strict emitted and lifecycle gates",
    directory: "stream-processor",
    sources: ["effective.json", "contracts.eff", "processor.eff"],
    entry: "processor.eff",
    prefix: "effective-application-stream-",
    hostFiles: ["driver.ts", "runtime_test.ts", "main.ts"],
    verify: (report) => {
      assertEquals(
        report.batches?.map((batch) => batch.map((item) => item.id)),
        [[1, 2], [3, 4], [5]],
      );
      assertEquals(report.active, 0);
    },
  },
  {
    name: "order lifecycle application passes nominal data and decoding checks",
    directory: "order-lifecycle",
    sources: ["effective.json", "contracts.eff", "orders.eff"],
    entry: "orders.eff",
    prefix: "effective-application-orders-",
    hostFiles: ["runtime_test.ts", "main.ts"],
    verify: (report) => {
      assertEquals(report.tags, [
        "contracts#Pending",
        "contracts#Paid",
        "contracts#Shipped",
      ]);
      assertEquals(report.states, ["pending", "paid", "shipped"]);
      assertEquals(report.described, ["pending", "R1", "T1"]);
      assertEquals(report.sampleRulePrice, 2500);
      assertEquals(report.hostRulePrice, 2050);
      assertEquals(report.rejected, "Failure");
    },
  },
];

for (const app of APPLICATIONS) {
  Deno.test(app.name, async () => {
    const base = new URL(
      `../fixtures/applications/${app.directory}/`,
      import.meta.url,
    );
    const files = Object.fromEntries(
      app.sources.map((
        name,
      ) => [name, Deno.readTextFileSync(new URL(name, base))]),
    );
    const project = checkProject(memoryHost(files), "", [app.entry]);
    assert(project.ok, JSON.stringify(project));
    assertEquals(project.value.diagnostics, []);
    const lowered = lowerProject(project.value);
    for (const result of lowered.values()) {
      assert(result.ok, JSON.stringify(result));
    }
    for (
      const diagnostics of validateProject(
        project.value.analysis.project,
        lowered,
      ).values()
    ) assertEquals(diagnostics, []);
    const dir = Deno.makeTempDirSync({ prefix: app.prefix });
    try {
      Deno.writeTextFileSync(
        `${dir}/deno.json`,
        Deno.readTextFileSync(new URL("deno.json", base)),
      );
      for (
        const result of emitProject(lowered, {
          config: project.value.analysis.project.config,
        }).values()
      ) {
        assert(result.ok, JSON.stringify(result));
        Deno.writeTextFileSync(
          `${dir}/${result.value.path}`,
          result.value.text,
        );
      }
      for (const name of app.hostFiles) {
        Deno.writeTextFileSync(
          `${dir}/${name}`,
          Deno.readTextFileSync(new URL(name, base)),
        );
      }
      for (
        const args of [["check", "--no-lock", "main.ts", "runtime_test.ts"], [
          "test",
          "--no-lock",
          "runtime_test.ts",
        ], ["run", "--no-lock", "main.ts"]]
      ) {
        const result = await new Deno.Command(Deno.execPath(), {
          args,
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
        if (args[0] === "run") {
          const report: Report = JSON.parse(
            new TextDecoder().decode(result.stdout),
          );
          app.verify(report);
        }
      }
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });
}
