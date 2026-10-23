// Emission of the codec builtins: codec, decode, and encode.

import {
  at,
  callArguments,
  type Emitted,
  emitted,
  free,
  type Kid,
  PREC,
} from "../emitted.ts";
import { internal } from "../scope.ts";
import type { ExprOf } from "../shape.ts";
import { schemaDoc, typeDoc } from "../types.ts";
import type { ExprCore } from "./context.ts";

export type CodecStructuralKind = "codec" | "decode" | "encode";

export function codecStructural(
  c: ExprCore,
  e: ExprOf<CodecStructuralKind>,
  kid: Kid,
): Emitted {
  switch (e.kind) {
    case "codec": {
      const type = c.scope.resolve(e.type);
      if (type.kind !== "codec") throw internal("codec has wrong type");
      const schema = c.scope.effect("Schema");
      const option = c.scope.effect("Option");
      const decode = c.pure(e.decode);
      const encode = c.pure(e.encode);
      const encodedSchema = schemaDoc(c.scope, type.encoded);
      const decodedSchema = schemaDoc(c.scope, type.decoded);
      const input = c.scope.temp();
      const value = c.scope.temp();
      return emitted([
        "{ decode: (",
        input,
        ": unknown) => { try { return ",
        `${option}.flatMap(`,
        `${schema}.decodeUnknownOption(`,
        encodedSchema,
        ")(",
        free(
          c.adaptedInput(emitted(input), type.encoded, "encoded", true),
        ),
        "), (",
        value,
        ") => ",
        `${schema}.decodeUnknownOption(`,
        decodedSchema,
        ")(",
        free(
          c.adaptedInput(
            emitted([at(decode, PREC.member), "(", value, ")"]),
            type.decoded,
            "decoded",
            true,
          ),
        ),
        ")); } catch { return ",
        `${option}.none()`,
        "; } }, ",
        "encode: (",
        input,
        ": ",
        typeDoc(c.scope, type.decoded),
        ") => { try { return ",
        `${option}.flatMap(`,
        `${schema}.decodeUnknownOption(`,
        decodedSchema,
        ")(",
        free(
          c.adaptedInput(emitted(input), type.decoded, "decoded", true),
        ),
        "), (",
        value,
        ") => ",
        `${schema}.decodeUnknownOption(`,
        encodedSchema,
        ")(",
        free(
          c.adaptedInput(
            emitted([at(encode, PREC.member), "(", value, ")"]),
            type.encoded,
            "encoded",
            true,
          ),
        ),
        ")); } catch { return ",
        `${option}.none()`,
        "; } } }",
      ]);
    }
    case "decode":
    case "encode":
      return emitted([
        at(kid(e.codec), PREC.member),
        ".",
        e.kind,
        callArguments([kid(e.input)]),
      ]);
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}
