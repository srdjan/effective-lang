// The expression scheme (plan sections 6.1 to 6.4): `pure`, `inGen`, and
// `asEffect`, the leaf and hoist rules, the control forms, and the parentheses
// around `yield*`.

import type {
  Arm,
  ErrorId,
  Expr,
  FunctionType,
  Handler,
  LocalId,
  Parameter,
  Pattern,
  Span,
  Step,
  Type,
  ValueId,
} from "../ir.ts";
import {
  alt,
  braces,
  bracketed,
  type Doc,
  group,
  type GroupId,
  hard,
  ifBreak,
  ifBroke,
  indent,
  join,
  line,
  soft,
  spanned,
} from "./doc.ts";
import {
  internal,
  methodOfCapability,
  type Scope,
  serviceOfCapability,
  tokenOfId,
  unsupported,
} from "./scope.ts";
import { typeDoc } from "./types.ts";

// ------------------------------------------------------------------ precedence

/** Precedence levels of the printed expressions. A larger number binds tighter. */
export const PREC = {
  yield: 0,
  conditional: 1,
  or: 2,
  and: 3,
  equality: 4,
  relational: 5,
  additive: 6,
  multiplicative: 7,
  member: 10,
} as const;

function binaryPrecedence(operator: string): number {
  switch (operator) {
    case "||":
      return PREC.or;
    case "&&":
      return PREC.and;
    case "===":
    case "!==":
      return PREC.equality;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return PREC.relational;
    case "+":
    case "-":
      return PREC.additive;
    default:
      return PREC.multiplicative;
  }
}

/** The parameter list of one arrow of a chain, with the source span of that arrow. */
interface ChainHead {
  readonly doc: Doc;
  readonly span: Span | undefined;
}

/** The body at the end of an arrow chain. */
type ChainTail =
  | { readonly kind: "expr"; readonly body: Emitted }
  | { readonly kind: "block"; readonly statements: readonly Doc[] };

/**
 * An arrow function, seen as a chain of arrows: `(a) => (b) => body` has two
 * heads. `deno fmt` lays out a chain as a unit, so the printer needs the parts.
 */
interface Chain {
  readonly heads: readonly ChainHead[];
  readonly tail: ChainTail;
}

/** A printed expression with the facts that its parent needs. */
export interface Emitted {
  readonly doc: Doc;
  readonly prec: number;
  /** The text starts with `{`, so a statement or an arrow body needs parentheses. */
  readonly brace: boolean;
  /** A function or object literal that a call can print after the other arguments. */
  readonly huggable: boolean;
  /** Present when the expression is an arrow function. */
  readonly chain?: Chain;
}

function emitted(
  doc: Doc,
  prec: number = PREC.member,
  flags: {
    readonly brace?: boolean;
    readonly huggable?: boolean;
    readonly chain?: Chain;
  } = {},
): Emitted {
  const base = {
    doc,
    prec,
    brace: flags.brace ?? false,
    huggable: flags.huggable ?? false,
  };
  return flags.chain === undefined ? base : { ...base, chain: flags.chain };
}

/** The arrows `heads[i..]` followed by `last` after the final `=>`. Each arrow carries its span. */
function nestHeads(
  heads: readonly ChainHead[],
  last: Doc,
  i: number = 0,
): Doc {
  const head = heads[i];
  const inner: Doc = i === heads.length - 1
    ? [head.doc, " =>", last]
    : [head.doc, " => ", nestHeads(heads, last, i + 1)];
  return head.span === undefined ? inner : spanned(head.span, inner);
}

/**
 * The layouts of an arrow chain, in the order that `deno fmt` prefers them.
 * `deno fmt` keeps a chain on one line when it fits. Otherwise it keeps all
 * heads on the first line and moves the body down. When the heads do not fit
 * after `const name =`, it moves the whole chain to the next line.
 */
function chainOptions(chain: Chain): {
  readonly oneLine: Doc;
  readonly bodyDown: Doc | undefined;
  readonly chainDown: Doc;
} {
  const { heads, tail } = chain;
  if (tail.kind === "block") {
    const last: Doc = [" ", braces(tail.statements)];
    return {
      oneLine: nestHeads(heads, last),
      bodyDown: undefined,
      chainDown: nestHeads(heads, last),
    };
  }
  if (tail.body.brace) {
    const last: Doc = [" (", tail.body.doc, ")"];
    return {
      oneLine: nestHeads(heads, last),
      bodyDown: undefined,
      chainDown: nestHeads(heads, last),
    };
  }
  return {
    oneLine: nestHeads(heads, [" ", tail.body.doc]),
    bodyDown: nestHeads(heads, indent([hard, tail.body.doc])),
    chainDown: nestHeads(heads, indent([hard, tail.body.doc])),
  };
}

