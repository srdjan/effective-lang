// Execution modes of recursive groups (design I1 and I4). Modules are acyclic,
// so a strongly connected component of the module-local call graph never spans
// modules. The solver starts every pending member at `pure`, runs one round of
// body checks against the current modes, and repeats until no mode changes. A
// mode only moves from `pure` to `effect`, so the rounds end. A round cap guards
// the loop all the same.

import type { Execution, ValueId } from "./ir.ts";

/** The most rounds that one group may take (design 4.6, resource caps). */
export const ROUND_CAP = 32;

/**
 * Strongly connected components of a graph over the nodes `0 .. count - 1`. The
 * result lists components so that a component comes after every component that
 * it reaches: callees before callers. A component lists its nodes in ascending
 * order. `edges[n]` lists the nodes that `n` points to.
 */
export function stronglyConnectedComponents(
  count: number,
  edges: readonly (readonly number[])[],
): number[][] {
  const index = new Array<number>(count).fill(-1);
  const low = new Array<number>(count).fill(0);
  const onStack = new Array<boolean>(count).fill(false);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;

  // An explicit stack keeps long reference chains from overflowing the call stack.
  const visit = (root: number): void => {
    const frames: { node: number; next: number }[] = [{ node: root, next: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const targets = edges[frame.node] ?? [];
      if (frame.next < targets.length) {
        const next = targets[frame.next++];
        if (index[next] < 0) {
          index[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = true;
          frames.push({ node: next, next: 0 });
        } else if (onStack[next]) {
          low[frame.node] = Math.min(low[frame.node], index[next]);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        low[parent.node] = Math.min(low[parent.node], low[frame.node]);
      }
      if (low[frame.node] !== index[frame.node]) continue;
      const component: number[] = [];
      for (
        let member = stack.pop();
        member !== undefined;
        member = stack.pop()
      ) {
        onStack[member] = false;
        component.push(member);
        if (member === frame.node) break;
      }
      components.push(component.sort((a, b) => a - b));
    }
  };
  for (let n = 0; n < count; n++) {
    if (index[n] < 0) visit(n);
  }
  return components;
}

/** What one round of body checks returns. */
export interface Round<R> {
  /** The checks of this round. The last round's results are the final ones. */
  readonly results: R;
  /** The mode that each pending member computed against the assumed modes. */
  readonly computed: ReadonlyMap<ValueId, Execution>;
}

export interface GroupSolution<R> {
  /** The settled modes of the pending members. */
  readonly modes: ReadonlyMap<ValueId, Execution>;
  /** The results of the last round. When `settled`, they used the final modes. */
  readonly results: R;
  readonly rounds: number;
  /** False when the round cap ended the loop. */
  readonly settled: boolean;
}

/**
 * Solves the mode equations of one group. `pending` lists the members whose
 * mode the body decides. `round` checks every member of the group against the
 * assumed modes.
 */
export function solveModeGroup<R>(
  pending: readonly ValueId[],
  round: (assumed: ReadonlyMap<ValueId, Execution>) => Round<R>,
  cap: number = ROUND_CAP,
): GroupSolution<R> {
  let modes = new Map<ValueId, Execution>(pending.map((id) => [id, "pure"]));
  for (let rounds = 1;; rounds++) {
    const result = round(modes);
    const next = new Map(modes);
    let changed = false;
    for (const id of pending) {
      const before = modes.get(id) ?? "pure";
      const computed = result.computed.get(id) ?? "pure";
      const after: Execution = before === "effect" || computed === "effect"
        ? "effect"
        : "pure";
      if (after !== before) changed = true;
      next.set(id, after);
    }
    if (!changed) {
      return { modes, results: result.results, rounds, settled: true };
    }
    modes = next;
    if (rounds >= cap) {
      return { modes, results: result.results, rounds, settled: false };
    }
  }
}
