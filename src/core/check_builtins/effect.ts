// Effect construction, execution, failure and retry checking.
import { isErrorId } from "../ids.ts";
import type { ErrorId, Result } from "../ir.ts";
import { kindOf, type NodeId, SyntaxKind } from "../syntax.ts";
import { nameTextOf } from "../syntax_queries.ts";
import {
  combine,
  EFFECT_ONLY,
  type EffectSet,
  type NodeInfo,
  PURE_EFFECTS,
} from "../tables.ts";
import type { TypeRef } from "../types.ts";
import {
  type Arg,
  type BuiltinContext,
  type FactWriter,
  type FunctionNode,
  invocationOf,
  type LiteralField,
  type SyntaxView,
} from "./context.ts";
import { direct, piped, type PreludeCallName, type Rows } from "./rows.ts";
export interface EffectContext extends
  Pick<
    BuiltinContext,
    | "table"
    | "assignable"
    | "argInfo"
    | "callback"
    | "finish"
    | "fits"
    | "functionOf"
    | "isError"
    | "report"
  >,
  SyntaxView,
  FactWriter {
  arity(
    node: NodeId,
    name: string,
    expectedCount: number,
    args: readonly Arg[],
    usage?: string,
  ): boolean;
  literalRecord(
    arg: Arg,
    count: number,
  ): Result<ReadonlyMap<string, LiteralField>, "shape">;
  jobFunction(name: string, arg: Arg, info: NodeInfo): FunctionNode | undefined;
}

export function failCall(
  c: EffectContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.fact(node, { kind: "fail" });
  const rightCount = c.arity(node, "fail", 1, args);
  const infos = args.map((a) => c.argInfo(a));
  let failure: ErrorId | undefined;
  if (rightCount) {
    const unfolded = c.table.node(c.table.unfold(infos[0].type));
    if (unfolded.kind === "named" && isErrorId(unfolded.id)) {
      failure = unfolded.id;
    } else if (!c.isError(infos[0].type)) {
      c.report(
        "type-mismatch/010",
        `\`fail\` needs a value of a named error type, but the value has type ${
          c.table.show(infos[0].type)
        }`,
        args[0].node,
      );
    }
  }
  const own: EffectSet = {
    failures: failure === undefined ? [] : [failure],
    requirements: [],
    mode: "effect",
  };
  return c.finish(node, c.table.never, combine([...infos, own]));
}

export function retryCall(
  c: EffectContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const job = c.argInfo(args[0]);
  const fn = c.jobFunction("retry", args[0], job);
  if (retryScheduleOption(c, args[1])) {
    const options = c.argInfo(args[1]);
    const shape = c.table.node(c.table.unfold(options.type));
    const policy = shape.kind === "record"
      ? c.table.node(c.table.unfold(shape.fields[0].type))
      : undefined;
    if (policy?.kind !== "retry-schedule") {
      c.report(
        "type-mismatch/010",
        "`retry` needs a RetrySchedule in `schedule`",
        args[1].node,
      );
    } else if (fn !== undefined) {
      for (const failure of fn.failures) {
        if (!c.assignable(c.table.named(failure), policy.error)) {
          c.report(
            "type-mismatch/003",
            `the retry schedule does not accept ${failure}`,
            args[1].node,
          );
        }
      }
    }
    c.fact(node, { kind: "retry-with-schedule" });
    const invocation: EffectSet = invocationOf(fn);
    return c.finish(
      node,
      fn?.result ?? c.table.error,
      combine([job, options, invocation, EFFECT_ONLY]),
    );
  }
  const times = retryTimes(c, args[1]);
  c.fact(node, { kind: "retry", times });
  const invocation: EffectSet = invocationOf(fn);
  return c.finish(
    node,
    fn?.result ?? c.table.error,
    combine([job, invocation, EFFECT_ONLY]),
  );
}

export function retryScheduleCall(
  c: EffectContext,
  node: NodeId,
  args: readonly Arg[],
  expected: TypeRef | undefined,
): NodeInfo {
  const expectedType = expected === undefined
    ? undefined
    : c.table.node(c.table.unfold(expected));
  const errorHint = expectedType?.kind === "retry-schedule"
    ? expectedType.error
    : undefined;
  const info = errorHint === undefined ? c.argInfo(args[0]) : c.callback(
    "retrySchedule",
    args[0],
    [errorHint, c.table.int],
    c.table.option(c.table.int),
  ).info;
  const fn = c.functionOf(info.type);
  if (fn === undefined) {
    if (!c.isError(info.type)) {
      c.report(
        "type-mismatch/010",
        "`retrySchedule` needs a function",
        args[0].node,
      );
    }
    return c.finish(node, c.table.error, combine([info]));
  }
  if (fn.parameters.length !== 2) {
    c.report(
      "type-mismatch/004",
      "the retry schedule callback takes an error and an attempt number",
      args[0].node,
    );
    return c.finish(node, c.table.error, combine([info]));
  }
  const error = c.table.node(c.table.unfold(fn.parameters[0]));
  if (error.kind !== "named" || !isErrorId(error.id)) {
    c.report(
      "type-mismatch/010",
      "the retry schedule callback needs a nominal error parameter",
      args[0].node,
    );
  }
  c.fits(
    args[0].node,
    fn.parameters[1],
    c.table.int,
    "the retry attempt number",
  );
  c.fits(
    args[0].node,
    fn.result,
    c.table.option(c.table.int),
    "the retry delay",
  );
  if (
    fn.execution !== "pure" || fn.failures.length > 0 ||
    fn.requirements.length > 0
  ) {
    c.report(
      "execution-mode/001",
      "the retry schedule callback must be pure",
      args[0].node,
    );
  }
  const type = error.kind === "named" && isErrorId(error.id)
    ? c.table.retrySchedule(fn.parameters[0])
    : c.table.error;
  return c.finish(node, type, combine([info]));
}