/** The doc of `e`, in parentheses when `e` binds weaker than `min`. */
export function at(e: Emitted, min: number): Doc {
  return e.prec < min ? ["(", e.doc, ")"] : e.doc;
}

/** The doc in a position that needs no parentheses, except around a leading brace. */
function free(e: Emitted): Doc {
  return e.doc;
}

/** True when the doc that `at(e, min)` prints starts with `{`. */
function leadingBrace(e: Emitted, min: number): boolean {
  return e.prec >= min && e.brace;
}

function asStatement(e: Emitted): Doc {
  return e.brace ? ["(", e.doc, ")"] : e.doc;
}

/** Call arguments: one line, or the last function or object printed in place, or one for each line. */
function callArguments(args: readonly Emitted[]): Doc {
  if (args.length === 0) return "()";
  const docs = args.map(free);
  const expanded = (brk: boolean): Doc =>
    group(
      ["(", indent([soft, join([",", line], docs)]), ifBreak(","), soft, ")"],
      brk,
    );
  const last = args[args.length - 1];
  const others = args.slice(0, -1);
  if (!last.huggable || others.some((o) => o.huggable)) return expanded(false);
  const head = others.flatMap((o) => [free(o), ", "]);
  const lastDoc = free(last);
  return alt([
    ["(", ...head, lastDoc, ")"],
    ["(", ...head, group(lastDoc, true), ")"],
    expanded(true),
  ]);
}

function isIntType(type: Type): boolean {
  return type.kind === "primitive" && type.name === "int";
}

/** Builtin callee names: `value:m#$builtin/map/<hash>` gives `map`. */
function builtinName(target: string): string | undefined {
  const hash = target.indexOf("#");
  const rest = target.slice(hash + 1);
  if (!rest.startsWith("$builtin/")) return undefined;
  return rest.split("/")[1];
}

type Mode = "pure" | "gen";
type Kid = (e: Expr, expected?: Type) => Emitted;

export class ExprEmitter {
  constructor(readonly scope: Scope) {}

  /** True for a function type, or an alias of one, that runs as an effect. */
  private isEffectfulFunction(type: Type): boolean {
    const resolved = this.scope.resolve(type);
    return resolved.kind === "function" && resolved.execution === "effect";
  }

  // -------------------------------------------------------------- entry points

  /** A TypeScript expression for a pure-mode node. */
  pure(e: Expr): Emitted {
    if (e.execution !== "pure") {
      throw internal(`pure() received an effect-mode ${e.kind} node`);
    }
    return this.tag(e, this.structural(e, "pure"));
  }

  /** A TypeScript expression that is valid inside a generator body. */
  inGen(e: Expr): Emitted {
    if (e.execution === "pure") return this.pure(e);
    return this.tag(e, this.genNode(e));
  }

  /** A TypeScript expression of type `Effect.Effect<...>`. */
  asEffect(e: Expr, expected?: Type): Emitted {
    return this.tag(e, this.effectNode(e, expected));
  }

  /** The statements of an `Effect.gen` or plain function body for a block. */
  blockStatements(
    block: Extract<Expr, { kind: "block" }>,
    gen: boolean,
  ): Doc[] {
    const mode: Mode = gen ? "gen" : "pure";
    const statements: Doc[] = [];
    for (const step of block.steps) {
      statements.push(this.step(step, mode));
    }
    statements.push(this.returnStatement(block.result, block.type, mode));
    return statements;
  }

  /** `return <expr>;` */
  returnStatement(result: Expr, expected: Type | undefined, mode: Mode): Doc {
    return ["return ", free(this.fit(result, expected, mode)), ";"];
  }

  /** `Effect.gen(function* () { ... })` */
  genCall(statements: readonly Doc[]): Emitted {
    const effect = this.scope.effect("Effect");
    return emitted([`${effect}.gen(function* () `, braces(statements), ")"]);
  }

