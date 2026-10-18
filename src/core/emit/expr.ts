// The expression scheme (plan sections 6.1 to 6.4): `pure`, `inGen`, and
// `asEffect`, the leaf and hoist rules, the control forms, and the parentheses
// around `yield*`.

import type {
  Arm,
  DeclarationId,
  ErrorId,
  Expr,
  Field,
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
  fill,
  group,
  type GroupId,
  hard,
  hasHardLine,
  ifBreak,
  ifBroke,
  ifFits,
  indent,
  join,
  line,
  soft,
  spanEnds,
  spanned,
  through,
} from "./doc.ts";
import {
  internal,
  methodOfCapability,
  type Scope,
  serviceOfCapability,
  tokenOfId,
  unsupported,
} from "./scope.ts";
import { schemaDoc, typeDoc } from "./types.ts";

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
  /** Present when the expression is a binary operation. A larger run can take its operands. */
  readonly run?: Run;
  /** Present when the expression is an arrow with an expression body. Names the group of the body. */
  readonly bodyGroup?: GroupId;
  /** Present when the expression is a conditional. A conditional in its else branch joins it. */
  readonly condChain?: CondChain;
  /**
   * The doc for a position that starts on a line of its own at the indentation
   * of the expression, as the body of an arrow or an array element. Present
   * only when it differs from `doc`.
   */
  readonly flush?: Doc;
}

function emitted(
  doc: Doc,
  prec: number = PREC.member,
  flags: {
    readonly brace?: boolean;
    readonly huggable?: boolean;
    readonly chain?: Chain;
    readonly run?: Run;
    readonly flush?: Doc;
    readonly bodyGroup?: GroupId;
    readonly condChain?: CondChain;
  } = {},
): Emitted {
  const base = {
    doc,
    prec,
    brace: flags.brace ?? false,
    huggable: flags.huggable ?? false,
  };
  return {
    ...base,
    ...(flags.chain === undefined ? {} : { chain: flags.chain }),
    ...(flags.run === undefined ? {} : { run: flags.run }),
    ...(flags.flush === undefined ? {} : { flush: flags.flush }),
    ...(flags.bodyGroup === undefined ? {} : { bodyGroup: flags.bodyGroup }),
    ...(flags.condChain === undefined ? {} : { condChain: flags.condChain }),
  };
}

/** The doc of `e` for a position that starts on a line of its own. */
function flush(e: Emitted): Doc {
  return e.flush ?? e.doc;
}

// ------------------------------------------------------------------ conditionals

/**
 * A chain `t0 ? a0 : t1 ? a1 : last`. `deno fmt` prints every `?` and `:` of
 * the chain at one indentation level.
 */
interface CondChain {
  readonly tests: readonly Emitted[];
  readonly arms: readonly Doc[];
  readonly last: Doc;
  /** The span of the conditional that starts at `tests[j + 1]`, for each `j`. */
  readonly nested: readonly Span[];
  /** The span of the whole chain. Set when the conditional is tagged. */
  readonly self: Span | undefined;
}

/** The test of a conditional. `tail` is the depth of the lines after the first, if the test breaks. */
function testDoc(test: Emitted, tail: number): Doc {
  return test.run === undefined ? at(test, PREC.or) : runDoc(test.run, tail);
}

/** A test after the first test of a conditional chain. */
interface LaterTest {
  /** The whole test, with the span ends that belong to it. */
  readonly doc: Doc;
  /**
   * Present when the test is `left operator right`. `head` is the text up to
   * and including the operator. `right` is the last operand. The test is
   * `head`, a space, and `right` when it is on one line.
   */
  readonly split: { readonly head: Doc; readonly right: Doc } | undefined;
}

/**
 * A pair prints at least `x ? y : `, 8 columns. So a joined line of 10 pairs
 * does not fit in 80 columns, and the printer tries no later test.
 */
const MAX_JOINED_PAIRS = 10;

/**
 * The conditional chain `first ? arms[0] : tests[0] ? arms[1] : ... : last`.
 * `deno fmt` prints every `?` and `:` of the chain at one indentation level.
 * When a test does not fit on its `: test` line, `deno fmt` joins the pairs
 * before the test and the left side of the test on the line of `first`, if
 * that line fits. Then the right side of the test sits two levels deeper than
 * the chain. It joins at most one test, and not after a pair with a hard line.
 */
