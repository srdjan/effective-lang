// Collection checking. Prelude dispatch retains arity and lowering-fact policy.
import type { NodeId } from "../syntax.ts";
import { isErrorId } from "../ids.ts";
import { combine, type NodeInfo } from "../tables.ts";
import type { TypeRef } from "../types.ts";
import type { Arg, BuiltinContext, FactWriter } from "./context.ts";

export interface CollectionContext extends
  Pick<
    BuiltinContext,
    | "table"
    | "argInfo"
    | "callback"
    | "finish"
    | "fits"
    | "functionOf"
    | "isError"
    | "report"
    | "widen"
  >,
  FactWriter {
  noPipeline(name: string, args: readonly Arg[]): void;
  concurrencyBound(
    arg: Arg,
    operation?:
      | "traverse"
      | "all"
      | "partitionAll"
      | "validateAll"
      | "allResults",
  ): number | "unbounded" | undefined;
}

export function allCall(
  c: CollectionContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const input = c.argInfo(args[0]);
  const table = c.table;
  const shape = table.node(table.unfold(input.type));
  const effectTypes = shape.kind === "tuple"
    ? shape.elements
    : shape.kind === "record"
    ? shape.fields.map((field) => field.type)
    : shape.kind === "array"
    ? [shape.element]
    : undefined;
  const option = args[1] === undefined ? undefined : c.argInfo(args[1]);
  const concurrency = args[1] === undefined
    ? undefined
    : c.concurrencyBound(args[1], "all");
  if (effectTypes === undefined) {
    c.report(
      "type-mismatch/010",
      "`all` needs a tuple, record, or array of Effect values",
      args[0].node,
    );
    return c.finish(
      node,
      table.error,
      combine([input, ...(option === undefined ? [] : [option])]),
    );
  }
  if (shape.kind === "record" && shape.fields.some((field) => field.optional)) {
    c.report(
      "type-mismatch/010",
      "`all` requires every record field to be present",
      args[0].node,
    );
  }
  const effects = effectTypes.map((type) => {
    const member = table.node(table.unfold(type));
    if (member.kind !== "effect") {
      c.report(
        "type-mismatch/010",
        "`all` requires an Effect value at every position",
        args[0].node,
      );
      return { result: table.error, failures: [], requirements: [] };
    }
    return member;
  });
  const invocation = combine(effects.map((effect) => ({
    failures: effect.failures,
    requirements: effect.requirements,
    mode: "effect" as const,
  })));
  const results = effects.map((effect) => effect.result);
  const result = shape.kind === "tuple"
    ? table.tuple(results)
    : shape.kind === "record"
    ? table.record(shape.fields.map((field, i) => ({
      name: field.name,
      type: results[i],
      optional: false,
    })))
    : table.array(results[0]);
  const specialized = table.function({
    execution: "effect",
    parameters: args.length === 2
      ? [
        input.type,
        table.record([{
          name: "concurrency",
          type: concurrency === "unbounded" ? table.string : table.int,
          optional: false,
        }]),
      ]
      : [input.type],
    result,
    failures: invocation.failures,
    requirements: invocation.requirements,
  });
  c.fact(node, {
    kind: "builtin",
    name: "all",
    specialized,
    ir: table.toIrFunction(specialized),
  });
  return c.finish(
    node,
    result,
    combine([input, ...(option === undefined ? [] : [option]), invocation]),
  );
}

export function partitionAllCall(
  c: CollectionContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.noPipeline("partitionAll", args);
  const jobs = c.argInfo(args[0]);
  const option = args[1] === undefined ? undefined : c.argInfo(args[1]);
  const concurrency = args[1] === undefined
    ? undefined
    : c.concurrencyBound(args[1], "partitionAll");
  c.fact(node, { kind: "partition-all", concurrency });
  const shape = c.table.node(c.table.unfold(jobs.type));
  const member = shape.kind === "array"
    ? c.table.node(c.table.unfold(shape.element))
    : undefined;
  if (member?.kind !== "effect") {
    if (!c.isError(jobs.type)) {
      c.report(
        "type-mismatch/010",
        "`partitionAll` needs an array of Effect values",
        args[0].node,
      );
    }
    return c.finish(
      node,
      c.table.error,
      combine([jobs, ...(option === undefined ? [] : [option])]),
    );
  }
  const errors = c.table.union(member.failures.map((id) => c.table.named(id)));
  const result = c.table.tuple([
    c.table.array(member.result),
    c.table.array(errors),
  ]);
  return c.finish(
    node,
    result,
    combine([jobs, ...(option === undefined ? [] : [option]), {
      failures: [],
      requirements: member.requirements,
      mode: "effect",
    }]),
  );
}