  /**
   * `(params) => expression`. The body moves to the next line when it does not
   * fit. `bodyGroup` names the group of the body, so that the caller can ask
   * whether the body moved.
   */
  arrow(parameters: Doc, body: Emitted, bodyGroup?: GroupId): Doc {
    if (body.chain !== undefined) {
      return this.chainDoc(this.chainOf(parameters, { kind: "expr", body }));
    }
    // An object literal body stays on the line of the arrow: `=> ({`.
    if (body.brace) return [parameters, " => (", body.doc, ")"];
    return [
      parameters,
      " =>",
      group(indent([line, body.doc]), false, bodyGroup),
    ];
  }

  /** `(params) => { statements }` */
  arrowBlock(parameters: Doc, statements: readonly Doc[]): Doc {
    return [parameters, " => ", braces(statements)];
  }

  /** The chain of an arrow with the parameters `parameters` and the tail `tail`. */
  private chainOf(parameters: Doc, tail: ChainTail): Chain {
    const head: ChainHead = { doc: parameters, span: undefined };
    if (tail.kind === "expr" && tail.body.chain !== undefined) {
      return {
        heads: [head, ...tail.body.chain.heads],
        tail: tail.body.chain.tail,
      };
    }
    return { heads: [head], tail };
  }

  /** An arrow function as an expression. A chain keeps its parts for the parent. */
  private arrowEmitted(parameters: Doc, tail: ChainTail): Emitted {
    const chain = this.chainOf(parameters, tail);
    const doc = chain.heads.length > 1
      ? this.chainDoc(chain)
      : tail.kind === "block"
      ? this.arrowBlock(parameters, tail.statements)
      : this.arrow(parameters, tail.body);
    return emitted(doc, PREC.yield, { huggable: true, chain });
  }

  /** A chain of two or more arrows, or one arrow, as a document. */
  private chainDoc(chain: Chain): Doc {
    const options = chainOptions(chain);
    if (options.bodyDown === undefined) return options.oneLine;
    return alt([options.oneLine, options.bodyDown]);
  }

  /**
   * `const name = <arrow>;` without the semicolon. The caller gives the text
   * before the `=`. An arrow chain that is too long moves below the `=`.
   */
  arrowDeclaration(prefix: Doc, parameters: Doc, body: Emitted): Doc {
    if (body.chain === undefined) {
      return [prefix, " = ", this.arrow(parameters, body)];
    }
    const options = chainOptions(
      this.chainOf(parameters, { kind: "expr", body }),
    );
    const choices: Doc[] = [[" ", options.oneLine]];
    if (options.bodyDown !== undefined) choices.push([" ", options.bodyDown]);
    choices.push(indent([hard, options.chainDown]));
    return [prefix, " =", alt(choices)];
  }

  // -------------------------------------------------------------- spans

  private tag(e: Expr, result: Emitted): Emitted {
    const doc = spanned(e.span, result.doc);
    if (result.chain === undefined) return { ...result, doc };
    const [first, ...rest] = result.chain.heads;
    const chain: Chain = {
      heads: [{ doc: first.doc, span: e.span }, ...rest],
      tail: result.chain.tail,
    };
    return { ...result, doc, chain };
  }

  // -------------------------------------------------------------- shared forms

  private kid(mode: Mode): Kid {
    return (e, expected) => this.fit(e, expected, mode);
  }

  /** The function type that `type` stands for, through aliases. */
  private functionTypeOf(type: Type): FunctionType | undefined {
    const resolved = this.scope.resolve(type);
    return resolved.kind === "function" ? resolved : undefined;
  }

  /**
   * `e` as a value of the type `expected`. A pure function fits a slot of an
   * effect function type (spec: the checker allows it), so the emitter wraps
   * its result: `(a) => Effect.succeed(f(a))`. Every other value stays as it is.
   */
  fit(e: Expr, expected: Type | undefined, mode: Mode): Emitted {
    const plain = mode === "gen" ? this.inGen(e) : this.pure(e);
    if (expected === undefined) return plain;
    const from = this.functionTypeOf(e.type);
    const to = this.functionTypeOf(expected);
    if (
      from === undefined || to === undefined || from.execution !== "pure" ||
      to.execution !== "effect"
    ) {
      return plain;
    }
    if (e.execution !== "pure") {
      throw unsupported(
        "a pure function value from an effect-mode expression fits an effect function type only by a lift",
        e.span,
      );
    }
    if (e.kind === "closure") return this.tag(e, this.closure(e, true, true));
    const names = from.parameters.map(() => this.scope.temp());
    const parameters = bracketed(
      "(",
      ")",
      names.map((n, i) => [n, ": ", typeDoc(this.scope, from.parameters[i])]),
      false,
    );
    const effect = this.scope.effect("Effect");
    const call = emitted([at(plain, PREC.member), "(", join(", ", names), ")"]);
    const body = emitted([`${effect}.succeed`, callArguments([call])]);
    return this.arrowEmitted(parameters, { kind: "expr", body });
  }

