// Emission of the collection builtins: partitionAll, validateAll, allResults.

import {
  callArguments,
  concurrencyArguments,
  concurrencyText,
  type Emitted,
  emitted,
} from "../emitted.ts";
import type { ExprOf } from "../shape.ts";
import type { ExprCore } from "./context.ts";

export type CollectionsLeafKind =
  | "partition-all"
  | "validate-all"
  | "all-results";

export function collectionsLeaf(
  c: ExprCore,
  e: ExprOf<CollectionsLeafKind>,
  children: readonly Emitted[],
): Emitted {
  const effect = c.scope.effect("Effect");
  switch (e.kind) {
    case "partition-all":
      return emitted([
        `${effect}.partition`,
        callArguments([
          children[0],
          emitted("(job) => job"),
          ...concurrencyArguments(e.concurrency),
        ]),
      ]);
    case "validate-all":
      return emitted([
        `${effect}.mapError`,
        callArguments([
          emitted([
            `${effect}.validate`,
            callArguments([
              children[0],
              emitted("(job) => job"),
              ...concurrencyArguments(e.concurrency),
            ]),
          ]),
          children[1],
        ]),
      ]);
    case "all-results":
      return emitted([
        `${effect}.all`,
        callArguments([
          children[0],
          emitted(
            `{ mode: "result"${
              e.concurrency === undefined
                ? ""
                : `, concurrency: ${concurrencyText(e.concurrency)}`
            } }`,
          ),
        ]),
      ]);
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}
