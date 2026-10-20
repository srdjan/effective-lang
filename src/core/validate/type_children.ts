// The child types of a type. The three type walkers of world.ts descend
// through `typeChildren`, so a new Type kind is a compile error here and
// nowhere else. A child comes with the IR path suffix that diagnostics use.

import type { Type } from "../ir.ts";

/** A child type and the IR path suffix from its parent, such as `.fields[0].type`. */
export interface TypeChild {
  readonly type: Type;
  readonly suffix: string;
}

const child = (type: Type, suffix: string): TypeChild => ({ type, suffix });

/**
 * The child types of `t`, in the order the walkers visit them. Identities
 * (failure and capability ids) are not child types. A leaf has no children.
 */
export function typeChildren(t: Type): readonly TypeChild[] {
  switch (t.kind) {
    case "primitive":
    case "literal":
    case "named":
    case "closeable-scope":
    case "provider":
      return [];
    case "record":
      return t.fields.map((f, i) => child(f.type, `.fields[${i}].type`));
    case "array":
    case "option":
    case "ref":
      return [child(t.element, ".element")];
    case "retry-schedule":
      return [child(t.error, ".error")];
    case "codec":
      return [child(t.decoded, ".decoded"), child(t.encoded, ".encoded")];
    case "schema":
      return t.makeInput === undefined
        ? [child(t.decoded, ".decoded"), child(t.encoded, ".encoded")]
        : [
          child(t.decoded, ".decoded"),
          child(t.encoded, ".encoded"),
          child(t.makeInput, ".makeInput"),
        ];
    case "fiber":
    case "effect":
      return [child(t.result, ".result")];
    case "stream":
      return [child(t.element, ".element")];
    case "schedule":
      return [child(t.output, ".output"), child(t.input, ".input")];
    case "sink":
      return t.leftover === undefined
        ? [child(t.input, ".input"), child(t.result, ".result")]
        : [
          child(t.input, ".input"),
          child(t.result, ".result"),
          child(t.leftover, ".leftover"),
        ];
    case "tuple":
      return t.elements.map((e, i) => child(e, `.elements[${i}]`));
    case "union":
      return t.members.map((m, i) => child(m, `.members[${i}]`));
    case "function":
      return [
        ...t.parameters.map((p, i) => child(p, `.parameters[${i}]`)),
        child(t.result, ".result"),
      ];
    default: {
      const unreachable: never = t;
      return unreachable;
    }
  }
}
