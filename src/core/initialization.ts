// The eager dependency graph of module initialization (plan section 5.4, spec
// gap Q15). A module constant depends on each declaration that its initializer
// references. A reference to a function adds every declaration that the function
// body references, transitively. A cycle that holds a constant cannot be
// initialized. Part A6a orders the emitted constants by `order`.

import type { ValueId } from "./ir.ts";
import { stronglyConnectedComponents } from "./modes.ts";

export interface InitializationGraph {
  /** Module constants in source order. */
  readonly constants: readonly ValueId[];
  /** The module-level declarations that each function or constant references directly, sorted by source order. */
  readonly references: ReadonlyMap<ValueId, readonly ValueId[]>;
  /**
   * For each constant, the other constants that must be initialized first. A
   * reference through functions counts. Sorted by source order.
   */
  readonly dependencies: ReadonlyMap<ValueId, readonly ValueId[]>;
  /** The constants in an order that satisfies `dependencies`. Source order breaks ties. */
  readonly order: readonly ValueId[];
  /** Each cycle that holds a constant, as its members in source order. */
  readonly cycles: readonly (readonly ValueId[])[];
}

interface InitializationNode {
  readonly id: ValueId;
  readonly kind: "function" | "constant";
  /** Module-level declarations that the body or initializer references. */
  readonly references: readonly ValueId[];
}

/** Builds the graph. `nodes` lists every function and constant in source order. */
export function buildInitializationGraph(
  nodes: readonly InitializationNode[],
): InitializationGraph {
  const position = new Map<ValueId, number>();
  nodes.forEach((node, i) => position.set(node.id, i));
  const edges: number[][] = nodes.map((node) =>
    [...new Set(node.references)]
      .map((id) => position.get(id))
      .filter((p): p is number => p !== undefined)
      .sort((a, b) => a - b)
  );
  const references = new Map<ValueId, readonly ValueId[]>();
  nodes.forEach((node, i) => {
    references.set(node.id, edges[i].map((p) => nodes[p].id));
  });

  const constants = nodes.filter((n) => n.kind === "constant").map((n) => n.id);

  const dependencies = new Map<ValueId, readonly ValueId[]>();
  nodes.forEach((node, start) => {
    if (node.kind !== "constant") return;
    const found = new Set<number>();
    const seen = new Set<number>([start]);
    const pending = [...edges[start]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (nodes[next].kind === "constant") {
        found.add(next);
      } else {
        pending.push(...edges[next]);
      }
    }
    dependencies.set(
      node.id,
      [...found].sort((a, b) => a - b).map((p) => nodes[p].id),
    );
  });

  const cycles: ValueId[][] = [];
  for (const component of stronglyConnectedComponents(nodes.length, edges)) {
    const selfLoop = component.length === 1 &&
      edges[component[0]].includes(component[0]);
    if (component.length === 1 && !selfLoop) continue;
    if (!component.some((p) => nodes[p].kind === "constant")) continue;
    cycles.push(component.map((p) => nodes[p].id));
  }
  // A cycle lists ids of `nodes`, so each first id has a position.
  const firstPosition = (cycle: readonly ValueId[]): number => {
    const at = position.get(cycle[0]);
    if (at === undefined) {
      throw new Error("internal: a cycle id has no position");
    }
    return at;
  };
  cycles.sort((a, b) => firstPosition(a) - firstPosition(b));

  // Kahn's algorithm. A constant in a cycle never becomes ready, so the leftover
  // constants follow in source order.
  const remaining = new Map<ValueId, Set<ValueId>>();
  for (const id of constants) {
    // Every constant got an entry in the dependency loop above.
    const found = dependencies.get(id);
    if (found === undefined) {
      throw new Error("internal: a constant has no dependency entry");
    }
    const pending = new Set(found);
    pending.delete(id);
    remaining.set(id, pending);
  }
  const order: ValueId[] = [];
  const done = new Set<ValueId>();
  while (done.size < constants.length) {
    const ready = constants.find((id) => {
      if (done.has(id)) return false;
      // `remaining` holds every constant.
      const pending = remaining.get(id);
      if (pending === undefined) {
        throw new Error("internal: a constant has no pending set");
      }
      return [...pending].every((d) => done.has(d));
    });
    const next = ready ?? constants.find((id) => !done.has(id));
    // The loop runs while a constant is left, so `find` always succeeds.
    if (next === undefined) throw new Error("internal: no constant is left");
    done.add(next);
    order.push(next);
  }

  return { constants, references, dependencies, order, cycles };
}
