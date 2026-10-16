/// <reference lib="dom" />
// The walking skeleton of the playground page. It fetches `examples.json`,
// starts the compile facade, and mounts one editor on `main.eff`. Each edit
// calls `update`, and the status line shows the compile time and the number of
// problems. G2b replaces this with the full page.

import { EditorView, lineNumbers } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import {
  createPlayground,
  type PlaygroundError,
  type PlaygroundResult,
} from "./compile.ts";

const FILE = "main.eff";

function isTextRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

async function loadExamples(): Promise<
  { ok: true; files: Record<string, string> } | { ok: false; message: string }
> {
  try {
    const response = await fetch("examples.json");
    if (!response.ok) {
      return {
        ok: false,
        message: `examples.json: ${response.status} ${response.statusText}`,
      };
    }
    const data: unknown = await response.json();
    if (!isTextRecord(data)) {
      return { ok: false, message: "examples.json: unexpected content" };
    }
    return { ok: true, files: data };
  } catch (error) {
    return {
      ok: false,
      message: `examples.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function describe(
  result: { ok: true; value: PlaygroundResult } | {
    ok: false;
    error: PlaygroundError;
  },
): string {
  if (!result.ok) return `${result.error.tag} error: ${result.error.message}`;
  const problems = Object.values(result.value.diagnostics)
    .reduce((sum, list) => sum + list.length, 0);
  return `compiled in ${
    result.value.elapsedMs.toFixed(1)
  } ms, ${problems} problems`;
}

async function main(): Promise<void> {
  const status = element("status");
  const loading = element("loading");
  const examples = await loadExamples();
  if (!examples.ok) {
    loading.textContent = `The playground could not start. ${examples.message}`;
    status.textContent = examples.message;
    return;
  }
  const session = createPlayground(examples.files, {
    now: () => performance.now(),
  });
  status.textContent = describe(session.start());
  loading.remove();
  new EditorView({
    doc: examples.files[FILE] ?? "",
    extensions: [
      minimalSetup,
      lineNumbers(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          status.textContent = describe(
            session.update(FILE, update.state.doc.toString()),
          );
        }
      }),
    ],
    parent: element("editor"),
  });
}

await main();
