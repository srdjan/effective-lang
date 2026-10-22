import { fieldKey, sensitiveField } from "./fields.ts";
// Declarations and their order (plan section 6.5), and the export rule (I8).

import type {
  CapabilityId,
  ConstantDecl,
  Declaration,
  DeclarationId,
  ErrorDecl,
  FunctionDecl,
  ModuleIR,
  ServiceDecl,
  Type,
  TypeDecl,
  ValueId,
} from "../ir.ts";
import { SCOPE_CAPABILITY } from "../ir.ts";
import {
  assignment,
  braces,
  bracketed,
  callWith,
  type Doc,
  group,
  hard,
  ifBreak,
  indent,
  line,
  marked,
  member,
  property,
  soft,
} from "./doc.ts";
import { at, ExprEmitter } from "./expr.ts";
import {
  type Scope,
  serviceOfCapability,
  tokenOfId,
  unsupported,
} from "./scope.ts";
import {
  effectTypeDoc,
  encodedTypeDoc,
  schemaDoc,
  typeArguments,
  typeDoc,
} from "./types.ts";
import { valueReferences } from "./walk.ts";

const LINE_WIDTH = 80;

// ------------------------------------------------------------------ references

/** The type-level declarations that a type names, directly. */
function namedIn(type: Type, out: Set<DeclarationId>): void {
  switch (type.kind) {
    case "primitive":
    case "literal":
    case "closeable-scope":
      return;
    case "named":
      out.add(type.id);
      return;
    case "record":
      for (const f of type.fields) namedIn(f.type, out);
      return;
    case "array":
    case "option":
    case "ref":
      namedIn(type.element, out);
      return;
    case "retry-schedule":
      namedIn(type.error, out);
      return;
    case "codec":
      namedIn(type.decoded, out);
      namedIn(type.encoded, out);
      return;
    case "fiber":
      namedIn(type.result, out);
      effectsIn(type.failures, [], out);
      return;
    case "effect":
      namedIn(type.result, out);
      effectsIn(type.effects.failures, type.effects.requirements, out);
      return;
    case "stream":
      namedIn(type.element, out);
      effectsIn(type.effects.failures, type.effects.requirements, out);
      return;
    case "schedule":
      namedIn(type.output, out);
      namedIn(type.input, out);
      effectsIn(type.effects.failures, type.effects.requirements, out);
      return;
    case "sink":
      namedIn(type.input, out);
      namedIn(type.result, out);
      if (type.leftover !== undefined) namedIn(type.leftover, out);
      effectsIn(type.effects.failures, type.effects.requirements, out);
      return;
    case "schema":
      namedIn(type.decoded, out);
      namedIn(type.encoded, out);
      if (type.makeInput !== undefined) namedIn(type.makeInput, out);
      effectsIn([], type.decodeRequirements, out);
      effectsIn([], type.encodeRequirements, out);
      return;
    case "tuple":
      for (const t of type.elements) namedIn(t, out);
      return;
    case "union":
      for (const t of type.members) namedIn(t, out);
      return;
    case "function":
      for (const p of type.parameters) namedIn(p, out);
      namedIn(type.result, out);
      effectsIn(type.effects.failures, type.effects.requirements, out);
      return;
    case "provider":
      for (const c of type.provides) out.add(serviceOfCapability(c));
      effectsIn(
        type.acquisition.effects.failures,
        type.acquisition.effects.requirements,
        out,
      );
      return;
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

function effectsIn(
  failures: readonly DeclarationId[],
  requirements: readonly CapabilityId[],
  out: Set<DeclarationId>,
): void {
  for (const f of failures) out.add(f);
  for (const r of requirements) {
    if (r !== SCOPE_CAPABILITY) out.add(serviceOfCapability(r));
  }
}

/** The declarations that the interface of `declaration` mentions. */
function interfaceReferences(declaration: Declaration): Set<DeclarationId> {
  const out = new Set<DeclarationId>();
  switch (declaration.kind) {
    case "function":
      namedIn(declaration.type, out);
      break;
    case "constant":
      namedIn(declaration.type, out);
      break;
    case "type":
      namedIn(
        declaration.definition.kind === "alias"
          ? declaration.definition.type
          : declaration.definition.base,
        out,
      );
      break;
    case "error":
      for (const f of declaration.fields) namedIn(f.type, out);
      break;
    case "service":
      for (const m of declaration.methods) namedIn(m.type, out);
      break;
  }
  return out;
}

/** Source exports plus every declaration that the interface of an export reaches. */
export function exportedIds(ir: ModuleIR): Set<DeclarationId> {
  const byId = new Map<DeclarationId, Declaration>(
    ir.declarations.map((d) => [d.id, d]),
  );
  const seen = new Set<DeclarationId>();
  const visit = (id: DeclarationId): void => {
    if (seen.has(id)) return;
    const declaration = byId.get(id);
    if (declaration === undefined) return;
    seen.add(id);
    for (const next of interfaceReferences(declaration)) visit(next);
  };
  for (const id of ir.exports) visit(id);
  return seen;
}

// ------------------------------------------------------------------ order

type TypeLevel = TypeDecl | ErrorDecl | ServiceDecl;

function isTypeLevel(d: Declaration): d is TypeLevel {
  return d.kind === "type" || d.kind === "error" || d.kind === "service";
}

/** Dependencies before users. Source order decides everything else. */
export function orderTypeLevel(ir: ModuleIR): TypeLevel[] {
  const group = ir.declarations.filter(isTypeLevel);
  const byId = new Map<DeclarationId, TypeLevel>(group.map((d) => [d.id, d]));
  const ordered: TypeLevel[] = [];
  const state = new Map<DeclarationId, "active" | "done">();
  const visit = (declaration: TypeLevel): void => {
    if (state.has(declaration.id)) return;
    state.set(declaration.id, "active");
    const dependencies = [...interfaceReferences(declaration)]
      .flatMap((id) => {
        const dependency = byId.get(id);
        return dependency === undefined ? [] : [dependency];
      })
      .sort((a, b) => a.span.start - b.span.start);
    for (const dependency of dependencies) visit(dependency);
    state.set(declaration.id, "done");
    ordered.push(declaration);
  };
  for (const declaration of group) visit(declaration);
  return ordered;
}

/** Constants in the order of their eager dependencies (plan section 5.4). */
export function orderConstants(ir: ModuleIR): ConstantDecl[] {
  const constants = ir.declarations.filter(
    (d): d is ConstantDecl => d.kind === "constant",
  );
  const values = new Map<ValueId, FunctionDecl | ConstantDecl>();
  for (const d of ir.declarations) {
    if (d.kind === "function" || d.kind === "constant") values.set(d.id, d);
  }
  const eagerDependencies = (constant: ConstantDecl): ConstantDecl[] => {
    const found = new Map<ValueId, ConstantDecl>();
    const expanded = new Set<ValueId>();
    const pending = valueReferences(constant);
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) break;
      const target = values.get(id);
      if (target === undefined || expanded.has(id)) continue;
      expanded.add(id);
      if (target.kind === "constant") {
        found.set(id, target);
      } else {
        pending.push(...valueReferences(target));
      }
    }
    return [...found.values()].sort((a, b) => a.span.start - b.span.start);
  };
  const ordered: ConstantDecl[] = [];
  const state = new Map<ValueId, "active" | "done">();
  const visit = (constant: ConstantDecl): void => {
    const known = state.get(constant.id);
    if (known === "done") return;
    if (known === "active") {
      throw unsupported(
        `the constant ${constant.name} depends on itself`,
        constant.span,
      );
    }
    state.set(constant.id, "active");
    for (const dependency of eagerDependencies(constant)) {
      if (dependency.id !== constant.id) visit(dependency);
    }
    state.set(constant.id, "done");
    ordered.push(constant);
  };
  for (const constant of constants) visit(constant);
  return ordered;
}

