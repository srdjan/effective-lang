import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { packageRelease } from "../scripts/package.ts";
import { FrameDecoder } from "../src/lsp/jsonrpc.ts";
import { frameOf } from "./lsp_helpers.ts";

async function command(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

Deno.test("local artifacts install and run offline outside the checkout with an empty cache", async () => {
  const temporary = Deno.makeTempDirSync({ prefix: "effektive-install-" });
  try {
    const output = join(temporary, "artifacts");
    const artifacts = await packageRelease(output);
    const first = Deno.readFileSync(artifacts[2]);
    await packageRelease(output);
    assertEquals(
      Deno.readFileSync(artifacts[2]),
      first,
      "VSIX bytes must be reproducible",
    );
    const unpacked = join(temporary, "unpacked");
    Deno.mkdirSync(unpacked);
    await command("unzip", ["-q", artifacts[2], "-d", unpacked], temporary, {});
    assert(
      Deno.statSync(
        join(
          unpacked,
          "extension",
          "node_modules",
          "vscode-languageclient",
          "lib",
          "node",
          "main.js",
        ),
      ).isFile,
    );
    const project = join(temporary, "project");
    Deno.mkdirSync(project);
    Deno.writeTextFileSync(join(project, "effektive.json"), "{}\n");
    const source =
      "type Answer = int\nexport const answer = (): Answer => 42\n";
    Deno.writeTextFileSync(join(project, "main.eff"), source);
    const uri = toFileUrl(join(project, "main.eff")).href;
    const env = {
      DENO_DIR: join(temporary, "empty-cache"),
      DENO_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
    };
    const child = new Deno.Command("deno", {
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--cached-only",
        "--deny-import",
        "--deny-net",
        "--allow-read",
        "--allow-write",
        join(unpacked, "extension", "server", "effektive-lsp.js"),
      ],
      cwd: project,
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const result = child.output();
    const writer = child.stdin.getWriter();
    for (
      const message of [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            processId: null,
            rootUri: toFileUrl(project).href,
            capabilities: {},
          },
        },
        { jsonrpc: "2.0", method: "initialized", params: {} },
        {
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: {
              uri,
              languageId: "effektive",
              version: 1,
              text: source,
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "effektive/generatedTypeScript",
          params: { textDocument: { uri } },
        },
        { jsonrpc: "2.0", id: 3, method: "shutdown", params: null },
        { jsonrpc: "2.0", method: "exit", params: null },
      ]
    ) await writer.write(frameOf(message));
    await writer.close();
    const server = await result;
    assertEquals(server.code, 0, new TextDecoder().decode(server.stderr));
    const frames = new FrameDecoder().push(server.stdout);
    const messages = frames.map((frame) => {
      assert(frame.ok);
      return frame.value as Record<string, unknown>;
    });
    assert(
      messages.some((message) =>
        message.id === 1 && message.result !== undefined
      ),
    );
    const generated = messages.find((message) => message.id === 2);
    assert(
      generated !== undefined && typeof generated.result === "object" &&
        generated.result !== null,
      JSON.stringify(messages),
    );
    assertStringIncludes(
      String((generated.result as Record<string, unknown>).text),
      "answer",
    );
    const installRoot = join(temporary, "installation");
    await command(
      "deno",
      [
        "install",
        "--global",
        "--root",
        installRoot,
        "--name",
        "effektive",
        "--no-config",
        "--no-lock",
        "--cached-only",
        "--allow-read",
        "--allow-write",
        "--allow-run=deno",
        artifacts[0],
      ],
      project,
      env,
    );
    const installed = join(
      installRoot,
      "bin",
      Deno.build.os === "windows" ? "effektive.cmd" : "effektive",
    );
    assertStringIncludes(
      await command(installed, ["--help"], project, env),
      "usage: effektive",
    );
    await command(installed, ["check"], project, env);
    await command(installed, ["build"], project, env);
    assertStringIncludes(
      Deno.readTextFileSync(join(project, "main.ts")),
      "answer",
    );
    assert(Deno.statSync(join(project, "main.ts.map")).isFile);
  } finally {
    Deno.removeSync(temporary, { recursive: true });
  }
});
