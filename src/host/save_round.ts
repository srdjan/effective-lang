// The output step of a save round, shared by `build`, `watch`, and the
// language server: remove the outputs of modules that left the project, then
// write the outputs of every writable module that the project owns.
//
// The round is synchronous and prints and logs nothing. It returns one removal
// record per module, so that each caller keeps its own messages and their order.

import type { Diagnostic, Revision } from "../core/mod.ts";
import type { CliFs } from "./io.ts";
import { generationSource } from "./generation.ts";
import {
  type GeneratedOutputs,
  removeStaleOutputs,
  writableModules,
  writeGenerated,
} from "./outputs.ts";

/** What a round does with a module whose output removal failed. */
export type RemovalRule =
  /** Keep the module in `modules`, so that the next round tries again (LSP). */
  | "retry"
  /** Drop the module, so that no later round tries again (CLI watch). */
  | "forget";

export interface SaveRoundInput {
  readonly fs: CliFs;
  readonly root: string;
  readonly revision: Revision;
  /** The `modules` of the previous round. `build` passes `[]` and removes nothing. */
  readonly previous: readonly string[];
  readonly removal: RemovalRule;
  /** False for a module that a nested project owns. The CLI passes `() => true`. */
  readonly owns: (name: string) => boolean;
  readonly validation?: ReadonlyMap<string, readonly Diagnostic[]>;
  readonly write: boolean;
}

/** The removal of the outputs of one module that left the project. */
export interface ModuleRemoval {
  readonly name: string;
  readonly removed: readonly string[];
  readonly notes: readonly string[];
}

export interface SaveRound {
  /** Pass this as `previous` to the next round. */
  readonly modules: readonly string[];
  /** One entry per module that left, in the order of `previous`. */
  readonly removals: readonly ModuleRemoval[];
  /** The writable modules, before the `owns` filter. */
  readonly writable: readonly string[];
  readonly outputs: GeneratedOutputs;
}

export function runSaveRound(input: SaveRoundInput): SaveRound {
  const { fs, root, revision, owns } = input;
  const names = revision.effModuleNames();
  const present = new Set(names);
  const removals: ModuleRemoval[] = [];
  const kept: string[] = [];
  for (const name of input.previous) {
    if (present.has(name) || !owns(name)) continue;
    const { removed, notes } = removeStaleOutputs(fs, root, [name]);
    removals.push({ name, removed, notes });
    if (input.removal === "retry" && notes.length > 0) kept.push(name);
  }
  const writable = writableModules(revision, input.validation);
  const outputs = writeGenerated(
    fs,
    root,
    generationSource(revision),
    writable.filter(owns),
    input.write,
  );
  return { modules: [...names, ...kept], removals, writable, outputs };
}