  private structural(e: Expr, mode: Mode): Emitted {
    const kid = this.kid(mode);
    switch (e.kind) {
      case "literal":
        return emitted(this.literal(e.value));
      case "reference":
        return emitted(this.reference(e.target));
      case "record":
        return this.objectLiteral(
          e.fields.map((f) =>
            this.field(f.name, f.value, kid, this.fieldType(e.type, f.name))
          ),
          [],
        );
      case "array":
      case "tuple":
        return emitted(
          bracketed("[", "]", e.elements.map((x) => free(kid(x))), false),
          PREC.member,
          { huggable: true },
        );
      case "get":
        return this.getField(e, kid);
      case "update": {
        const base = kid(e.record);
        const spread: Doc = ["...", at(base, PREC.member)];
        return this.objectLiteral(
          e.fields.map((f) =>
            this.field(f.name, f.value, kid, this.fieldType(e.type, f.name))
          ),
          [spread],
        );
      }
      case "brand":
        return emitted([
          this.scope.nameOf(e.brand),
          ".make",
          callArguments([kid(e.value)]),
        ]);
      case "unbrand":
        return kid(e.value);
      case "some": {
        const option = this.scope.effect("Option");
        const resolved = this.scope.resolve(e.type);
        const element = resolved.kind === "option"
          ? resolved.element
          : undefined;
        return emitted([
          `${option}.some`,
          callArguments([kid(e.value, element)]),
        ]);
      }
      case "none": {
        const option = this.scope.effect("Option");
        return emitted(`${option}.none()`);
      }
      case "error":
        return emitted([
          "new ",
          this.scope.nameOf(e.error),
          "(",
          this.objectLiteral(
            e.fields.map((f) =>
              this.field(
                f.name,
                f.value,
                kid,
                this.errorFieldType(e.error, f.name),
              )
            ),
            [],
          ).doc,
          ")",
        ]);
      case "closure":
        return this.closure(e, true);
      case "call":
        return this.nonLeafCall(e, kid);
      case "block":
        return this.nestedBlock(e, mode);
      case "if":
        return this.conditional(e, kid);
      case "match":
        return this.match(e);
      case "binary":
        return this.binary(e, kid);
      case "perform":
      case "fail":
      case "catch":
      case "retry":
      case "provide":
        throw internal(`${e.kind} node in a structural position`);
    }
  }

  private literal(value: string | number | boolean | null): Doc {
    if (value === null) return "undefined";
    if (typeof value === "string") return JSON.stringify(value);
    return String(value);
  }

  private reference(target: string): Doc {
    if (target.startsWith("local:")) {
      const name = this.scope.locals.get(target as LocalId);
      if (name === undefined) throw internal(`unbound local ${target}`);
      return name;
    }
    const host = this.scope.hostBinding(target as ValueId);
    if (host !== undefined) return host.hostName;
    if (builtinName(target) !== undefined) {
      throw unsupported(`the builtin ${target} is not in callee position`);
    }
    return this.scope.nameOf(target as ValueId);
  }

  private field(
    name: string,
    value: Expr,
    kid: Kid,
    expected: Type | undefined,
  ): Doc {
    if (
      value.kind === "reference" && value.target.startsWith("local:") &&
      this.scope.locals.get(value.target as LocalId) === name
    ) {
      return name;
    }
    return [name, ": ", free(kid(value, expected))];
  }

  /** The declared type of a field of a record type. */
  private fieldType(type: Type, name: string): Type | undefined {
    const resolved = this.scope.resolve(type);
    if (resolved.kind !== "record") return undefined;
    return resolved.fields.find((f) => f.name === name)?.type;
  }

  private errorFieldType(error: ErrorId, name: string): Type | undefined {
    const declaration = this.scope.typeLevelDeclaration(error);
    if (declaration?.kind !== "error") return undefined;
    return declaration.fields.find((f) => f.name === name)?.type;
  }

