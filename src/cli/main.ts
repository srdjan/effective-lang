// The command-line tool `effective`: `check`, `build`, and `watch`. The watch
// loop takes its event source as a parameter, so that a test drives it with a fake.
//
// `main(args, io)` returns the exit code and does everything else through `io`,
// so that tests run it in process with in-memory doubles. The real entry at the
// end of this file wires the Deno APIs.
//
// Exit codes: 0 when there is no diagnostic, 1 when there is at least one, 2
// for a usage or configuration error, and 3 for an internal error. An internal
// error is an unexpected throw. It gets its own code so that it never reads as
// a diagnostic.

import { errorMessage } from "../core/mod.ts";
import { parseArgs, type ProjectCommand, USAGE } from "./args.ts";
import type { BuildOptions, BuildOutcome } from "./build.ts";
import { denoIo } from "../host/deno_io.ts";
import type { CliIo } from "../host/io.ts";
import { removeStaleOutputs } from "../host/outputs.ts";
import { printOutcome, rechecked } from "./report.ts";
import { Session, type SyncResult } from "./session.ts";

const EXIT_OK = 0;
const EXIT_DIAGNOSTICS = 1;
const EXIT_USAGE = 2;
const EXIT_INTERNAL = 3;

function optionsOf(command: ProjectCommand): BuildOptions {
  switch (command.kind) {
    case "build":
      return { write: true, validate: command.validate, tsc: command.tsc };
    case "watch":
      return { write: true, validate: false, tsc: command.tsc };
    case "check":
      return { write: false, validate: false, tsc: false };
  }
}

/**
 * Builds the `first` sync result, then builds once for each batch of `events`.
 * Each build prints the modules that it checked again and its diagnostics.
 * When a module leaves the project, the loop removes its generated files.
 * Returns when the event source ends. A broken project file prints an error,
 * and the loop goes on.
 */
async function watchLoop(
  io: CliIo,
  session: Session,
  first: SyncResult,
  events: AsyncIterable<readonly string[]>,
  options: BuildOptions,
): Promise<void> {
  // The modules of the last revision that loaded. A round with a configuration
  // error keeps it, so that the next revision still finds the modules that left.
  let previous: readonly string[] = [];
  const round = async (synced: SyncResult): Promise<void> => {
    switch (synced.tag) {
      case "unchanged":
        return;
      case "read-error":
      case "config-error":
        io.stderr(`error: ${synced.message}\n`);
        return;
      case "revision": {
        const names = new Set(synced.revision.effModuleNames());
        const stale = removeStaleOutputs(
          io.fs,
          session.root,
          previous.filter((name) => !names.has(name)),
        );
        for (const path of stale.removed) io.stderr(`removed: ${path}\n`);
        for (const note of stale.notes) io.stderr(`${note}\n`);
        previous = [...names];
        const outcome: BuildOutcome = await session.build(
          synced.revision,
          options,
        );
        io.stderr(`rechecked: ${rechecked(synced.revision.rechecked)}\n`);
        printOutcome(io, outcome, synced.revision.effModuleNames().length);
      }
    }
  };
  await round(first);
  const iterator = events[Symbol.asyncIterator]();
  let next = iterator.next();
  try {
    io.stderr(`watching ${session.root}\n`);
    while (true) {
      const event = await next;
      if (event.done) break;
      await round(session.sync());
      next = iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

type SyncFailure = Extract<
  SyncResult,
  { readonly tag: "read-error" | "config-error" }
>;

/** True when the project cannot start: a file is unreadable or the project file is bad. */
function isSyncFailure(synced: SyncResult): synced is SyncFailure {
  return synced.tag === "read-error" || synced.tag === "config-error";
}

export async function main(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  try {
    return await execute(args, io);
  } catch (error) {
    io.stderr(`effective: internal error: ${errorMessage(error)}\n`);
    return EXIT_INTERNAL;
  }
}

async function execute(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    io.stderr(`effective: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const command = parsed.value;
  if (command.kind === "help") {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  const root = command.root;
  if (io.fs.kind(root) !== "directory") {
    io.stderr(`effective: the root directory ${root} does not exist\n`);
    return EXIT_USAGE;
  }

  const session = new Session(io, root);
  const options = optionsOf(command);
  // A project that cannot start is a configuration error. A later break in watch mode only prints.
  const synced = session.sync();
  if (isSyncFailure(synced)) {
    io.stderr(`effective: ${synced.message}\n`);
    return EXIT_USAGE;
  }
  if (command.kind === "watch") {
    await watchLoop(io, session, synced, io.watch(root), options);
    return EXIT_OK;
  }
  if (synced.tag === "unchanged") return EXIT_OK;
  const outcome = await session.build(synced.revision, options);
  printOutcome(io, outcome, synced.revision.effModuleNames().length);
  return outcome.failed ? EXIT_DIAGNOSTICS : EXIT_OK;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args, denoIo()));
}
