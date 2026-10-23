// Emission of the Scope builtins: forkScoped and withResource.

import { callArguments, type Emitted, emitted } from "../emitted.ts";
import { internal } from "../scope.ts";
import type { ExprOf } from "../shape.ts";
import type { ExprCore } from "./context.ts";

export type ScopeLeafKind = "fork-scoped" | "with-resource";

export function scopeLeaf(
  c: ExprCore,
  e: ExprOf<ScopeLeafKind>,
  children: readonly Emitted[],
): Emitted {
  const effect = c.scope.effect("Effect");
  switch (e.kind) {
    case "fork-scoped":
      return emitted([
        `${effect}.as`,
        callArguments([
          emitted([`${effect}.forkScoped`, callArguments([children[0]])]),
          emitted("undefined"),
        ]),
      ]);
    case "with-resource": {
      if (
        e.acquire.kind !== "closure" || e.use.kind !== "closure" ||
        e.release.kind !== "closure"
      ) {
        throw internal("with-resource requires three closures");
      }
      const acquire = c.closure(e.acquire, false, true);
      const use = c.closure(e.use, false, true);
      const release = c.closure(e.release, false, true);
      return emitted([
        `${effect}.acquireUseRelease`,
        callArguments([
          emitted([`${effect}.suspend`, callArguments([acquire])]),
          use,
          release,
        ]),
      ]);
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}