  private objectLiteral(
    fields: readonly Doc[],
    spreads: readonly Doc[],
  ): Emitted {
    const items = [...spreads, ...fields];
    if (items.length === 0) {
      return emitted("{}", PREC.member, { brace: true, huggable: true });
    }
    return emitted(bracketed("{", "}", items, true), PREC.member, {
      brace: true,
      huggable: true,
    });
  }

  private getField(
    e: Extract<Expr, { kind: "get" }>,
    kid: Kid,
  ): Emitted {
    const record = kid(e.record);
    const access: Doc = [at(record, PREC.member), ".", e.field];
    if (this.isOptionalField(e.record.type, e.field)) {
      const option = this.scope.effect("Option");
      return emitted([`${option}.fromUndefinedOr(`, access, ")"]);
    }
    return emitted(access, PREC.member, {
      brace: leadingBrace(record, PREC.member),
    });
  }

  private isOptionalField(type: Type, field: string): boolean {
    const resolved = this.scope.resolve(type);
    return resolved.kind === "record" &&
      resolved.fields.some((f) => f.name === field && f.optional);
  }

  private binary(
    e: Extract<Expr, { kind: "binary" }>,
    kid: Kid,
  ): Emitted {
    const prec = binaryPrecedence(e.operator);
    const left = kid(e.left);
    const body: Doc = [
      at(left, prec),
      ` ${e.operator} `,
      at(kid(e.right), prec + 1),
    ];
    const arithmetic = e.operator === "+" || e.operator === "-" ||
      e.operator === "*";
    if (arithmetic && isIntType(e.type)) {
      return emitted([this.scope.intFunction(), "(", body, ")"]);
    }
    return emitted(body, prec, { brace: leadingBrace(left, prec) });
  }

  private conditional(
    e: Extract<Expr, { kind: "if" }>,
    kid: Kid,
  ): Emitted {
    const condition = kid(e.condition);
    return emitted(
      group([
        at(condition, PREC.or),
        indent([
          line,
          "? ",
          at(kid(e.then, e.type), PREC.conditional),
          line,
          ": ",
          at(kid(e.else, e.type), PREC.conditional),
        ]),
      ]),
      PREC.conditional,
      { brace: leadingBrace(condition, PREC.or) },
    );
  }

  // -------------------------------------------------------------- closures

  closure(
    e: Extract<Expr, { kind: "closure" }>,
    annotate: boolean,
    forceEffect = false,
  ): Emitted {
    const parameters = bracketed(
      "(",
      ")",
      e.parameters.map((p) =>
        annotate ? [p.name, ": ", typeDoc(this.scope, p.type)] : p.name
      ),
      false,
    );
    const type: FunctionType = this.closureType(e);
    if (type.execution === "effect" || forceEffect) {
      return this.arrowEmitted(parameters, {
        kind: "expr",
        body: this.asEffect(e.body, type.result),
      });
    }
    if (e.body.kind === "block" && e.body.steps.length > 0) {
      return this.arrowEmitted(parameters, {
        kind: "block",
        statements: this.blockStatements(e.body, false),
      });
    }
    return this.arrowEmitted(parameters, {
      kind: "expr",
      body: this.fit(e.body, type.result, "pure"),
    });
  }

  private closureType(e: Extract<Expr, { kind: "closure" }>): FunctionType {
    if (e.type.kind !== "function") {
      throw internal("a closure node has a type that is not a function type");
    }
    return e.type;
  }

  // -------------------------------------------------------------- calls

  private nonLeafCall(
    e: Extract<Expr, { kind: "call" }>,
    kid: Kid,
  ): Emitted {
    if (e.callee.kind === "reference") {
      const builtin = builtinName(e.callee.target);
      if (builtin !== undefined) return this.builtinCall(e, builtin, kid);
    }
    if (this.isEffectfulFunction(e.callee.type)) {
      throw internal("a leaf call reached the structural emitter");
    }
    const parameters = this.functionTypeOf(e.callee.type)?.parameters ?? [];
    const callee = kid(e.callee);
    return emitted(
      [
        at(callee, PREC.member),
        callArguments(e.arguments.map((a, i) => kid(a, parameters[i]))),
      ],
      PREC.member,
      { brace: leadingBrace(callee, PREC.member) },
    );
  }

  private callback(arg: Expr, kid: Kid): Emitted {
    return arg.kind === "closure"
      ? this.tag(arg, this.closure(arg, false))
      : kid(arg);
  }

