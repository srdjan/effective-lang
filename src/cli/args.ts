// The command line: `effective check|build|watch [root] [flags]`.

import type { Result } from "../core/source.ts";

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "check"; readonly root: string }
  | {
    readonly kind: "build";
    readonly root: string;
    readonly tsc: boolean;
    readonly validate: boolean;
  }
  | { readonly kind: "watch"; readonly root: string; readonly tsc: boolean };

export const USAGE = [
  "usage: effective <command> [root] [flags]",
  "",
  "commands:",
  "  check [root]                          print diagnostics",
  "  build [root] [--tsc] [--validate]     also write <module>.ts and <module>.ts.map",
  "  watch [root] [--tsc]                  build, then rebuild when a source changes",
  "",
  "root is the project directory with effective.json. The default is the current directory.",
  "exit codes: 0 no diagnostics, 1 at least one diagnostic, 2 usage or configuration error, 3 internal error",
  "",
].join("\n");

const FLAGS: Readonly<Record<string, readonly string[]>> = {
  check: [],
  build: ["--tsc", "--validate"],
  watch: ["--tsc"],
};

/** Parses the arguments. An error value holds the message for the user. */
export function parseArgs(args: readonly string[]): Result<Command, string> {
  const fail = (message: string): Result<Command, string> => ({
    ok: false,
    error: message,
  });
  if (args.length === 0) return fail("missing command");
  const [name, ...rest] = args;
  if (name === "--help" || name === "-h" || name === "help") {
    return { ok: true, value: { kind: "help" } };
  }
  if (name !== "check" && name !== "build" && name !== "watch") {
    return fail(`unknown command \`${name}\``);
  }
  const allowed = FLAGS[name];
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("-") && arg.length > 1) {
      if (!allowed.includes(arg)) {
        return fail(`unknown flag \`${arg}\` for \`${name}\``);
      }
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    return fail(`too many arguments: \`${positional.join(" ")}\``);
  }
  const root = positional[0] ?? ".";
  switch (name) {
    case "check":
      return { ok: true, value: { kind: "check", root } };
    case "build":
      return {
        ok: true,
        value: {
          kind: "build",
          root,
          tsc: flags.has("--tsc"),
          validate: flags.has("--validate"),
        },
      };
    case "watch":
      return {
        ok: true,
        value: { kind: "watch", root, tsc: flags.has("--tsc") },
      };
  }
}