// ------------------------------------------------------------------ printing

/**
 * The parameter list of a function declaration, and the result type when
 * `result` is `"always"` or when the contract is explicit. The emitter passes
 * `"contract"`. Hover passes `"always"`, because it shows the inferred result.
 */
export function functionHeaderDoc(
  scope: Scope,
  d: FunctionDecl,
  result: "contract" | "always",
): Doc {
  const parameters = bracketed(
    "(",
    ")",
    d.parameters.map((p) => property(p.name, typeDoc(scope, p.type))),
    false,
  );
  if (result === "contract" && d.contract !== "explicit") return parameters;
  const resultDoc = typeDoc(scope, d.type.result);
  const returns = d.type.execution === "effect"
    ? effectTypeDoc(scope, resultDoc, d.type.effects)
    : resultDoc;
  return [parameters, ": ", returns];
}

/** The declared type of a constant. */
export function constantTypeDoc(scope: Scope, d: ConstantDecl): Doc {
  return typeDoc(scope, d.type);
}

export class DeclarationEmitter {
  readonly expr: ExprEmitter;

  constructor(
    readonly scope: Scope,
    readonly exported: ReadonlySet<DeclarationId>,
  ) {
    this.expr = new ExprEmitter(scope);
  }

  private exportKeyword(id: DeclarationId): string {
    return this.exported.has(id) ? "export " : "";
  }