  private builtinCall(
    e: Extract<Expr, { kind: "call" }>,
    name: string,
    kid: Kid,
  ): Emitted {
    const args = e.arguments;
    switch (name) {
      case "map":
      case "filter": {
        if (args.length !== 2) throw internal(`${name} needs two arguments`);
        return emitted([
          at(kid(args[0]), PREC.member),
          `.${name}`,
          callArguments([this.callback(args[1], kid)]),
        ]);
      }
      case "fold": {
        if (args.length !== 3) throw internal("fold needs three arguments");
        const generic = e.type.kind === "primitive"
          ? ""
          : ["<", typeDoc(this.scope, e.type), ">"];
        return emitted([
          at(kid(args[0]), PREC.member),
          ".reduce",
          generic,
          callArguments([this.callback(args[2], kid), kid(args[1])]),
        ]);
      }
      default:
        throw unsupported(`the builtin ${name} has no emission form`, e.span);
    }
  }

  // -------------------------------------------------------------- blocks and steps

  private step(step: Step, mode: Mode): Doc {
    const value = this.kid(mode);
    if (step.kind === "bind") {
      return [
        "const ",
        step.binding.name,
        ": ",
        typeDoc(this.scope, step.binding.type),
        " = ",
        free(value(step.value, step.binding.type)),
        ";",
      ];
    }
    return [asStatement(value(step.value)), ";"];
  }

  private nestedBlock(
    e: Extract<Expr, { kind: "block" }>,
    mode: Mode,
  ): Emitted {
    if (e.steps.length === 0) return this.kid(mode)(e.result);
    if (mode === "gen") {
      return this.yieldOf(this.genCall(this.blockStatements(e, true)));
    }
    return emitted(["(() => ", braces(this.blockStatements(e, false)), ")()"]);
  }

  private yieldOf(effect: Emitted): Emitted {
    return emitted(["yield* ", at(effect, PREC.conditional)], PREC.yield);
  }

  // -------------------------------------------------------------- match

  private match(e: Extract<Expr, { kind: "match" }>): Emitted {
    const effectful = e.execution === "effect";
    const subject = effectful ? this.inGen(e.subject) : this.pure(e.subject);
    const body = (arm: Arm): Emitted =>
      effectful
        ? this.asEffect(arm.body, e.type)
        : this.fit(arm.body, e.type, "pure");
    const optionLike =
      e.arms.every((a) =>
        a.pattern.kind === "some" || a.pattern.kind === "none" ||
        a.pattern.kind === "wildcard"
      ) && e.arms.some((a) =>
        a.pattern.kind === "some" || a.pattern.kind === "none"
      );
    const result = optionLike
      ? this.optionMatch(e.arms, subject, body)
      : this.selectorMatch(e.arms, subject, body);
    return effectful ? this.yieldOf(result) : result;
  }

  private optionMatch(
    arms: readonly Arm[],
    subject: Emitted,
    body: (arm: Arm) => Emitted,
  ): Emitted {
    const option = this.scope.effect("Option");
    const none = arms.find((a) => a.pattern.kind === "none") ??
      arms.find((a) => a.pattern.kind === "wildcard");
    const some = arms.find((a) => a.pattern.kind === "some") ??
      arms.find((a) => a.pattern.kind === "wildcard");
    if (none === undefined || some === undefined) {
      throw internal("an option match lacks an arm");
    }
    const someBinding = some.pattern.kind === "some"
      ? some.pattern.binding.name
      : "_";
    const handlers = bracketed("{", "}", [
      ["onNone: ", this.arrow("()", body(none))],
      ["onSome: ", this.arrow(`(${someBinding})`, body(some))],
    ], true);
    return emitted([
      `${option}.match`,
      callArguments([
        subject,
        emitted(handlers, PREC.member, { huggable: true }),
      ]),
    ]);
  }