function conditionalChain(
  first: Doc,
  tests: readonly LaterTest[],
  arms: readonly Doc[],
  last: Doc,
): Doc {
  const broken: Doc = [
    first,
    indent([
      line,
      "? ",
      arms[0],
      ...tests.flatMap((test, i) => [
        line,
        ": ",
        test.doc,
        line,
        "? ",
        arms[i + 1],
      ]),
      line,
      ": ",
      last,
    ]),
  ];
  const reach = Math.min(tests.length, MAX_JOINED_PAIRS);
  if (reach === 0) return group(broken);
  // `options[k - 1]` is the layout where `tests[k - 1]` joins the first line.
  // The joined line holds the pairs before it, so it is `prefix` and the left
  // side. A hard line in `prefix` blocks the join.
  let prefix: Doc = [first, " ? ", arms[0], " : "];
  let blocked = hasHardLine(first) || hasHardLine(arms[0]);
  const options: Doc[] = [];
  for (let k = 1; k <= reach; k++) {
    const test = tests[k - 1];
    const { split } = test;
    if (split === undefined || blocked) {
      options.push(broken);
    } else {
      const rest: Doc[] = ["? ", arms[k]];
      for (let j = k; j < tests.length; j++) {
        rest.push(hard, ": ", tests[j].doc, hard, "? ", arms[j + 1]);
      }
      rest.push(hard, ": ", last);
      options.push(alt([
        [
          prefix,
          split.head,
          indent(indent([hard, split.right])),
          group(indent([hard, ...rest])),
        ],
        broken,
      ]));
    }
    blocked = blocked || hasHardLine(test.doc) || hasHardLine(arms[k]);
    prefix = [prefix, test.doc, " ? ", arms[k], " : "];
  }
  let decision: Doc = broken;
  for (let k = reach; k >= 1; k--) {
    // Check A: the line `: test` of the broken layout is wider than the page.
    const probe: Doc = indent([through, ": ", tests[k - 1].doc]);
    decision = ifFits(probe, decision, options[k - 1]);
  }
  return group(ifBreak(decision, broken));
}

const COMPARISONS: ReadonlySet<string> = new Set([
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
]);

/** True when the run is one comparison of two operands, such as `a === b`. */
function isComparison(run: Run | undefined): run is Run {
  return run !== undefined && run.operands.length === 2 &&
    COMPARISONS.has(run.operators[0]);
}

/** A test of a conditional after the first. A comparison of two operands can split. */
function laterTest(test: Emitted, open: Doc): LaterTest {
  const doc: Doc = [open, testDoc(test, 2)];
  const run = test.run;
  if (!isComparison(run)) return { doc, split: undefined };
  const operator = run.operators[0];
  const ends = run.top === undefined ? undefined : spanEnds(run.top);
  return {
    doc,
    split: {
      head: [open, ends?.open ?? "", run.operands[0], ` ${operator}`],
      right: [run.operands[1], ends?.close ?? ""],
    },
  };
}

function condDoc(chain: CondChain, tail: number): Doc {
  const ends = chain.nested.map(spanEnds);
  const tests = chain.tests.slice(1).map((test, i) =>
    laterTest(test, ends[i].open)
  );
  const closes = ends.map((e) => e.close).reverse();
  return conditionalChain(
    testDoc(chain.tests[0], tail),
    tests,
    chain.arms,
    [chain.last, ...closes],
  );
}

// ------------------------------------------------------------------ binary runs

/**
 * A chain of binary operations of one precedence level, such as
 * `a && b && c`. `deno fmt` flattens it and puts the operator at the end of
 * the line. It breaks after an operator only where the next operand does not
 * fit. A break indents the lines after the first by one level, except for an
 * arrow body and an array element.
 */
interface Run {
  readonly operands: readonly Doc[];
  /** `operators[i]` stands between `operands[i]` and `operands[i + 1]`. */
  readonly operators: readonly string[];
  /**
   * The spans of the operations inside the chain: `inner[j]` covers the
   * operands `0` to `j + 1`. The span of the whole chain is `top`.
   */
  readonly inner: readonly Span[];
  readonly top: Span | undefined;
}

/** The doc of a run. `tail` is the indentation depth of the lines after the first. */
function runDoc(run: Run, tail: number): Doc {
  const ends = run.inner.map(spanEnds);
  const last = run.operands.length - 1;
  const parts: Doc[] = [];
  run.operands.forEach((operand, k) => {
    if (k > 0) parts.push(line);
    const chunk: Doc[] = [];
    if (k === 0) {
      for (let j = ends.length - 1; j >= 0; j--) chunk.push(ends[j].open);
    }
    chunk.push(operand);
    if (k >= 1 && k - 1 < ends.length) chunk.push(ends[k - 1].close);
    if (k < last) chunk.push(` ${run.operators[k]}`);
    parts.push(chunk);
  });
  const filled = fill(parts, tail);
  return run.top === undefined ? filled : spanned(run.top, filled);
}

/**
 * The arrows `heads[i..]` followed by `last` after the final `=>`. Each arrow
 * carries its span. `separator` comes after each `=>` that is not the last.
 */
