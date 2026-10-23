// Emission of the Fiber builtins: withFiber, joinFiber, and interruptFiber.

import { callArguments, type Emitted, emitted } from "../emitted.ts";
import type { ExprOf } from "../shape.ts";
import type { ExprCore } from "./context.ts";

export type FiberLeafKind = "with-fiber" | "join-fiber" | "interrupt-fiber";

export function fiberLeaf(
  c: ExprCore,
  e: ExprOf<FiberLeafKind>,
  children: readonly Emitted[],
): Emitted {
  const effect = c.scope.effect("Effect");
  switch (e.kind) {
    case "with-fiber": {
      const fiber = c.scope.effect("Fiber");
      const job = children[0] ?? c.pure(e.job);
      return emitted([
        `${effect}.acquireUseRelease`,
        callArguments([
          emitted([`${effect}.forkChild`, callArguments([job])]),
          c.effectCallback(e.use),
          emitted(`${fiber}.interrupt`),
        ]),
      ]);
    }
    case "join-fiber":
    case "interrupt-fiber": {
      const fiber = c.scope.effect("Fiber");
      return emitted([
        `${fiber}.${e.kind === "join-fiber" ? "join" : "interrupt"}`,
        callArguments([children[0] ?? c.pure(e.fiber)]),
      ]);
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}