  private selectorMatch(
    arms: readonly Arm[],
    subject: Emitted,
    body: (arm: Arm) => Emitted,
  ): Emitted {
    const selector = this.scope.temp();
    const armDoc = (arm: Arm): Doc => {
      const binding = this.armBinding(arm.pattern);
      const inner = body(arm);
      if (binding === null) return at(inner, PREC.conditional);
      return [
        "(",
        this.arrow(`(${binding.name})`, inner),
        ")(",
        selector,
        ")",
      ];
    };
    // The chain is `test ? arm : test ? arm : last`. `deno fmt` prints the
    // nested conditionals of the else branch at the indentation of the first.
    let last: Doc | undefined;
    let pairs: { readonly test: Doc; readonly arm: Doc }[] = [];
    for (let i = arms.length - 1; i >= 0; i--) {
      const arm = arms[i];
      if (last === undefined) {
        last = armDoc(arm);
        continue;
      }
      const test = this.armTest(arm.pattern, selector);
      if (test === undefined) {
        // A wildcard before the last arm makes the later arms unreachable.
        last = armDoc(arm);
        pairs = [];
        continue;
      }
      pairs.unshift({ test, arm: armDoc(arm) });
    }
    if (last === undefined) throw internal("a match has no arm");
    const chain: Doc = pairs.length === 0 ? last : group([
      pairs[0].test,
      indent([
        ...pairs.flatMap((pair, i) => [
          ...(i === 0 ? [] : [pair.test]),
          line,
          "? ",
          pair.arm,
          line,
          ": ",
        ]),
        last,
      ]),
    ]);
    // When the body of the selector moves down, `deno fmt` also indents the
    // arguments of the call by one more level.
    const bodyGroup: GroupId = {};
    const callee = this.arrow(
      `(${selector})`,
      emitted(chain, PREC.conditional),
      bodyGroup,
    );
    const args = callArguments([subject]);
    return emitted([
      "(",
      callee,
      ")",
      ifBroke(bodyGroup, indent(args), args),
    ]);
  }

  private armBinding(pattern: Pattern): Parameter | null {
    switch (pattern.kind) {
      case "error":
        return pattern.binding;
      case "tag":
        return pattern.binding;
      case "some":
        throw unsupported(
          "a Some pattern in a match that is not an option match",
        );
      default:
        return null;
    }
  }

  private armTest(pattern: Pattern, selector: string): Doc | undefined {
    switch (pattern.kind) {
      case "wildcard":
        return undefined;
      case "literal":
        return [selector, " === ", this.literal(pattern.value)];
      case "error":
        return [
          selector,
          "._tag === ",
          JSON.stringify(tokenOfId(pattern.error)),
        ];
      case "tag":
        return [
          selector,
          ".",
          pattern.field,
          " === ",
          JSON.stringify(pattern.value),
        ];
      case "none":
      case "some":
        throw unsupported(
          "an option pattern in a match that is not an option match",
        );
    }
  }

  // -------------------------------------------------------------- effects

  /** An expression of type `Effect.Effect<...>` for a node of any mode. */
  private effectNode(e: Expr, expected: Type | undefined): Emitted {
    if (e.execution === "pure") {
      const effect = this.scope.effect("Effect");
      return emitted([
        `${effect}.succeed`,
        callArguments([this.fit(e, expected, "pure")]),
      ]);
    }
    if (this.isLeaf(e)) return this.leafEffect(e, false);
    if (e.kind === "block" && e.steps.length > 0) {
      return this.genCall(this.blockStatements(e, true));
    }
    return this.genCall([this.returnStatement(e, expected, "gen")]);
  }

  private genNode(e: Expr): Emitted {
    if (this.isLeaf(e)) return this.leafEffect(e, true);
    return this.structural(e, "gen");
  }

  private isLeaf(e: Expr): boolean {
    switch (e.kind) {
      case "call":
        return this.isEffectfulFunction(e.callee.type);
      case "perform":
      case "fail":
      case "retry":
      case "provide":
      case "catch":
        return true;
      default:
        return false;
    }
  }

  /** The children that a leaf evaluates before it runs, in source order. */
  private evaluatedChildren(e: Expr): Expr[] {
    switch (e.kind) {
      case "call":
        return [e.callee, ...e.arguments];
      case "perform":
        return [...e.arguments];
      case "fail":
        return [e.error];
      default:
        return [];
    }
  }

  /** The declared type of each evaluated child of a leaf, where the program states one. */
  private expectedChildren(e: Expr): (Type | undefined)[] {
    switch (e.kind) {
      case "call":
        return [
          undefined,
          ...(this.functionTypeOf(e.callee.type)?.parameters ?? []),
        ];
      case "perform": {
        const service = this.scope.typeLevelDeclaration(
          serviceOfCapability(e.capability),
        );
        if (service?.kind !== "service") return [];
        const method = service.methods.find((m) => m.id === e.capability);
        return method === undefined ? [] : [...method.type.parameters];
      }
      default:
        return [];
    }
  }