  declaration(declaration: Declaration): Doc {
    this.scope.resetTemporaries();
    switch (declaration.kind) {
      case "type":
        return this.typeDeclaration(declaration);
      case "error":
        return this.errorDeclaration(declaration);
      case "service":
        return this.serviceDeclaration(declaration);
      case "function":
        return this.functionDeclaration(declaration);
      case "constant":
        return this.constantDeclaration(declaration);
    }
  }

  private typeDeclaration(d: TypeDecl): Doc {
    const keyword = this.exportKeyword(d.id);
    if (
      d.definition.kind === "alias" &&
      (d.definition.type.kind === "record" ||
        d.definition.type.kind === "union") &&
      this.containsNamed(d.definition.type, d.id)
    ) {
      const schema = this.scope.effect("Schema");
      const mirror = this.scope.encodedMirrorName(d.id);
      return [
        keyword,
        "type ",
        d.name,
        " = ",
        typeDoc(this.scope, d.definition.type),
        ";",
        hard,
        keyword,
        "type ",
        mirror,
        " = ",
        encodedTypeDoc(this.scope, d.definition.type, d.id),
        ";",
        hard,
        keyword,
        "const ",
        d.name,
        `: ${schema}.Codec<${d.name}, ${mirror}> = `,
        schemaDoc(this.scope, d.definition.type, d.id),
        ";",
      ];
    }
    if (d.definition.kind === "alias" && this.scope.isTypeOnly(d.id)) {
      return [
        keyword,
        "type ",
        d.name,
        " = ",
        typeDoc(this.scope, d.definition.type),
        ";",
      ];
    }
    const schema = this.scope.effect("Schema");
    let value: Doc;
    if (d.definition.kind === "brand") {
      value = member(
        schemaDoc(this.scope, d.definition.base),
        "pipe",
        callWith(
          "",
          callWith(`${schema}.brand`, JSON.stringify(tokenOfId(d.id))),
        ),
      );
    } else {
      value = schemaDoc(this.scope, d.definition.type);
    }
    return [
      assignment([keyword, "const ", d.name], value),
      ";",
      hard,
      group([
        keyword,
        "type ",
        d.name,
        " =",
        indent([line, `typeof ${d.name}.Type`]),
      ]),
      ";",
    ];
  }

  private containsNamed(type: Type, id: string): boolean {
    switch (type.kind) {
      case "named":
        return type.id === id;
      case "array":
      case "option":
        return this.containsNamed(type.element, id);
      case "record":
        return type.fields.some((field) => this.containsNamed(field.type, id));
      case "union":
        return type.members.some((member) => this.containsNamed(member, id));
      default:
        return false;
    }
  }

  private errorDeclaration(d: ErrorDecl): Doc {
    const schema = this.scope.effect("Schema");
    const fields = d.fields.map((f) => {
      const inner = schemaDoc(this.scope, f.type);
      return property(
        fieldKey(f.name),
        f.optional ? member(schema, "optionalKey", callWith("", inner)) : inner,
      );
    });
    const object: Doc = fields.length === 0
      ? "{}"
      : bracketed("{", "}", fields, true);
    const args: Doc = group([
      "(",
      indent([soft, JSON.stringify(tokenOfId(d.id)), ",", line, object]),
      ifBreak(","),
      soft,
      ")",
    ]);
    const keyword = this.exportKeyword(d.id);
    const heritage: Doc = [
      `${schema}.TaggedError`,
      typeArguments([d.name]),
      "()",
    ];
    let body: Doc = " {}";
    if (
      d.fields.some((f) =>
        (f.optional && sensitiveField(f.name)) || f.name === "__proto__"
      )
    ) {
      const presence = this.scope.fieldHelper("suppliedFields");
      const shape: Type = { kind: "record", fields: d.fields };
      body = [
        " ",
        braces([[
          "constructor(fields: ",
          typeDoc(this.scope, shape),
          d.fields.every((f) => f.optional)
            ? [
              " = ",
              this.scope.fieldHelper("record"),
              "<",
              typeDoc(this.scope, shape),
              ">({})",
            ]
            : "",
          ") ",
          braces([
            [
              "super(",
              this.scope.fieldHelper("record"),
              "<",
              typeDoc(this.scope, shape),
              ">(fields));",
            ],
            "globalThis.Object.setPrototypeOf(this, new.target.prototype);",
            ...d.fields.filter((f) => sensitiveField(f.name)).map((f) =>
              `if (globalThis.Object.hasOwn(fields, ${
                JSON.stringify(f.name)
              })) globalThis.Object.defineProperty(this, ${
                JSON.stringify(f.name)
              }, { value: fields.${f.name}, enumerable: true, configurable: true, writable: true });`
            ),
            `globalThis.Object.defineProperty(this, ${presence}, { value: new globalThis.Set(globalThis.Object.keys(fields)) });`,
          ]),
        ]]),
      ];
    }
    // `deno fmt` moves `extends` to its own line when the first line is too wide.
    if (
      `${keyword}class ${d.name} extends ${schema}.TaggedError<${d.name}>()(`
        .length > LINE_WIDTH
    ) {
      return [
        `${keyword}class ${d.name}`,
        indent([hard, "extends ", heritage, args, body]),
      ];
    }
    return [`${keyword}class ${d.name} extends `, heritage, args, body];
  }