function nestHeads(
  heads: readonly ChainHead[],
  last: Doc,
  separator: Doc = " ",
  i: number = 0,
): Doc {
  const head = heads[i];
  const inner: Doc = i === heads.length - 1
    ? [head.doc, " =>", last]
    : [head.doc, " =>", separator, nestHeads(heads, last, separator, i + 1)];
  return head.span === undefined ? inner : spanned(head.span, inner);
}

/**
 * The layouts of an arrow chain. `deno fmt` keeps a chain on one line when it
 * fits. Otherwise it keeps all heads on the first line and moves the body
 * down. When the heads do not fit after `const name =`, it moves the whole
 * chain below the `=`. When the heads do not fit on one line, each head gets
 * a line of its own at the indentation of the chain, after the first. A head
 * whose parameter list does not fit on its line breaks the list.
 */
interface ChainOptions {
  readonly oneLine: Doc;
  /** Heads on the first line and the body below. Absent for a block or object body. */
  readonly bodyDown: Doc | undefined;
  /** One head for each line, the body after the last head. */
  readonly split: (separator: Doc) => Doc;
  /** One head for each line, the body below the last head. Absent like `bodyDown`. */
  readonly splitDown: ((separator: Doc) => Doc) | undefined;
  /** One head for each line, the body on the last line when it fits, else below it. */
  readonly splitAdaptive: (separator: Doc) => Doc;
}

function chainOptions(chain: Chain): ChainOptions {
  const { heads, tail } = chain;
  if (tail.kind === "block" || tail.body.brace) {
    const last: Doc = tail.kind === "block"
      ? [" ", braces(tail.statements)]
      : [" (", tail.body.doc, ")"];
    return {
      oneLine: nestHeads(heads, last),
      bodyDown: undefined,
      split: (separator) => nestHeads(heads, last, separator),
      splitDown: undefined,
      splitAdaptive: (separator) => nestHeads(heads, last, separator),
    };
  }
  const body = tail.body;
  const down: Doc = indent([hard, flush(body)]);
  return {
    oneLine: nestHeads(heads, [" ", body.doc]),
    bodyDown: nestHeads(heads, down),
    split: (separator) => nestHeads(heads, [" ", body.doc], separator),
    splitDown: (separator) => nestHeads(heads, down, separator),
    splitAdaptive: (separator) =>
      nestHeads(heads, group(indent([line, flush(body)])), separator),
  };
}

/** A chain of arrows that is not a declaration: on a line, body down, or one head for each line. */
function chainDocOf(chain: Chain): Doc {
  const options = chainOptions(chain);
  const split = options.splitAdaptive(hard);
  if (options.bodyDown === undefined) return alt([options.oneLine, split]);
  return alt([options.oneLine, options.bodyDown, split]);
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
  // A chain stays on the line of the call only when its heads fit there. Else
  // the arguments break, and each head gets a line of its own.
  if (last.chain !== undefined && last.chain.heads.length > 1) {
    return alt([["(", ...head, lastDoc, ")"], expanded(true)]);
  }
  // When the body of the last arrow moves down, `)` moves down with it.
  const close: Doc = last.bodyGroup === undefined
    ? ")"
    : [ifBroke(last.bodyGroup, hard), ")"];
  return alt([
    ["(", ...head, lastDoc, ")"],
    ["(", ...head, group(lastDoc, true), close],
    expanded(true),
  ]);
}

/** `left === right`. When it does not fit, `right` moves down two levels, as `deno fmt` prints it. */
function equality(left: string, right: Doc): Doc {
  return group([left, " ===", indent(indent([line, right]))]);
}

/** The test of a match arm, with the two sides of its comparison. */
interface ArmTest {
  readonly doc: Doc;
  readonly left: string;
  readonly right: Doc;
}

