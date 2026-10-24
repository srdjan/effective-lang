// Validation of the Codec builtins: codec, decode, and encode.

import type { Expr } from "../../ir.ts";
import { AREA } from "../report.ts";
import { combine, invocationOf, isQuiet } from "../sets.ts";
import {
  asFunction,
  dataOnly,
  fits,
  foreignSealedOf,
  unfold,
} from "../typing.ts";
import { type Comp, derivedResult, type ValidatorCore } from "./context.ts";

export function codec(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "codec" }>,
  path: string,
): Comp {
  const decode = c.check(e.decode, `${path}.decode`);
  const encode = c.check(e.encode, `${path}.encode`);
  const d = asFunction(c.env, decode.type);
  const en = asFunction(c.env, encode.type);
  if (
    d === undefined || en === undefined || d.parameters.length !== 1 ||
    en.parameters.length !== 1
  ) {
    c.add(
      AREA.types,
      path,
      "codec needs two single-argument functions",
      e.span,
    );
    return c.poison();
  }
  if (!isQuiet(invocationOf(d)) || !isQuiet(invocationOf(en))) {
    c.add(
      AREA.control,
      path,
      "codec transformations must be pure",
      e.span,
    );
  }
  if (
    !fits(c.env, d.result, en.parameters[0]) ||
    !fits(c.env, en.result, d.parameters[0])
  ) {
    c.add(
      AREA.types,
      path,
      "codec encode transformation must reverse decode types",
      e.span,
    );
  }
  if (
    !dataOnly(c.env, d.result, "codec") ||
    !dataOnly(c.env, d.parameters[0], "codec")
  ) {
    c.add(
      AREA.types,
      path,
      "codec types need compiler-derived schemas",
      e.span,
    );
  }
  if (
    foreignSealedOf(c.env, d.result) !== undefined ||
    foreignSealedOf(c.env, d.parameters[0]) !== undefined
  ) {
    c.add(
      AREA.types,
      path,
      "a foreign module cannot derive a Codec for a sealed nominal type",
      e.span,
    );
  }
  return derivedResult(
    { kind: "codec", decoded: d.result, encoded: d.parameters[0] },
    combine([decode, encode]),
    "fit",
  );
}

export function codecOperation(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "decode" | "encode" }>,
  path: string,
): Comp {
  const codec = c.check(e.codec, `${path}.codec`);
  const input = c.check(e.input, `${path}.input`);
  const type = unfold(c.env, codec.type);
  if (type.kind !== "codec") {
    c.add(
      AREA.types,
      `${path}.codec`,
      `${e.kind} needs a Codec value`,
      e.codec.span,
    );
    return c.poison();
  }
  if (e.kind === "encode" && !fits(c.env, input.type, type.decoded)) {
    c.add(
      AREA.types,
      `${path}.input`,
      "encode input does not fit decoded type",
      e.input.span,
    );
  }
  return derivedResult({
    kind: "option",
    element: e.kind === "decode" ? type.decoded : type.encoded,
  }, combine([codec, input]));
}