export function validateAllCall(
  c: CollectionContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.noPipeline("validateAll", args);
  const jobs = c.argInfo(args[0]);
  const shape = c.table.node(c.table.unfold(jobs.type));
  const member = shape.kind === "array"
    ? c.table.node(c.table.unfold(shape.element))
    : undefined;
  if (member?.kind !== "effect" && !c.isError(jobs.type)) {
    c.report(
      "type-mismatch/010",
      "`validateAll` needs an array of Effect values",
      args[0].node,
    );
  }
  const errors = member?.kind === "effect"
    ? c.table.union(member.failures.map((id) => c.table.named(id)))
    : c.table.error;
  const wrapped = c.callback(
    "validateAll",
    args[1],
    [c.table.array(errors)],
    undefined,
  );
  const wrapper = c.table.node(c.table.unfold(wrapped.result));
  if (wrapper.kind !== "named" || !isErrorId(wrapper.id)) {
    if (!c.isError(wrapped.result)) {
      c.report(
        "type-mismatch/010",
        "`validateAll` error wrapper must return a nominal error",
        args[1].node,
      );
    }
  }
  const option = args[2] === undefined ? undefined : c.argInfo(args[2]);
  const concurrency = args[2] === undefined
    ? undefined
    : c.concurrencyBound(args[2], "validateAll");
  c.fact(node, { kind: "validate-all", concurrency });
  return c.finish(
    node,
    member?.kind === "effect" ? c.table.array(member.result) : c.table.error,
    combine([jobs, wrapped.info, ...(option === undefined ? [] : [option]), {
      failures: wrapper.kind === "named" &&
          isErrorId(wrapper.id)
        ? [wrapper.id]
        : [],
      requirements: member?.kind === "effect" ? member.requirements : [],
      mode: "effect",
    }]),
  );
}

export function allResultsCall(
  c: CollectionContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.noPipeline("allResults", args);
  const jobs = c.argInfo(args[0]);
  const option = args[1] === undefined ? undefined : c.argInfo(args[1]);
  const concurrency = args[1] === undefined
    ? undefined
    : c.concurrencyBound(args[1], "allResults");
  c.fact(node, { kind: "all-results", concurrency });
  const table = c.table;
  const shape = table.node(table.unfold(jobs.type));
  const members = shape.kind === "tuple"
    ? shape.elements
    : shape.kind === "record"
    ? shape.fields.map((field) => field.type)
    : shape.kind === "array"
    ? [shape.element]
    : undefined;
  if (members === undefined) {
    if (!c.isError(jobs.type)) {
      c.report(
        "type-mismatch/010",
        "`allResults` needs a tuple, record, or array of Effect values",
        args[0].node,
      );
    }
    return c.finish(
      node,
      table.error,
      combine([jobs, ...(option === undefined ? [] : [option])]),
    );
  }
  if (shape.kind === "record" && shape.fields.some((field) => field.optional)) {
    c.report(
      "type-mismatch/010",
      "`allResults` requires every record field to be present",
      args[0].node,
    );
  }
  const outcomes = members.map((type) => {
    const member = table.node(table.unfold(type));
    if (member.kind !== "effect") {
      c.report(
        "type-mismatch/010",
        "`allResults` requires an Effect value at every position",
        args[0].node,
      );
      return { result: table.error, requirements: [] };
    }
    const error = table.union(member.failures.map((id) => table.named(id)));
    return {
      result: table.union([
        table.record([
          { name: "_tag", type: table.literal("Success"), optional: false },
          { name: "success", type: member.result, optional: false },
        ]),
        table.record([
          { name: "_tag", type: table.literal("Failure"), optional: false },
          { name: "failure", type: error, optional: false },
        ]),
      ]),
      requirements: member.requirements,
    };
  });
  const result = shape.kind === "tuple"
    ? table.tuple(outcomes.map((outcome) => outcome.result))
    : shape.kind === "record"
    ? table.record(shape.fields.map((field, i) => ({
      name: field.name,
      type: outcomes[i].result,
      optional: false,
    })))
    : table.array(outcomes[0].result);
  return c.finish(
    node,
    result,
    combine([jobs, ...(option === undefined ? [] : [option]), {
      failures: [],
      requirements: outcomes.flatMap((outcome) => outcome.requirements),
      mode: "effect",
    }]),
  );
}

