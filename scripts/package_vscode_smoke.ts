// Real installed-extension acceptance. Separate from the portable installation test
// because it requires a local graphical VS Code installation.
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { packageRelease } from "./package.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const DEFAULT_CODE =
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

async function checked(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr) +
        new TextDecoder().decode(result.stdout),
    );
  }
}

export async function installedEditorSmoke(
  code: string,
  features = true,
): Promise<void> {
  const temporary = Deno.makeTempDirSync({
    prefix: "evsc-",
    ...(Deno.build.os === "darwin" ? { dir: "/tmp" } : {}),
  });
  try {
    const artifacts = await packageRelease(join(temporary, "artifacts"));
    const project = join(temporary, "project");
    const extensions = join(temporary, "extensions");
    const userData = join(temporary, "user-data");
    const harness = join(temporary, "harness");
    for (const directory of [project, extensions, userData, harness]) {
      Deno.mkdirSync(directory);
    }
    Deno.writeTextFileSync(join(project, "effektive.json"), "{}\n");
    Deno.writeTextFileSync(
      join(project, "main.eff"),
      "type Count = int\nexport const twice = (value: Count): Count => value + value\nexport const result = (): Count => twice(21)\n",
    );
    Deno.writeTextFileSync(
      join(harness, "package.json"),
      JSON.stringify({
        name: "effektive-install-smoke",
        publisher: "local",
        version: "0.0.0",
        engines: { vscode: "^1.91.0" },
      }),
    );
    Deno.copyFileSync(
      join(ROOT, "editors", "vscode", "test", "installed.js"),
      join(harness, "installed.js"),
    );
    const env = {
      DENO_DIR: join(temporary, "empty-cache"),
      DENO_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      EFFEKTIVE_TEST_PROJECT: project,
      EFFEKTIVE_TEST_EXTENSIONS: extensions,
      EFFEKTIVE_TEST_FEATURES: String(features),
    };
    await checked(
      code,
      [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        artifacts[2],
        "--force",
      ],
      project,
      env,
    );
    for (const phase of ["initial", "restart"]) {
      const resultFile = join(temporary, `${phase}.json`);
      const application = Deno.build.os === "darwin"
        ? resolve(dirname(code), "../../../MacOS/Code")
        : code;
      const process = new Deno.Command(application, {
        args: [
          "--user-data-dir",
          userData,
          "--extensions-dir",
          extensions,
          "--extensionDevelopmentPath=" + harness,
          "--extensionTestsPath=" + join(harness, "installed.js"),
          "--disable-workspace-trust",
          "--skip-welcome",
          "--skip-release-notes",
          "--disable-gpu",
          "--new-window",
          "--wait",
          project,
        ],
        cwd: project,
        env: {
          ...env,
          EFFEKTIVE_TEST_PHASE: phase,
          EFFEKTIVE_TEST_RESULT: resultFile,
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = process.output();
      const timeout = setTimeout(() => {
        try {
          process.kill();
        } catch { /* already exited */ }
      }, 90_000);
      const result = await output;
      clearTimeout(timeout);
      let evidence: { ok: boolean; error?: string };
      try {
        evidence = JSON.parse(Deno.readTextFileSync(resultFile));
      } catch {
        throw new Error(
          `VS Code ${phase} produced no evidence (exit ${result.code}):\n${
            new TextDecoder().decode(result.stderr)
          }\n${new TextDecoder().decode(result.stdout)}`,
        );
      }
      if (!evidence.ok || !result.success) {
        throw new Error(
          `VS Code ${phase} failed: ${
            evidence.error ?? new TextDecoder().decode(result.stderr)
          }`,
        );
      }
      console.log(
        `Installed VSIX ${phase}: passed (editor features: ${features}).`,
      );
    }
  } finally {
    if (Deno.env.get("EFFEKTIVE_KEEP_SMOKE") === "1") {
      console.log(`Retained smoke workspace: ${temporary}`);
    } else Deno.removeSync(temporary, { recursive: true });
  }
}

if (import.meta.main) {
  await installedEditorSmoke(
    Deno.env.get("EFFEKTIVE_VSCODE_EXECUTABLE") ?? DEFAULT_CODE,
    !Deno.args.includes("--baseline"),
  );
}
