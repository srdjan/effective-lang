// Pattern checking for `match`. These functions check the pattern of one arm
// against the domain of the subject, track which values the arms cover, and
// report coverage and reachability errors. `BodyChecker` calls `pattern` for
// each arm and `checkCoverage` once after the last arm.

import type { DiagnosticCode } from "./diagnostics.ts";
import { isErrorId, shortName } from "./ids.ts";
import type { LocalId } from "./ir.ts";
import {
  describeLiteral,
  type Domain,
  narrowTagged,
  taggedValues,
} from "./patterns.ts";
import { type Target, targetText } from "./resolve.ts";
import { kindOf, type NodeId, SyntaxKind, type SyntaxTree } from "./syntax.ts";
import { literalOf, nameTextOf } from "./syntax_queries.ts";
import type { BodyTable, NodeFact, PatternFact } from "./tables.ts";
import type { TypeRef, TypeTable } from "./types.ts";

/** What the pattern checker needs from the body checker. */
export interface PatternContext {
  readonly tree: SyntaxTree;
  readonly table: TypeTable;
  readonly targets: ReadonlyMap<NodeId, Target>;
  readonly body: Pick<BodyTable, "locals">;
  kids(node: NodeId): NodeId[];
  kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[];
  report(code: DiagnosticCode, message: string, node: NodeId): void;
  fact(node: NodeId, fact: NodeFact): void;
}

export interface MatchState {
  wildcard: boolean;
  readonly covered: Set<string>;
  /** The discriminator field of a tagged match, once an arm names it. */
  tagField: string | undefined;
}

/**
 * The values that a match still needs, or undefined when the domain has no
 * coverage rule (the error type and unsupported types).
 */
function missingOf(domain: Domain, state: MatchState): string[] | undefined {
  const missing: string[] = [];
  switch (domain.kind) {
    case "option":
      if (!state.covered.has("Some")) missing.push("Some(_)");
      if (!state.covered.has("None")) missing.push("None");
      return missing;
    case "nominal":
      for (const id of domain.ids) {
        if (!state.covered.has(`N:${id}`)) {
          missing.push(`${shortName(id)}(_)`);
        }
      }
      return missing;
    case "literals":
      for (const value of domain.values) {
        if (!state.covered.has(`L:${JSON.stringify(value)}`)) {
          missing.push(describeLiteral(value));
        }
      }
      return missing;
    case "open":
      return ["_"];
    case "tagged": {
      const field = state.tagField;
      if (field === undefined) {
        return domain.members.length > 0 ? ["a tagged arm"] : [];
      }
      if (domain.members.some((m) => !m.literals.has(field))) return ["_"];
      for (const value of taggedValues(domain.members, field)) {
        if (!state.covered.has(`T:${field}:${JSON.stringify(value)}`)) {
          missing.push(`{ ${field}: ${describeLiteral(value)} }`);
        }
      }
      return missing;
    }
    case "error":
    case "mixed":
    case "unsupported":
      return undefined;
  }
}

export function checkCoverage(
  c: PatternContext,
  node: NodeId,
  domain: Domain,
  state: MatchState,
  armCount: number,
): void {
  const missing = missingOf(domain, state);
  if (missing === undefined) return;
  if (missing.length === 0 && armCount > 0) return;
  c.report(
    "pattern/001",
    missing.length === 0
      ? "the match has no arms"
      : `the match is not exhaustive; it needs ${missing.join(", ")}`,
    node,
  );
}

/** Reports a duplicate or unreachable arm. Returns true when the arm can run. */
function reach(
  c: PatternContext,
  node: NodeId,
  state: MatchState,
  key: string | undefined,
): boolean {
  if (state.wildcard) {
    c.report(
      "pattern/002",
      "this arm is unreachable, because an earlier `_` arm matches every value",
      node,
    );
    return false;
  }
  if (key !== undefined) {
    if (state.covered.has(key)) {
      c.report(
        "pattern/002",
        "this arm is unreachable, because an earlier arm matches the same value",
        node,
      );
      return false;
    }
    state.covered.add(key);
  }
  return true;
}

function foreign(
  c: PatternContext,
  node: NodeId,
  what: string,
  domain: Domain,
): void {
  c.report(
    "pattern/003",
    `${what} does not belong to the subject (${describeDomain(domain)})`,
    node,
  );
}