export function collectionCall(
  c: CollectionContext,
  node: NodeId,
  name: "map" | "filter" | "fold" | "traverse",
  args: readonly Arg[],
  expected: TypeRef | undefined,
): NodeInfo {
  const xs = c.argInfo(args[0]);
  const element = arrayElement(c, name, args[0], xs);
  const table = c.table;
  const infos: NodeInfo[] = [xs];
  let result: TypeRef;
  let specialized: TypeRef;
  if (name === "traverse") {
    const cb = c.callback(name, args[1], [element], undefined, true);
    infos.push(cb.info);
    const concurrency = args[2] === undefined
      ? undefined
      : c.concurrencyBound(args[2]);
    if (args[2] !== undefined) {
      infos.push(c.argInfo(args[2]));
    }
    const fn = c.functionOf(cb.info.type);
    const failures = fn?.failures ?? [];
    const requirements = fn?.requirements ?? [];
    const callbackType = table.function({
      execution: "effect",
      parameters: [element],
      result: cb.result,
      failures,
      requirements,
    });
    result = table.array(cb.result);
    specialized = table.function({
      execution: "effect",
      parameters: args.length === 3
        ? [
          table.array(element),
          callbackType,
          table.record([{
            name: "concurrency",
            type: concurrency === "unbounded" ? table.string : table.int,
            optional: false,
          }]),
        ]
        : [table.array(element), callbackType],
      result,
      failures,
      requirements,
    });
  } else if (name === "map") {
    const cb = c.callback(name, args[1], [element], undefined);
    infos.push(cb.info);
    result = table.array(cb.result);
    specialized = pureFunction(c, [
      table.array(element),
      pureFunction(c, [element], cb.result),
    ], result);
  } else if (name === "filter") {
    const cb = c.callback(name, args[1], [element], table.boolean);
    infos.push(cb.info);
    c.fits(args[1].node, cb.result, table.boolean, "the predicate result");
    result = table.array(element);
    specialized = pureFunction(c, [
      result,
      pureFunction(c, [element], table.boolean),
    ], result);
  } else {
    const initial = c.argInfo(args[1], expected);
    infos.push(initial);
    const accumulator = expected ?? c.widen(initial.type);
    c.fits(args[1].node, initial.type, accumulator, "the initial value");
    const cb = c.callback(name, args[2], [accumulator, element], accumulator);
    infos.push(cb.info);
    c.fits(args[2].node, cb.result, accumulator, "the callback result");
    result = accumulator;
    specialized = pureFunction(c, [
      table.array(element),
      accumulator,
      pureFunction(c, [accumulator, element], accumulator),
    ], result);
  }
  c.fact(node, {
    kind: "builtin",
    name,
    specialized,
    ir: table.toIrFunction(specialized),
  });
  const invocation = name === "traverse"
    ? c.table.node(specialized)
    : undefined;
  return c.finish(
    node,
    result,
    invocation?.kind === "function"
      ? combine([...infos, {
        failures: invocation.failures,
        requirements: invocation.requirements,
        mode: invocation.execution,
      }])
      : combine(infos),
  );
}

function arrayElement(
  c: CollectionContext,
  name: string,
  arg: Arg,
  info: NodeInfo,
): TypeRef {
  const node = c.table.node(c.table.unfold(info.type));
  if (node.kind === "array") {
    return node.element;
  }
  if (!c.isError(info.type)) {
    c.report(
      "type-mismatch/010",
      `\`${name}\` needs an array as its first argument, but the value has type ${
        c.table.show(info.type)
      }`,
      arg.node,
    );
  }
  return c.table.error;
}

function pureFunction(
  c: CollectionContext,
  parameters: readonly TypeRef[],
  result: TypeRef,
): TypeRef {
  return c.table.function({
    execution: "pure",
    parameters,
    result,
    failures: [],
    requirements: [],
  });
}