export function deferCall(
  c: EffectContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const job = c.argInfo(args[0]);
  const fn = c.jobFunction("defer", args[0], job);
  return c.finish(
    node,
    fn === undefined
      ? c.table.error
      : c.table.effect(fn.result, fn.failures, fn.requirements),
    job,
  );
}

export function runCall(
  c: EffectContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const value = c.argInfo(args[0]);
  const type = c.table.node(c.table.unfold(value.type));
  if (type.kind !== "effect") {
    if (!c.isError(value.type)) {
      c.report(
        "type-mismatch/010",
        `\`run\` needs an Effect value, but the argument has type ${
          c.table.show(value.type)
        }`,
        args[0].node,
      );
    }
    return c.finish(node, c.table.error, combine([value, EFFECT_ONLY]));
  }
  return c.finish(
    node,
    type.result,
    combine([
      value,
      {
        failures: type.failures,
        requirements: type.requirements,
        mode: "effect",
      },
    ]),
  );
}

export function raceCall(
  c: EffectContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const left = c.argInfo(args[0]);
  const right = c.argInfo(args[1]);
  const a = c.table.node(c.table.unfold(left.type));
  const b = c.table.node(c.table.unfold(right.type));
  if (a.kind !== "effect" || b.kind !== "effect") {
    c.report("type-mismatch/010", "`race` needs two Effect values", node);
    return c.finish(node, c.table.error, combine([left, right]));
  }
  const aFitsB = c.assignable(a.result, b.result);
  const bFitsA = c.assignable(b.result, a.result);
  if (!aFitsB && !bFitsA) {
    c.report(
      "type-mismatch/010",
      "`race` needs compatible success types",
      node,
    );
  }
  const type = c.table.effect(aFitsB ? b.result : a.result, [
    ...a.failures,
    ...b.failures,
  ], [...a.requirements, ...b.requirements]);
  return c.finish(node, type, combine([left, right]));
}

function retryTimes(c: EffectContext, arg: Arg): number | undefined {
  const record = c.literalRecord(arg, 1);
  const times = record.ok ? record.value.get("times") : undefined;
  const value = times?.value;
  if (
    times === undefined || typeof value !== "number" ||
    !Number.isSafeInteger(value) || value < 0
  ) {
    c.report(
      "type-mismatch/010",
      "`retry` needs `{ times: N }`, where N is a finite nonnegative safe integer literal",
      arg.node,
    );
    return undefined;
  }
  c.finish(times.node, c.table.int, PURE_EFFECTS);
  c.finish(
    arg.node,
    c.table.record([{
      name: "times",
      type: c.table.int,
      optional: false,
    }]),
    PURE_EFFECTS,
  );
  return value;
}

function retryScheduleOption(c: EffectContext, arg: Arg): boolean {
  if (
    arg.pre !== undefined ||
    kindOf(c.tree, arg.node) !== SyntaxKind.RecordExpr
  ) {
    return false;
  }
  const fields = c.kids(arg.node);
  if (
    fields.length !== 1 ||
    kindOf(c.tree, fields[0]) !== SyntaxKind.RecordField
  ) {
    return false;
  }
  const name = c.kids(fields[0]).find((k) =>
    kindOf(c.tree, k) === SyntaxKind.Name
  );
  return name !== undefined && nameTextOf(c.tree, name) === "schedule";
}

/** The rows of the Effect builtins. */
export const EFFECT_ROWS = {
  fail: {
    prologue: "own-arity",
    handle: (c, node, _name, args) => failCall(c, node, args),
  },
  retry: {
    prologue: piped(2, "effect", {
      bailFact: { kind: "retry", times: undefined },
    }),
    handle: (c, node, _name, args) => retryCall(c, node, args),
  },
  retrySchedule: {
    prologue: piped(1, "pure", { fact: { kind: "retry-schedule" } }),
    handle: (c, node, _name, args, expected) =>
      retryScheduleCall(c, node, args, expected),
  },
  defer: {
    prologue: piped(1, "pure", { fact: { kind: "defer" } }),
    handle: (c, node, _name, args) => deferCall(c, node, args),
  },
  run: {
    prologue: piped(1, "effect", { fact: { kind: "run" } }),
    handle: (c, node, _name, args) => runCall(c, node, args),
  },
  race: {
    prologue: direct(2, "pure", { fact: { kind: "race" } }),
    handle: (c, node, _name, args) => raceCall(c, node, args),
  },
} satisfies Partial<Rows<PreludeCallName, EffectContext>>;
