// Slow tests of the language server (plan L3a and L3b). They start the real
// server as a subprocess on a copy of `fixtures/examples` and talk to it over
// stdio. Nothing is written under fixtures/.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { FrameDecoder, type FrameError } from "../src/lsp/jsonrpc.ts";
import type { Result } from "../src/core/source.ts";
import { copyDirectory, FIXTURES } from "./helpers.ts";
import { frameOf } from "./lsp_helpers.ts";

const REPOSITORY = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 20_000;

/** A running server with a continuous reader on its stdout. */
class Client {
  readonly messages: unknown[] = [];
  readonly errors: FrameError[] = [];
  readonly #process: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reading: Promise<void>;
  #waiting: (() => void) | undefined;

  constructor(cwd: string) {
    this.#process = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--config",
        `${REPOSITORY}deno.json`,
        `${REPOSITORY}src/lsp/main.ts`,
      ],
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    this.#writer = this.#process.stdin.getWriter();
    this.#reading = this.#read();
  }

  async #read(): Promise<void> {
    const decoder = new FrameDecoder();
    for await (const chunk of this.#process.stdout) {
      for (
        const frame of decoder.push(chunk) as Result<unknown, FrameError>[]
      ) {
        if (frame.ok) this.messages.push(frame.value);
        else this.errors.push(frame.error);
      }
      this.#waiting?.();
    }
    this.#waiting?.();
  }

  async send(message: unknown): Promise<void> {
    await this.#writer.write(frameOf(message));
  }

  /** Waits until a message satisfies `match`, or fails after the timeout. */
  async waitFor(match: (message: unknown) => boolean): Promise<unknown> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const found = this.messages.find(match);
      if (found !== undefined) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timeout waiting for a server message");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiting = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** Closes stdin and returns the exit code once stdout has ended. */
  async finish(): Promise<number> {
    try {
      await this.#writer.close();
    } catch {
      // The server already exited and closed the pipe.
    }
    const status = await this.#process.status;
    await this.#reading;
    return status.code;
  }

  kill(): void {
    try {
      this.#process.kill();
    } catch {
      // The process already ended.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

Deno.test("the server answers hover, definition, and save, and exits 0", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "effective-lsp-" });
  let client: Client | undefined;
  try {
    copyDirectory(new URL("examples/", FIXTURES), dir);
    const text = Deno.readTextFileSync(`${dir}/main.eff`);
    const uri = new URL(`file://${dir}/main.eff`).href;
    client = new Client(dir);
    await client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: null, capabilities: {} },
    });
    const initialized = await client.waitFor((m) => isRecord(m) && m.id === 1);
    assert(isRecord(initialized) && "result" in initialized);
    await client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "effective", version: 1, text },
      },
    });
    const published = await client.waitFor((m) =>
      isRecord(m) && m.method === "textDocument/publishDiagnostics" &&
      isRecord(m.params) && m.params.uri === uri
    );
    assert(isRecord(published));
    assertEquals(published.params, { uri, version: 1, diagnostics: [] });
    const positionOf = (needle: string, within: number) => {
      const before = text.slice(0, text.indexOf(needle)).split("\n");
      return {
        line: before.length - 1,
        character: before[before.length - 1].length + within,
      };
    };
    // Hover on the name `main`: the contract text.
    const name = positionOf("main = ", 1);
    await client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: name },
    });
    const hover = await client.waitFor((m) => isRecord(m) && m.id === 2);
    assert(isRecord(hover) && isRecord(hover.result));
    assert(isRecord(hover.result.contents));
    assertStringIncludes(
      String(hover.result.contents.value),
      "main(): Name fails StoreUnavailable",
    );
    // Definition of the call of `displayName`: it lands in `users.eff`.
    const call = positionOf('displayName("u1")', 2);
    await client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "textDocument/definition",
      params: { textDocument: { uri }, position: call },
    });
    const definition = await client.waitFor((m) => isRecord(m) && m.id === 3);
    assert(isRecord(definition) && isRecord(definition.result));
    assertEquals(
      definition.result.uri,
      new URL(`file://${dir}/users.eff`).href,
    );
    // A save writes `main.ts`. The stats request is a barrier: the server
    // answers it after it handled the save.
    await client.send({
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: { textDocument: { uri } },
    });
    await client.send({
      jsonrpc: "2.0",
      id: 4,
      method: "effective/stats",
      params: { textDocument: { uri } },
    });
    await client.waitFor((m) => isRecord(m) && m.id === 4);
    assert(Deno.statSync(`${dir}/main.ts`).isFile);
    await client.send({ jsonrpc: "2.0", id: 5, method: "shutdown" });
    const shutdown = await client.waitFor((m) => isRecord(m) && m.id === 5);
    assert(isRecord(shutdown));
    assertEquals(shutdown.result, null);
    await client.send({ jsonrpc: "2.0", method: "exit" });
    assertEquals(await client.finish(), 0);
    // Every byte of stdout decoded as frames.
    assertEquals(client.errors, []);
  } finally {
    client?.kill();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("end of stdin without shutdown exits 1", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "effective-lsp-" });
  let client: Client | undefined;
  try {
    copyDirectory(new URL("examples/", FIXTURES), dir);
    client = new Client(dir);
    await client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {} },
    });
    await client.waitFor((m) => isRecord(m) && m.id === 1);
    assertEquals(await client.finish(), 1);
    assertEquals(client.errors, []);
  } finally {
    client?.kill();
    Deno.removeSync(dir, { recursive: true });
  }
});