function armEquality(left: string, right: Doc): ArmTest {
  return { doc: equality(left, right), left, right };
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

function effectCollectionBuiltin(
  target: string,
): "all" | "traverse" | undefined {
  const name = builtinName(target);
  return name === "all" || name === "traverse" ? name : undefined;
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
      return chainDocOf(this.chainOf(parameters, { kind: "expr", body }));
    }
    // An object literal body stays on the line of the arrow: `=> ({`.
    if (body.brace) return [parameters, " => (", body.doc, ")"];
    return [
      parameters,
      " =>",
      group(indent([line, flush(body)]), false, bodyGroup),
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
    const bodyGroup: GroupId = {};
    const single = chain.heads.length === 1 && tail.kind === "expr" &&
      !tail.body.brace;
    const doc = chain.heads.length > 1
      ? chainDocOf(chain)
      : tail.kind === "block"
      ? this.arrowBlock(parameters, tail.statements)
      : this.arrow(parameters, tail.body, bodyGroup);
    return emitted(doc, PREC.yield, {
      huggable: true,
      chain,
      ...(single ? { bodyGroup } : {}),
    });
  }

  /**
   * `const name = <arrow>;` without the semicolon. The caller gives the text
   * before the `=`. A chain that does not fit moves below the `=`. When some
   * head does not fit there, each head gets a line of its own.
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
    choices.push(indent([through, options.oneLine]));
    if (options.bodyDown !== undefined) {
      choices.push(indent([through, options.bodyDown]));
    }
    choices.push(indent([through, options.split(through)]));
    if (options.splitDown !== undefined) {
      choices.push(indent([through, options.splitDown(through)]));
    }
    choices.push([" ", options.splitAdaptive(hard)]);
    return [prefix, " =", alt(choices)];
  }

  // -------------------------------------------------------------- spans

  private tag(e: Expr, result: Emitted): Emitted {
    if (result.run !== undefined) {
      const run: Run = { ...result.run, top: e.span };
      return {
        ...result,
        run,
        doc: runDoc(run, 1),
        flush: runDoc(run, 0),
      };
    }
    const doc = spanned(e.span, result.doc);
    const withFlush = result.flush === undefined
      ? {}
      : { flush: spanned(e.span, result.flush) };
    if (result.condChain !== undefined) {
      const condChain: CondChain = { ...result.condChain, self: e.span };
      return { ...result, ...withFlush, doc, condChain };
    }
    if (result.chain === undefined) return { ...result, ...withFlush, doc };
    const [first, ...rest] = result.chain.heads;
    const chain: Chain = {
      heads: [{ doc: first.doc, span: e.span }, ...rest],
      tail: result.chain.tail,
    };
    return { ...result, ...withFlush, doc, chain };
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
          bracketed("[", "]", e.elements.map((x) => flush(kid(x))), false),
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
      case "defer": {
        const effect = this.scope.effect("Effect");
        const from = this.functionTypeOf(e.job.type);
        const job = from !== undefined && from.execution === "pure"
          ? this.fit(e.job, { ...from, execution: "effect" }, mode)
          : kid(e.job);
        return emitted([`${effect}.suspend`, callArguments([job])]);
      }
      case "unfold": {
        const stream = this.scope.effect("Stream");
        const effect = this.scope.effect("Effect");
        const option = this.scope.effect("Option");
        const state = this.scope.temp();
        const callback = this.effectCallback(e.next);
        const next = emitted([
          `${effect}.map`,
          callArguments([
            emitted([
              at(callback, PREC.member),
              callArguments([emitted(state)]),
            ]),
            emitted(`${option}.getOrUndefined`),
          ]),
        ]);
        return emitted([
          `${stream}.unfold`,
          callArguments([
            kid(e.seed),
            emitted(this.arrow(`(${state})`, next)),
          ]),
        ]);
      }
      case "map-effect": {
        const stream = this.scope.effect("Stream");
        return emitted([
          `${stream}.mapEffect`,
          callArguments([kid(e.stream), this.effectCallback(e.transform)]),
        ]);
      }
      case "flat-map-streams": {
        const stream = this.scope.effect("Stream");
        return emitted([
          `${stream}.flatMap`,
          callArguments([kid(e.stream), this.callback(e.transform, kid)]),
        ]);
      }
      case "sink-for-each": {
        const sink = this.scope.effect("Sink");
        return emitted([
          `${sink}.forEach`,
          callArguments([this.effectCallback(e.consume)]),
        ]);
      }
      case "buffer-stream": {
        const stream = this.scope.effect("Stream");
        return emitted([
          `${stream}.buffer`,
          callArguments([
            kid(e.stream),
            emitted(`{ capacity: ${e.capacity}, strategy: "suspend" }`),
          ]),
        ]);
      }
      case "merge-streams": {
        const stream = this.scope.effect("Stream");
        return emitted([
          `${stream}.merge`,
          callArguments([kid(e.left), kid(e.right)]),
        ]);
      }
      case "zip-streams": {
        const stream = this.scope.effect("Stream");
        return emitted([
          `${stream}.zip`,
          callArguments([kid(e.left), kid(e.right)]),
        ]);
      }
      case "concat-streams": {
        const stream = this.scope.effect("Stream");
        return emitted([
          `${stream}.concat`,
          callArguments([kid(e.left), kid(e.right)]),
        ]);
      }
      case "layer":
        return this.sourceLayer(e);
      case "merge-layers": {
        const layer = this.scope.effect("Layer");
        return emitted([
          `${layer}.merge`,
          callArguments([kid(e.left), kid(e.right)]),
        ]);
      }
      case "race": {
        const effect = this.scope.effect("Effect");
        return emitted([
          `${effect}.race`,
          callArguments([kid(e.left), kid(e.right)]),
        ]);
      }
      case "retry-schedule": {
        const schedule = this.scope.effect("Schedule");
        const effect = this.scope.effect("Effect");
        const option = this.scope.effect("Option");
        const cause = this.scope.effect("Cause");
        const duration = this.scope.effect("Duration");
        const type = this.scope.resolve(e.type);
        if (type.kind !== "retry-schedule") {
          throw internal("retry schedule has wrong type");
        }
        const error = typeDoc(this.scope, type.error);
        const step = this.pure(e.step);
        const metadata = this.scope.temp();
        const decision = this.scope.temp();
        return emitted([
          `${schedule}.fromStepWithMetadata<`,
          error,
          `, number, never, never, never, never>(${effect}.succeed((${metadata}: ${schedule}.InputMetadata<`,
          error,
          `>) => { const ${decision} = `,
          at(step, PREC.member),
          `(${metadata}.input, ${metadata}.attempt); if (${option}.isNone(${decision})) return ${cause}.done(${metadata}.attempt); `,
          `if (${decision}.value < 0) throw new RangeError("negative retry delay"); `,
          `return ${effect}.succeed([${metadata}.attempt, ${duration}.millis(${decision}.value)] as [number, ${duration}.Duration]); }))`,
        ]);
      }
      case "codec": {
        const type = this.scope.resolve(e.type);
        if (type.kind !== "codec") throw internal("codec has wrong type");
        const schema = this.scope.effect("Schema");
        const option = this.scope.effect("Option");
        const decode = this.pure(e.decode);
        const encode = this.pure(e.encode);
        const encodedSchema = schemaDoc(this.scope, type.encoded);
        const decodedSchema = schemaDoc(this.scope, type.decoded);
        const input = this.scope.temp();
        const value = this.scope.temp();
        return emitted([
          "{ decode: (",
          input,
          ": unknown) => { try { return ",
          `${option}.flatMap(`,
          `${schema}.decodeUnknownOption(`,
          encodedSchema,
          ")(",
          input,
          "), (",
          value,
          ") => ",
          `${schema}.decodeUnknownOption(`,
          decodedSchema,
          ")(",
          at(decode, PREC.member),
          "(",
          value,
          "))); } catch { return ",
          `${option}.none()`,
          "; } }, ",
          "encode: (",
          input,
          ": ",
          typeDoc(this.scope, type.decoded),
          ") => { try { return ",
          `${option}.flatMap(`,
          `${schema}.decodeUnknownOption(`,
          decodedSchema,
          ")(",
          input,
          "), (",
          value,
          ") => ",
          `${schema}.decodeUnknownOption(`,
          encodedSchema,
          ")(",
          at(encode, PREC.member),
          "(",
          value,
          "))); } catch { return ",
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
      case "retry-with-schedule":
      case "with-fiber":
      case "join-fiber":
      case "interrupt-fiber":
      case "provide":
      case "run":
      case "partition-all":
      case "validate-all":
      case "all-results":
      case "scoped":
      case "fork-scoped":
      case "with-resource":
      case "run-stream":
      case "make-ref":
      case "get-ref":
      case "set-ref":
      case "update-ref":
        throw internal(`${e.kind} node in a structural position`);
    }
  }

  private sourceLayer(e: Extract<Expr, { kind: "layer" }>): Emitted {
    const declaration = this.scope.typeLevelDeclaration(e.service);
    const acquire = this.functionTypeOf(e.acquire.type);
    const implementation = acquire === undefined
      ? undefined
      : this.scope.resolve(acquire.result);
    if (declaration?.kind !== "service" || implementation?.kind !== "record") {
      throw internal("a source layer needs a checked service implementation");
    }
    const effect = this.scope.effect("Effect");
    const layer = this.scope.effect("Layer");
    const instance = this.scope.temp();
    const fields: Doc[] = declaration.methods.map((method) => {
      const field = implementation.fields.find((f) => f.name === method.name);
      const source = field === undefined
        ? undefined
        : this.scope.resolve(field.type);
      if (source?.kind !== "function") {
        throw internal(`the layer method ${method.name} is not a function`);
      }
      const names = method.type.parameters.map(() => this.scope.temp());
      const parameters = bracketed(
        "(",
        ")",
        names.map((
          name,
          i,
        ) => [name, ": ", typeDoc(this.scope, method.type.parameters[i])]),
        false,
      );
      const invoke = emitted([
        instance,
        ".",
        method.name,
        callArguments(names.map((name) => emitted(name))),
      ]);
      const body = source.execution === "pure"
        ? emitted([`${effect}.succeed`, callArguments([invoke])])
        : invoke;
      return [method.name, ": ", this.arrow(parameters, body)];
    });
    const assembled = this.objectLiteral(fields, []);
    const mapped = emitted([
      `${effect}.map`,
      callArguments([
        this.suspended(e.acquire),
        emitted(this.arrow(`(${instance})`, assembled)),
      ]),
    ]);
    return emitted([
      `${layer}.effect`,
      callArguments([emitted(this.scope.nameOf(e.service)), mapped]),
    ]);
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

  /** The declared type of a field of a record type or of a brand of a record. */
  private fieldType(type: Type, name: string): Type | undefined {
    return this.recordFieldsOf(type)?.find((f) => f.name === name)?.type;
  }

  /** The fields of a record type, seen through aliases and brands of a record. */
  private recordFieldsOf(
    type: Type,
    depth = 0,
  ): readonly Field[] | undefined {
    if (depth >= 64) return undefined;
    const resolved = this.scope.resolve(type);
    if (resolved.kind === "record") return resolved.fields;
    if (resolved.kind !== "named") return undefined;
    const declaration = this.scope.typeLevelDeclaration(resolved.id);
    return declaration?.kind === "type" &&
        declaration.definition.kind === "brand"
      ? this.recordFieldsOf(declaration.definition.base, depth + 1)
      : undefined;
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

  /**
   * True when one member of the type has the field as optional. The checker
   * reads an optional field of one union member as an option, so the emitter
   * looks through unions, aliases, brands of a record, and named errors.
   */
  private isOptionalField(type: Type, field: string, depth = 0): boolean {
    if (depth >= 64) return false;
    const resolved = this.scope.resolve(type);
    if (resolved.kind === "union") {
      return resolved.members.some((member) =>
        this.isOptionalField(member, field, depth + 1)
      );
    }
    if (resolved.kind === "named") {
      const declaration = this.scope.typeLevelDeclaration(resolved.id);
      if (declaration?.kind === "error") {
        return declaration.fields.some((f) => f.name === field && f.optional);
      }
    }
    return this.recordFieldsOf(resolved)?.some((f) =>
      f.name === field && f.optional
    ) ?? false;
  }

  private binary(
    e: Extract<Expr, { kind: "binary" }>,
    kid: Kid,
  ): Emitted {
    const prec = binaryPrecedence(e.operator);
    const left = kid(e.left);
    const right = at(kid(e.right), prec + 1);
    // A left operand of the same level joins the run; `at` adds no parentheses.
    const run: Run = left.run !== undefined && left.prec === prec &&
        left.run.top !== undefined
      ? {
        operands: [...left.run.operands, right],
        operators: [...left.run.operators, e.operator],
        inner: [...left.run.inner, left.run.top],
        top: undefined,
      }
      : {
        operands: [at(left, prec), right],
        operators: [e.operator],
        inner: [],
        top: undefined,
      };
    const brand = e.operator === "+" || e.operator === "-"
      ? this.numericBrand(e.type)
      : undefined;
    if (brand !== undefined) {
      // The sum of two brand values is a plain number until `make` brands it.
      const body = emitted(runDoc(run, 1), prec);
      return emitted([
        this.scope.nameOf(brand.id),
        ".make",
        callArguments([brand.integral ? this.intCall(body) : body]),
      ]);
    }
    const arithmetic = e.operator === "+" || e.operator === "-" ||
      e.operator === "*";
    if (arithmetic && isIntType(e.type)) {
      return this.intCall(emitted(runDoc(run, 1), prec));
    }
    return emitted(runDoc(run, 1), prec, {
      brace: leadingBrace(left, prec),
      run,
    });
  }

  /** The brand id and base kind when the type is a brand of `int` or `number`. */
  private numericBrand(
    type: Type,
  ): { readonly id: DeclarationId; readonly integral: boolean } | undefined {
    const resolved = this.scope.resolve(type);
    if (resolved.kind !== "named") return undefined;
    const declaration = this.scope.typeLevelDeclaration(resolved.id);
    if (
      declaration?.kind !== "type" || declaration.definition.kind !== "brand"
    ) return undefined;
    const base = this.scope.resolve(declaration.definition.base);
    if (isIntType(base)) return { id: resolved.id, integral: true };
    return base.kind === "primitive" && base.name === "number"
      ? { id: resolved.id, integral: false }
      : undefined;
  }

  private intCall(body: Emitted): Emitted {
    return emitted([this.scope.intFunction(), callArguments([body])]);
  }

  private conditional(
    e: Extract<Expr, { kind: "if" }>,
    kid: Kid,
  ): Emitted {
    const condition = kid(e.condition);
    const then = at(kid(e.then, e.type), PREC.conditional);
    const otherwise = kid(e.else, e.type);
    const rest = otherwise.condChain;
    // A test that breaks keeps its lines one level deeper than the `?` line.
    // After a `return` or `=` that is two levels, as the body of an arrow one.
    // A comparison of two operands keeps two levels in a flush body too.
    const chain: CondChain = rest === undefined
      ? {
        tests: [condition],
        arms: [then],
        last: at(otherwise, PREC.conditional),
        nested: [],
        self: undefined,
      }
      : {
        tests: [condition, ...rest.tests],
        arms: [then, ...rest.arms],
        last: rest.last,
        nested: rest.self === undefined
          ? rest.nested
          : [rest.self, ...rest.nested],
        self: undefined,
      };
    const brace = { brace: leadingBrace(condition, PREC.or), condChain: chain };
    if (condition.run === undefined) {
      return emitted(condDoc(chain, 2), PREC.conditional, brace);
    }
    return emitted(condDoc(chain, 2), PREC.conditional, {
      ...brace,
      flush: condDoc(chain, isComparison(condition.run) ? 2 : 1),
    });
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

  private effectCallback(arg: Expr): Emitted {
    const from = this.functionTypeOf(arg.type);
    if (from === undefined) {
      throw internal("a stream callback is not a function");
    }
    return this.fit(arg, { ...from, execution: "effect" }, "pure");
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
    let pairs: { readonly test: ArmTest; readonly arm: Doc }[] = [];
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
    const chain: Doc = pairs.length === 0 ? last : conditionalChain(
      pairs[0].test.doc,
      pairs.slice(1).map((pair) => ({
        doc: pair.test.doc,
        split: {
          head: [pair.test.left, " ==="],
          right: pair.test.right,
        },
      })),
      pairs.map((pair) => pair.arm),
      last,
    );
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

  private armTest(pattern: Pattern, selector: string): ArmTest | undefined {
    switch (pattern.kind) {
      case "wildcard":
        return undefined;
      case "literal":
        return armEquality(selector, this.literal(pattern.value));
      case "error":
        return armEquality(
          `${selector}._tag`,
          JSON.stringify(tokenOfId(pattern.error)),
        );
      case "tag":
        return armEquality(
          `${selector}.${pattern.field}`,
          JSON.stringify(pattern.value),
        );
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
      case "retry-with-schedule":
      case "with-fiber":
      case "join-fiber":
      case "interrupt-fiber":
      case "provide":
      case "run":
      case "partition-all":
      case "validate-all":
      case "all-results":
      case "scoped":
      case "fork-scoped":
      case "catch":
      case "with-resource":
      case "run-stream":
      case "make-ref":
      case "get-ref":
      case "set-ref":
      case "update-ref":
        return true;
      default:
        return false;
    }
  }

  /** The children that a leaf evaluates before it runs, in source order. */
  private evaluatedChildren(e: Expr): Expr[] {
    switch (e.kind) {
      case "call":
        return e.callee.kind === "reference" &&
            effectCollectionBuiltin(e.callee.target) !== undefined
          ? [...e.arguments]
          : [e.callee, ...e.arguments];
      case "perform":
        return [...e.arguments];
      case "fail":
        return [e.error];
      case "run":
      case "scoped":
        return [e.value];
      case "partition-all":
        return [e.jobs];
      case "validate-all":
        return [e.jobs, e.onErrors];
      case "all-results":
        return [e.jobs];
      case "fork-scoped":
        return [e.job];
      case "run-stream":
        return [e.stream, e.sink];
      case "make-ref":
        return [e.value];
      case "get-ref":
        return [e.ref];
      case "set-ref":
        return [e.ref, e.value];
      case "update-ref":
        return [e.ref, e.transform];
      case "with-fiber":
        return [e.job];
      case "join-fiber":
      case "interrupt-fiber":
        return [e.fiber];
      default:
        return [];
    }
  }

  /** The declared type of each evaluated child of a leaf, where the program states one. */
  private expectedChildren(e: Expr): (Type | undefined)[] {
    switch (e.kind) {
      case "call":
        return e.callee.kind === "reference" &&
            effectCollectionBuiltin(e.callee.target) !== undefined
          ? [...(this.functionTypeOf(e.callee.type)?.parameters ?? [])]
          : [
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
        if (e.callee.kind === "reference") {
          const builtin = effectCollectionBuiltin(e.callee.target);
          if (builtin !== undefined) {
            if (
              children.length !== (builtin === "all" ? 1 : 2) &&
              children.length !== (builtin === "all" ? 2 : 3)
            ) {
              throw internal(`${builtin} has an invalid argument count`);
            }
            return emitted([
              `${effect}.${builtin === "all" ? "all" : "forEach"}(`,
              free(children[0]),
              ...(builtin === "traverse" ? [", ", free(children[1])] : []),
              ...(children[builtin === "all" ? 1 : 2] === undefined
                ? []
                : [", ", free(children[builtin === "all" ? 1 : 2])]),
              ")",
            ]);
          }
        }
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
        const bodyGroup: GroupId = {};
        const arrow = emitted(
          this.arrow(`(${parameter})`, call, bodyGroup),
          PREC.yield,
          { huggable: true, bodyGroup },
        );
        return emitted([`${service}.use`, callArguments([arrow])]);
      }
      case "fail":
        return emitted([`${effect}.fail`, callArguments([children[0]])]);
      case "run":
        return children[0];
      case "partition-all":
        return emitted([
          `${effect}.partition`,
          callArguments([
            children[0],
            emitted("(job) => job"),
            ...(e.concurrency === undefined
              ? []
              : [emitted(`{ concurrency: ${
                e.concurrency === "unbounded"
                  ? '"unbounded"'
                  : e.concurrency
              } }`)]),
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
                ...(e.concurrency === undefined
                  ? []
                  : [emitted(`{ concurrency: ${
                    e.concurrency === "unbounded"
                      ? '"unbounded"'
                      : e.concurrency
                  } }`)]),
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
                  : `, concurrency: ${
                    e.concurrency === "unbounded"
                      ? '"unbounded"'
                      : e.concurrency
                  }`
              } }`,
            ),
          ]),
        ]);
      case "scoped":
        return emitted([`${effect}.scoped`, callArguments([children[0]])]);
      case "fork-scoped":
        return emitted([
          `${effect}.as`,
          callArguments([
            emitted([`${effect}.forkScoped`, callArguments([children[0]])]),
            emitted("undefined"),
          ]),
        ]);
      case "run-stream": {
        const stream = this.scope.effect("Stream");
        return emitted([
          `${stream}.run`,
          callArguments([children[0], children[1]]),
        ]);
      }
      case "make-ref":
      case "get-ref":
      case "set-ref":
      case "update-ref": {
        const ref = this.scope.effect("Ref");
        const method = e.kind === "make-ref"
          ? "make"
          : e.kind === "get-ref"
          ? "get"
          : e.kind === "set-ref"
          ? "set"
          : "update";
        return emitted([`${ref}.${method}`, callArguments(children)]);
      }
      case "with-resource": {
        if (
          e.acquire.kind !== "closure" || e.use.kind !== "closure" ||
          e.release.kind !== "closure"
        ) {
          throw internal("with-resource requires three closures");
        }
        const acquire = this.closure(e.acquire, false, true);
        const use = this.closure(e.use, false, true);
        const release = this.closure(e.release, false, true);
        return emitted([
          `${effect}.acquireUseRelease`,
          callArguments([
            emitted([`${effect}.suspend`, callArguments([acquire])]),
            use,
            release,
          ]),
        ]);
      }
      case "retry": {
        const job = this.suspended(e.job);
        const options = emitted(`{ times: ${e.times} }`, PREC.member, {
          huggable: true,
        });
        return emitted([`${effect}.retry`, callArguments([job, options])]);
      }
      case "retry-with-schedule":
        return emitted([
          `${effect}.retry`,
          callArguments([this.suspended(e.job), this.pure(e.options)]),
        ]);
      case "with-fiber": {
        const fiber = this.scope.effect("Fiber");
        const job = children[0] ?? this.pure(e.job);
        return emitted([
          `${effect}.acquireUseRelease`,
          callArguments([
            emitted([`${effect}.forkChild`, callArguments([job])]),
            this.effectCallback(e.use),
            emitted(`${fiber}.interrupt`),
          ]),
        ]);
      }
      case "join-fiber":
      case "interrupt-fiber": {
        const fiber = this.scope.effect("Fiber");
        return emitted([
          `${fiber}.${e.kind === "join-fiber" ? "join" : "interrupt"}`,
          callArguments([children[0] ?? this.pure(e.fiber)]),
        ]);
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

  /** `Effect.suspend(job)`. A pure job is lifted, because `suspend` needs an effect. */
  private suspended(job: Expr): Emitted {
    const effect = this.scope.effect("Effect");
    const from = this.functionTypeOf(job.type);
    const value = from !== undefined && from.execution === "pure"
      ? this.fit(job, { ...from, execution: "effect" }, "pure")
      : this.pure(job);
    return emitted([`${effect}.suspend`, callArguments([value])]);
  }

  /**
   * `"key": (e) => body`. When the head `"key": (e) =>` does not fit on a
   * line, `deno fmt` moves the arrow below the key. Else the body moves down.
   */
  private handlerEntry(key: string, parameters: string, body: Emitted): Doc {
    const arrow = this.arrow(parameters, body);
    if (body.chain !== undefined || body.brace) return [key, ": ", arrow];
    return alt([
      [key, ": ", arrow],
      [key, ": ", parameters, " =>", indent([hard, flush(body)])],
      [key, ":", indent([hard, arrow])],
    ]);
  }

  private catchEffect(e: Extract<Expr, { kind: "catch" }>): Emitted {
    const effect = this.scope.effect("Effect");
    const handlers = e.handlers.map((h: Handler) =>
      this.handlerEntry(
        JSON.stringify(tokenOfId(h.error)),
        `(${h.binding.name})`,
        this.asEffect(h.body),
      )
    );
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
