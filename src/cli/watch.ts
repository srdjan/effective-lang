// The watch loop. It builds once, then builds again for each batch of events.
// The event source is a parameter, so that a test drives the loop with a fake.

import type { BuildOptions, BuildOutcome } from "./build.ts";
import type { CliIo } from "./io.ts";
import type { Session, SyncResult } from "./session.ts";
import { printOutcome, rechecked } from "./report.ts";

export interface WatchResult {
  /** The number of builds that ran, including the first. */
  readonly builds: number;
}

/**
 * Builds the `first` sync result, then builds once for each batch of `events`.
 * Each build prints the modules that it checked again and its diagnostics.
 * Returns when the event source ends. A broken project file prints an error,
 * and the loop goes on.
 */
export async function watchLoop(
  io: CliIo,
  session: Session,
  first: SyncResult,
  events: AsyncIterable<readonly string[]>,
  options: BuildOptions,
): Promise<WatchResult> {
  let builds = 0;
  const round = async (synced: SyncResult): Promise<void> => {
    switch (synced.tag) {
      case "unchanged":
        return;
      case "read-error":
        io.stderr(`error: ${synced.message}\n`);
        return;
      case "config-error":
        io.stderr(`error: ${synced.message}\n`);
        return;
      case "revision": {
        builds++;
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
  io.stderr(`watching ${session.root}\n`);
  for await (const _batch of events) {
    await round(session.sync());
  }
  return { builds };
}