function bindLocal(
  c: PatternContext,
  nameNode: NodeId | undefined,
  type: TypeRef,
): LocalId | undefined {
  if (nameNode === undefined) return undefined;
  const target = c.targets.get(nameNode);
  if (target?.kind !== "local") return undefined;
  c.body.locals.set(target.id, type);
  return target.id;
}

function patternFact(
  c: PatternContext,
  node: NodeId,
  pattern: PatternFact,
): void {
  c.fact(node, { kind: "pattern", pattern });
}

export function pattern(
  c: PatternContext,
  node: NodeId,
  domain: Domain,
  state: MatchState,
): void {
  const kind = kindOf(c.tree, node);
  const names = c.kidsOfKind(node, SyntaxKind.Name);
  const silent = domain.kind === "error" || domain.kind === "mixed" ||
    domain.kind === "unsupported";
  switch (kind) {
    case SyntaxKind.WildcardPattern: {
      if (reach(c, node, state, undefined)) {
        const needed = missingOf(domain, state);
        if (needed !== undefined && needed.length === 0) {
          c.report(
            "pattern/002",
            "this arm is unreachable, because the earlier arms already cover every value",
            node,
          );
        }
      }
      state.wildcard = true;
      patternFact(c, node, { kind: "wildcard" });
      return;
    }
    case SyntaxKind.NamePattern: {
      const target = names[0] === undefined
        ? undefined
        : c.targets.get(names[0]);
      if (target?.kind === "builtin" && target.name === "None") {
        if (domain.kind === "option") {
          reach(c, node, state, "None");
        } else if (!silent) {
          foreign(c, node, "`None`", domain);
        }
        patternFact(c, node, { kind: "none" });
      } else {
        if (target !== undefined && target.kind !== "unresolved") {
          c.report(
            "pattern/004",
            "a constructor pattern needs a binding, as in `Some(x)` or `E(x)`",
            node,
          );
        }
        patternFact(c, node, { kind: "invalid" });
      }
      return;
    }
    case SyntaxKind.CtorPattern: {
      const target = names[0] === undefined
        ? undefined
        : c.targets.get(names[0]);
      const bindingNode = names[1];
      if (target?.kind === "builtin" && target.name === "Some") {
        let element = c.table.error;
        if (domain.kind === "option") {
          element = domain.element;
          reach(c, node, state, "Some");
        } else if (!silent) {
          foreign(c, node, "`Some`", domain);
        }
        const binding = bindLocal(c, bindingNode, element);
        patternFact(c, node, { kind: "some", binding });
      } else if (target?.kind === "builtin") {
        c.report(
          "pattern/004",
          `\`${target.name}\` cannot be a constructor pattern with a binding`,
          node,
        );
        bindLocal(c, bindingNode, c.table.error);
        patternFact(c, node, { kind: "invalid" });
      } else if (target?.kind === "error") {
        let type = c.table.error;
        if (domain.kind === "nominal" && domain.ids.includes(target.id)) {
          type = c.table.named(target.id);
          reach(c, node, state, `N:${target.id}`);
        } else if (!silent) {
          foreign(c, node, `\`${shortName(target.id)}\``, domain);
        }
        const binding = bindLocal(c, bindingNode, type);
        patternFact(c, node, { kind: "error", error: target.id, binding });
      } else if (
        target?.kind === "type" && c.table.dataRecordOf(target.id) !== undefined
      ) {
        let type = c.table.error;
        if (domain.kind === "nominal" && domain.ids.includes(target.id)) {
          type = c.table.named(target.id);
          reach(c, node, state, `N:${target.id}`);
        } else if (!silent) {
          foreign(c, node, `\`${shortName(target.id)}\``, domain);
        }
        const binding = bindLocal(c, bindingNode, type);
        patternFact(c, node, { kind: "data", data: target.id, binding });
      } else {
        // The resolver already reported a missing or wrong-kind name.
        if (target !== undefined && target.kind !== "unresolved") {
          c.report(
            "pattern/004",
            target.kind === "type"
              ? `\`${shortName(target.id)}\` is ${
                c.table.brandBaseOf(target.id) !== undefined
                  ? "a brand"
                  : "a type alias"
              }, not a data type; a constructor pattern names a data type or an error`
              : `\`${targetText(target)}\` cannot be a constructor pattern`,
            node,
          );
        }
        bindLocal(c, bindingNode, c.table.error);
        patternFact(c, node, { kind: "invalid" });
      }
      return;
    }
    case SyntaxKind.LiteralPattern: {
      const value = literalOf(c.tree, node);
      if (value === undefined) {
        patternFact(c, node, { kind: "invalid" });
        return;
      }
      let fits = false;
      if (domain.kind === "literals") {
        fits = domain.values.includes(value);
      } else if (domain.kind === "open") {
        fits = domain.primitive === "string"
          ? typeof value === "string"
          : domain.primitive === "int"
          ? typeof value === "number" && Number.isSafeInteger(value)
          : typeof value === "number";
      }
      if (fits) {
        reach(c, node, state, `L:${JSON.stringify(value)}`);
      } else if (!silent) {
        foreign(c, node, describeLiteral(value), domain);
      }
      patternFact(c, node, { kind: "literal", value });
      return;
    }
    case SyntaxKind.RecordPattern:
      recordPattern(c, node, domain, state, silent);
      return;
    default:
      patternFact(c, node, { kind: "invalid" });
  }
}

