import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const base = new URL(
  "../fixtures/applications/portable-publisher/",
  import.meta.url,
);

function sources(): Record<string, string> {
  return Object.fromEntries(
    [...Deno.readDirSync(base)]
      .filter((file) =>
        file.name.endsWith(".eff") || file.name === "effektive.json"
      )
      .map((
        file,
      ) => [file.name, Deno.readTextFileSync(new URL(file.name, base))]),
  );
}

Deno.test("portable publisher checks, lowers, and independently validates its source contracts", () => {
  const result = checkProject(memoryHost(sources()), "", [
    "publisher.eff",
    "grants.eff",
  ]);
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.value.diagnostics, []);
  assertEquals(result.value.analysis.project.graph.get("domain"), []);
  assertEquals(result.value.analysis.project.graph.get("ports"), ["domain"]);
  assertEquals(result.value.analysis.project.graph.get("feature"), [
    "domain",
    "ports",
  ]);
  const domain = result.value.modules.get("domain");
  assert(domain);
  for (const mode of domain.modes.values()) assertEquals(mode, "pure");
  const lowered = lowerProject(result.value);
  for (const module of lowered.values()) {
    assert(module.ok, JSON.stringify(module));
  }
  for (
    const diagnostics of validateProject(result.value.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
});

Deno.test("portable publisher rejects erased failures, services, and result contracts", () => {
  const files = sources();
  const original = files["publisher.eff"];
  assert(original);
  // Expand the named error set so that each member can be erased one by one.
  const members = [
    "MissingArticle",
    "InvalidArticle",
    "RevisionExhausted",
    "Corrupt",
    "StorageUnavailable",
    "StorageUncertain",
    "PublishConflict",
  ];
  const expanded = [
    'import { InvalidArticle, RevisionExhausted } from "./domain.eff"',
    'import { Corrupt, StorageUnavailable, StorageUncertain } from "./ports.eff"',
    'import { MissingArticle, PublishConflict } from "./feature.eff"',
  ].join("\n") + "\n" +
    original.replaceAll(
      "fails PublishFailure | PlatformUnavailable",
      `fails ${members.join(" | ")} | PlatformUnavailable`,
    );
  const without = (kind: "fails" | "uses", name: string) =>
    expanded.replaceAll(
      new RegExp(`${kind} ([^\\n]+?)(?= =>|\\n)`, "g"),
      (_clause, names: string) => {
        const remaining = names.split(" | ").filter((item) => item !== name);
        return remaining.length ? `${kind} ${remaining.join(" | ")}` : "";
      },
    );
  const rejected = (source: string, category: string) => {
    assert(source !== original && source !== expanded);
    const result = checkProject(
      memoryHost({ ...files, "publisher.eff": source }),
      "",
      ["publisher.eff"],
    );
    assert(result.ok, JSON.stringify(result));
    assert(
      result.value.diagnostics.some((diagnostic) =>
        diagnostic.category === category
      ),
    );
  };
  for (
    const failure of [
      "MissingArticle",
      "InvalidArticle",
      "RevisionExhausted",
      "Corrupt",
      "StorageUnavailable",
      "StorageUncertain",
      "PublishConflict",
      "PlatformUnavailable",
    ]
  ) rejected(without("fails", failure), "failure-contract");
  rejected(
    original.replaceAll("PublishFailure | ", ""),
    "failure-contract",
  );
  for (
    const capability of [
      "Platform.acquire",
      "ArticleJson.acquire",
      "TextRules.acquire",
      "Time.acquire",
    ]
  ) rejected(without("uses", capability), "requirement-contract");
  rejected(
    original.replace("(rawId: Text): PublishReceipt", "(rawId: Text): Text"),
    "type-mismatch",
  );
});