  private serviceDeclaration(d: ServiceDecl): Doc {
    const context = this.scope.effect("Context");
    const methods = d.methods.map((m) => [
      "readonly ",
      m.name,
      ": ",
      typeDoc(this.scope, m.type),
      ";",
    ]);
    const members: Doc = methods.length === 0 ? "{}" : braces(methods);
    const keyword = this.exportKeyword(d.id);
    const argumentsDoc: Doc =
      `  extends ${context}.Service<${d.name}, {`.length > LINE_WIDTH
        ? typeArguments([d.name, members])
        : ["<", d.name, ", ", members, ">"];
    const heritage: Doc = [
      "extends ",
      `${context}.Service`,
      argumentsDoc,
      callWith("()", JSON.stringify(tokenOfId(d.id))),
      " {}",
    ];
    // `deno fmt` moves `extends` to its own line when the first line is too wide.
    const opening = methods.length === 0 ? "{}>()(" : "{";
    const first =
      `${keyword}class ${d.name} extends ${context}.Service<${d.name}, ${opening}`;
    if (first.length > LINE_WIDTH) {
      return [`${keyword}class ${d.name}`, indent([hard, heritage])];
    }
    return [`${keyword}class ${d.name} `, heritage];
  }

  private functionDeclaration(d: FunctionDecl): Doc {
    const header = functionHeaderDoc(this.scope, d, "contract");
    const prefix: Doc = [this.exportKeyword(d.id), "const ", d.name];
    if (
      d.type.execution === "pure" && d.body.kind === "block" &&
      d.body.steps.length > 0
    ) {
      const statements = this.expr.blockStatements(
        d.body,
        false,
        d.type.result,
      );
      return [
        assignment(prefix, this.expr.arrowBlock(header, statements)),
        ";",
      ];
    }
    const body = d.type.execution === "effect"
      ? this.expr.asEffect(d.body, d.type.result)
      : this.expr.fit(d.body, d.type.result, "pure");
    return [this.expr.arrowDeclaration(prefix, header, body), ";"];
  }

  private constantDeclaration(d: ConstantDecl): Doc {
    const value = this.expr.fit(d.value, d.type, "pure");
    return [
      this.exportKeyword(d.id),
      "const ",
      d.name,
      ": ",
      constantTypeDoc(this.scope, d),
      " = ",
      at(value, 0),
      ";",
    ];
  }

  // -------------------------------------------------------------- helpers

  /** `const $int = ...` */
  intFunctionDeclaration(): Doc {
    const name = this.scope.intFunction();
    return [
      `const ${name} = (value: number): number => `,
      braces([
        'if (!Number.isSafeInteger(value)) throw new RangeError("int overflow");',
        "return value;",
      ]),
      ";",
    ];
  }

  /** `const $Int = Schema.Finite.check(...)`, the `Int` schema of the book. */
  intSchemaDeclaration(): Doc {
    const name = this.scope.intSchemaName();
    const schema = this.scope.effect("Schema");
    const filter: Doc = group([
      `${schema}.makeFilter(`,
      indent([
        soft,
        '(value) => Number.isSafeInteger(value) || "expected a safe integer"',
      ]),
      ifBreak(","),
      soft,
      ")",
    ]);
    return [
      `const ${name} = ${schema}.Finite.check(`,
      group([
        indent([soft, filter]),
        ifBreak(","),
        soft,
      ]),
      ");",
    ];
  }

  /** The assertion constants of the host imports: `const UsersLive$host: Layer.Layer<Users> = UsersLive;` */
  hostAssertions(): Doc[] {
    const result: Doc[] = [];
    for (const [target, host] of this.scope.hosts) {
      let provider: Type | undefined;
      for (const imported of this.scope.ir.imports) {
        const found = imported.values.find((v) => v.id === target);
        if (found !== undefined) provider = found.type;
      }
      if (provider === undefined || provider.kind !== "provider") {
        throw unsupported(`the host binding ${host.local} is not a provider`);
      }
      result.push(marked(host.hostName, [
        `const ${host.hostName}: `,
        typeDoc(this.scope, provider),
        ` = ${host.local};`,
      ]));
    }
    return result;
  }
}
