// Codec construction and its two directions. Prelude dispatch checks arity
// and records lowering facts before these handlers check their arguments.

import type { NodeId } from "../syntax.ts";
import { combine, type NodeInfo } from "../tables.ts";
import { dataOnly } from "../types.ts";
import type { Arg, BuiltinContext } from "./context.ts";

export function codecCall(
  c: BuiltinContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const decode = c.argInfo(args[0]);
  const encode = c.argInfo(args[1]);
  const d = c.functionOf(decode.type);
  const e = c.functionOf(encode.type);
  if (
    d === undefined || e === undefined || d.parameters.length !== 1 ||
    e.parameters.length !== 1
  ) {
    c.report(
      "type-mismatch/010",
      "`codec` needs two single-argument functions",
      node,
    );
    return c.finish(node, c.table.error, combine([decode, encode]));
  }
  if (
    d.execution !== "pure" || e.execution !== "pure" || d.failures.length ||
    d.requirements.length || e.failures.length || e.requirements.length
  ) {
    c.report(
      "execution-mode/001",
      "codec transformations must be pure",
      node,
    );
  }
  const decoded = c.widen(d.result);
  const encoded = c.widen(d.parameters[0]);
  if (
    !c.table.isAssignable(decoded, e.parameters[0]) ||
    !c.table.isAssignable(e.result, encoded)
  ) {
    c.report(
      "type-mismatch/003",
      "codec encode transformation must reverse the decode types",
      args[1].node,
    );
  }
  if (
    !dataOnly(c.table, decoded, "codec", true) ||
    !dataOnly(c.table, encoded, "codec", true)
  ) {
    c.report(
      "type-mismatch/010",
      "codec types need compiler-derived schemas",
      node,
    );
  }
  return c.finish(
    node,
    c.table.codec(decoded, encoded),
    combine([decode, encode]),
  );
}

export function codecOperation(
  c: BuiltinContext,
  node: NodeId,
  name: "decode" | "encode",
  args: readonly Arg[],
): NodeInfo {
  const codec = c.argInfo(args[0]);
  const type = c.table.node(c.table.unfold(codec.type));
  if (type.kind !== "codec" && !c.isError(codec.type)) {
    c.report(
      "type-mismatch/010",
      `\`${name}\` needs a Codec value`,
      args[0].node,
    );
  }
  const input = c.argInfo(
    args[1],
    name === "encode" && type.kind === "codec" ? type.decoded : undefined,
  );
  if (name === "encode" && type.kind === "codec") {
    c.fits(args[1].node, input.type, type.decoded, "the codec input");
  }
  const result = type.kind === "codec"
    ? c.table.option(name === "decode" ? type.decoded : type.encoded)
    : c.table.error;
  return c.finish(node, result, combine([codec, input]));
}