  /** True when evaluating `e` cannot throw and has no effect. */
  private isTrivial(e: Expr): boolean {
    switch (e.kind) {
      case "literal":
      case "reference":
      case "none":
      case "closure":
        return true;
      case "record":
      case "error":
        return e.fields.every((f) => this.isTrivial(f.value));
      case "update":
        return this.isTrivial(e.record) &&
          e.fields.every((f) => this.isTrivial(f.value));
      case "array":
      case "tuple":
        return e.elements.every((x) => this.isTrivial(x));
      case "get":
        return this.isTrivial(e.record);
      case "brand":
      case "unbrand":
      case "some":
        return this.isTrivial(e.value);
      default:
        return false;
    }
  }

  /**
   * The leaf `e` as an Effect-valued expression. When an evaluated child is
   * effectful, the emitter hoists the children up to the last effectful one
   * into temporaries inside a nested `Effect.gen` (plan section 6.1).
   */
  private leafEffect(e: Expr, yielded: boolean): Emitted {
    const children = this.evaluatedChildren(e);
    let last = -1;
    children.forEach((c, i) => {
      if (c.execution === "effect") last = i;
    });
    const expected = this.expectedChildren(e);
    if (last < 0) {
      const leaf = this.leaf(
        e,
        children.map((c, i) => this.fit(c, expected[i], "pure")),
      );
      return yielded ? this.yieldOf(leaf) : leaf;
    }
    const statements: Doc[] = [];
    const emittedChildren: Emitted[] = children.map((child, i) => {
      if (i > last || (child.execution === "pure" && this.isTrivial(child))) {
        return this.fit(child, expected[i], "pure");
      }
      const name = this.scope.temp();
      const want = expected[i];
      statements.push([
        "const ",
        name,
        ": ",
        typeDoc(this.scope, want ?? child.type),
        " = ",
        free(this.fit(child, want, "gen")),
        ";",
      ]);
      return emitted(name);
    });
    statements.push([
      "return ",
      free(this.yieldOf(this.leaf(e, emittedChildren))),
      ";",
    ]);
    const gen = this.genCall(statements);
    return yielded ? this.yieldOf(gen) : gen;
  }

  /** The Effect-valued expression of a leaf, with its evaluated children already printed. */
  private leaf(e: Expr, children: readonly Emitted[]): Emitted {
    const effect = this.scope.effect("Effect");
    switch (e.kind) {
      case "call":
        return emitted([
          at(children[0], PREC.member),
          callArguments(children.slice(1)),
        ]);
      case "perform": {
        const service = this.scope.nameOf(serviceOfCapability(e.capability));
        const parameter = this.scope.serviceParameter();
        const call = emitted([
          parameter,
          ".",
          methodOfCapability(e.capability),
          callArguments(children),
        ]);
        const arrow = emitted(
          this.arrow(`(${parameter})`, call),
          PREC.yield,
          { huggable: true },
        );
        return emitted([`${service}.use`, callArguments([arrow])]);
      }
      case "fail":
        return emitted([`${effect}.fail`, callArguments([children[0]])]);
      case "retry": {
        const job = this.suspended(e.job);
        const options = emitted(`{ times: ${e.times} }`, PREC.member, {
          huggable: true,
        });
        return emitted([`${effect}.retry`, callArguments([job, options])]);
      }
      case "provide": {
        const job = this.suspended(e.job);
        return emitted([
          `${effect}.provide`,
          callArguments([job, this.pure(e.provider)]),
        ]);
      }
      case "catch":
        return this.catchEffect(e);
      default:
        throw internal(`${e.kind} is not a leaf`);
    }
  }

  private suspended(job: Expr): Emitted {
    const effect = this.scope.effect("Effect");
    return emitted([`${effect}.suspend`, callArguments([this.pure(job)])]);
  }

  private catchEffect(e: Extract<Expr, { kind: "catch" }>): Emitted {
    const effect = this.scope.effect("Effect");
    const handlers = e.handlers.map((h: Handler) => [
      JSON.stringify(tokenOfId(h.error)),
      ": ",
      this.arrow(`(${h.binding.name})`, this.asEffect(h.body)),
    ]);
    const table = emitted(bracketed("{", "}", handlers, true), PREC.member, {
      huggable: true,
    });
    const catchTags = emitted([
      `${effect}.catchTags`,
      callArguments([table]),
    ]);
    return emitted([
      at(this.asEffect(e.body), PREC.member),
      ".pipe",
      callArguments([catchTags]),
    ]);
  }
}
