// Mutable reference construction, reads, writes and pure update callbacks.
// Prelude dispatch checks arity and records facts before this handler runs.

import type { NodeId } from "../syntax.ts";
import { combine, EFFECT_ONLY, type NodeInfo } from "../tables.ts";
import type { Arg, BuiltinContext } from "./context.ts";

export function refCall(
  c: BuiltinContext,
  node: NodeId,
  name: "makeRef" | "getRef" | "setRef" | "updateRef",
  args: readonly Arg[],
): NodeInfo {
  const first = c.argInfo(args[0]);
  if (name === "makeRef") {
    return c.finish(
      node,
      c.table.ref(c.widen(first.type)),
      combine([first, EFFECT_ONLY]),
    );
  }
  const ref = c.table.node(c.table.unfold(first.type));
  if (ref.kind !== "ref" && !c.isError(first.type)) {
    c.report(
      "type-mismatch/010",
      `\`${name}\` needs a Ref value`,
      args[0].node,
    );
  }
  const element = ref.kind === "ref" ? ref.element : c.table.error;
  if (name === "getRef") {
    return c.finish(node, element, combine([first, EFFECT_ONLY]));
  }
  if (name === "setRef") {
    const value = c.argInfo(args[1], element);
    c.fits(args[1].node, value.type, element, "the new Ref value");
    return c.finish(
      node,
      c.table.unit,
      combine([first, value, EFFECT_ONLY]),
    );
  }
  const transform = c.callback(name, args[1], [element], element);
  c.fits(args[1].node, transform.result, element, "the updated Ref value");
  return c.finish(
    node,
    c.table.unit,
    combine([first, transform.info, EFFECT_ONLY]),
  );
}