function recordPattern(
  c: PatternContext,
  node: NodeId,
  domain: Domain,
  state: MatchState,
  silent: boolean,
): void {
  const parts = c.kids(node);
  const fields = parts.filter((k) =>
    kindOf(c.tree, k) === SyntaxKind.PatternField
  );
  const spread = parts.find((k) =>
    kindOf(c.tree, k) === SyntaxKind.SpreadPattern
  );
  const spreadName = spread === undefined
    ? undefined
    : c.kidsOfKind(spread, SyntaxKind.Name)[0];
  const invalid = (
    message?: string,
    code: DiagnosticCode = "pattern/004",
  ): void => {
    if (message !== undefined) c.report(code, message, node);
    bindLocal(c, spreadName, c.table.error);
    patternFact(c, node, { kind: "invalid" });
  };
  if (domain.kind === "nominal") {
    return invalid(
      `a record pattern does not apply to ${
        describeDomain(domain)
      }; match each by name, as in \`Name(x)\``,
    );
  }
  if (domain.kind !== "tagged") {
    if (silent) return invalid();
    foreign(c, node, "a tagged record pattern", domain);
    return invalid();
  }
  if (fields.length !== 1) {
    return invalid(
      'a tagged record pattern needs exactly one discriminator field, as in `{ kind: "circle", ...c }`',
    );
  }
  const fieldParts = c.kids(fields[0]);
  const labelNode = fieldParts.find((k) =>
    kindOf(c.tree, k) === SyntaxKind.Name
  );
  const literalNode = fieldParts.find((k) =>
    kindOf(c.tree, k) === SyntaxKind.LiteralPattern
  );
  const label = labelNode === undefined
    ? undefined
    : nameTextOf(c.tree, labelNode);
  const value = literalNode === undefined
    ? undefined
    : literalOf(c.tree, literalNode);
  if (label === undefined || value === undefined) return invalid();
  if (typeof value !== "string") {
    return invalid(
      "the discriminator of a tagged record pattern must be a string literal",
    );
  }
  if (state.tagField !== undefined && state.tagField !== label) {
    return invalid(
      `an earlier arm matches on the field \`${state.tagField}\`; every arm must use the same discriminator field`,
    );
  }
  state.tagField = label;
  const known = taggedValues(domain.members, label);
  const narrowed = narrowTagged(c.table, domain.members, label, value).map(
    (m) => m.type,
  );
  if (narrowed.length === 0) {
    foreign(
      c,
      node,
      known.length === 0
        ? `the field \`${label}\``
        : `${label}: ${describeLiteral(value)}`,
      domain,
    );
    return invalid();
  }
  reach(c, node, state, `T:${label}:${JSON.stringify(value)}`);
  const binding = bindLocal(c, spreadName, c.table.union(narrowed));
  patternFact(c, node, {
    kind: "tag",
    field: label,
    value,
    binding: binding ?? null,
  });
}

function describeDomain(domain: Domain): string {
  switch (domain.kind) {
    case "option":
      return "an option";
    case "nominal":
      return `${domain.ids.every(isErrorId) ? "the errors" : "the names"} ${
        domain.ids.map(shortName).join(" | ")
      }`;
    case "tagged":
      return "a tagged record union";
    case "literals":
      return `the values ${domain.values.map(describeLiteral).join(" | ")}`;
    case "open":
      return `a ${domain.primitive}`;
    case "mixed":
    case "error":
    case "unsupported":
      return "an unsupported type";
  }
}
