// The difference between two file maps, in the shape that `Program.update`
// takes. The command-line tool and the language server both use it.

/** The files to set and the paths to remove, so that `known` becomes `wanted`. */
export interface FileDiff {
  readonly set: Map<string, string>;
  readonly remove: string[];
}

/**
 * A path is in `set` when `wanted` holds a text that `known` lacks or holds
 * with another text. A path is in `remove` when `known` holds it and `wanted`
 * does not. Both lists keep the order of their source map.
 */
export function diffFiles(
  known: ReadonlyMap<string, string>,
  wanted: ReadonlyMap<string, string>,
): FileDiff {
  const set = new Map<string, string>();
  for (const [path, text] of wanted) {
    if (known.get(path) !== text) set.set(path, text);
  }
  const remove = [...known.keys()].filter((path) => !wanted.has(path));
  return { set, remove };
}
