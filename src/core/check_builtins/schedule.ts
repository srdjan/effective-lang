// Schedule construction, mapping and composition. These handlers run after
// the body checker's prelude prologue has checked arity and recorded facts.

import { flattenMembers } from "../patterns.ts";
import type { NodeId } from "../syntax.ts";
import { combine, type NodeInfo } from "../tables.ts";
import type { TypeRef } from "../types.ts";
import type { Arg, BuiltinContext } from "./context.ts";
import { direct, type PreludeCallName, type Rows } from "./rows.ts";

export function simpleScheduleCall(
  c: BuiltinContext,
  node: NodeId,
  args: readonly Arg[],
  name: "scheduleRecurs" | "scheduleSpaced",
): NodeInfo {
  const value = c.argInfo(args[0]);
  c.fits(
    args[0].node,
    value.type,
    name === "scheduleRecurs" ? c.table.int : c.table.number,
    "the schedule argument",
  );
  return c.finish(
    node,
    c.table.schedule(c.table.int, c.table.unknown, [], []),
    combine([value]),
  );
}

export function scheduleFromStepCall(
  c: BuiltinContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  c.inlineStreamCallback("scheduleFromStep", args[0]);
  c.inlineStreamCallback("scheduleFromStep", args[1]);
  const initial = c.argInfo(args[0]);
  const decide = c.argInfo(args[1]);
  const factory = c.functionOf(initial.type);
  const step = c.functionOf(decide.type);
  if (
    factory === undefined || factory.parameters.length !== 0 ||
    step === undefined || step.parameters.length !== 2
  ) {
    c.report(
      "type-mismatch/010",
      "`scheduleFromStep` needs a nullary state factory and a two-parameter decision callback",
      node,
    );
    return c.finish(node, c.table.error, combine([initial, decide]));
  }
  const state = factory.result;
  c.fits(args[1].node, state, step.parameters[0], "the schedule state");
  const metadata = c.table.node(c.table.unfold(step.parameters[1]));
  const input = metadata.kind === "record"
    ? metadata.fields.find((field) => field.name === "input")?.type
    : undefined;
  if (
    input === undefined ||
    !c.table.isAssignable(
      c.table.scheduleInput(input),
      step.parameters[1],
    )
  ) {
    c.report(
      "type-mismatch/010",
      "the decision callback needs ScheduleInput<Input>",
      args[1].node,
    );
  }
  const outputs: TypeRef[] = [];
  for (const member of flattenMembers(c.table, step.result)) {
    const variant = c.table.node(c.table.unfold(member));
    if (variant.kind !== "record") continue;
    const output = variant.fields.find((field) => field.name === "output");
    if (output !== undefined) outputs.push(output.type);
  }
  // The output comes from the decision callback only. An annotation then
  // checks through Schedule covariance, as the validator does.
  const output = outputs.length > 0 ? c.table.union(outputs) : c.table.error;
  if (
    outputs.length === 0 ||
    !c.table.isAssignable(
      step.result,
      c.table.scheduleDecision(state, output),
    )
  ) {
    c.report(
      "type-mismatch/010",
      "the decision callback must return ScheduleDecision<State, Output>",
      args[1].node,
    );
  }
  return c.finish(
    node,
    c.table.schedule(output, input ?? c.table.error, [
      ...factory.failures,
      ...step.failures,
    ], [...factory.requirements, ...step.requirements]),
    combine([initial, decide]),
  );
}

export function scheduleMapCall(
  c: BuiltinContext,
  node: NodeId,
  args: readonly Arg[],
  expected: TypeRef | undefined,
): NodeInfo {
  c.inlineStreamCallback("scheduleMap", args[1]);
  const schedule = c.argInfo(args[0]);
  const policy = c.table.node(c.table.unfold(schedule.type));
  if (policy.kind !== "schedule") {
    c.report(
      "type-mismatch/010",
      "`scheduleMap` needs a Schedule",
      args[0].node,
    );
    return c.finish(
      node,
      c.table.error,
      combine([schedule, c.argInfo(args[1])]),
    );
  }
  const hint = expected === undefined
    ? undefined
    : c.table.node(c.table.unfold(expected));
  const mapped = c.callback(
    "scheduleMap",
    args[1],
    [c.table.scheduleMetadata(policy.output, policy.input)],
    hint?.kind === "schedule" ? hint.output : undefined,
    true,
  );
  const fn = c.functionOf(mapped.info.type);
  return c.finish(
    node,
    c.table.schedule(mapped.result, policy.input, [
      ...policy.failures,
      ...(fn?.failures ?? []),
    ], [...policy.requirements, ...(fn?.requirements ?? [])]),
    combine([schedule, mapped.info]),
  );
}

export function scheduleComposeCall(
  c: BuiltinContext,
  node: NodeId,
  args: readonly Arg[],
  name: "scheduleMax" | "scheduleMin" | "scheduleConcat",
): NodeInfo {
  const left = c.argInfo(args[0]);
  const right = c.argInfo(args[1]);
  const first = c.table.node(c.table.unfold(left.type));
  const second = c.table.node(c.table.unfold(right.type));
  if (first.kind !== "schedule" || second.kind !== "schedule") {
    c.report(
      "type-mismatch/010",
      `\`${name}\` needs two Schedule values`,
      node,
    );
    return c.finish(node, c.table.error, combine([left, right]));
  }
  const accepts = (input: TypeRef, offered: TypeRef): boolean =>
    c.table.unfold(input) === c.table.unknown ||
    c.table.isAssignable(offered, input);
  const input = accepts(second.input, first.input)
    ? first.input
    : accepts(first.input, second.input)
    ? second.input
    : undefined;
  if (input === undefined) {
    c.report(
      "type-mismatch/010",
      `\`${name}\` needs comparable Schedule input types`,
      node,
    );
    return c.finish(node, c.table.error, combine([left, right]));
  }
  const output = name === "scheduleConcat"
    ? c.table.union([first.output, second.output])
    : c.table.number;
  return c.finish(
    node,
    c.table.schedule(output, input, [
      ...first.failures,
      ...second.failures,
    ], [...first.requirements, ...second.requirements]),
    combine([left, right]),
  );
}

/** The rows of the Schedule builtins. */
export const SCHEDULE_ROWS = {
  scheduleFromStep: {
    prologue: direct(2, "pure", { fact: { kind: "schedule-from-step" } }),
    handle: (c, node, _name, args) => scheduleFromStepCall(c, node, args),
  },
  scheduleRecurs: {
    prologue: direct(1, "pure", { fact: { kind: "schedule-recurs" } }),
    handle: (c, node, name, args) => simpleScheduleCall(c, node, args, name),
  },
  scheduleSpaced: {
    prologue: direct(1, "pure", { fact: { kind: "schedule-spaced" } }),
    handle: (c, node, name, args) => simpleScheduleCall(c, node, args, name),
  },
  scheduleMap: {
    prologue: direct(2, "pure", { fact: { kind: "schedule-map" } }),
    handle: (c, node, _name, args, expected) =>
      scheduleMapCall(c, node, args, expected),
  },
  scheduleMax: {
    prologue: direct(2, "pure", { fact: { kind: "schedule-max" } }),
    handle: (c, node, name, args) => scheduleComposeCall(c, node, args, name),
  },
  scheduleMin: {
    prologue: direct(2, "pure", { fact: { kind: "schedule-min" } }),
    handle: (c, node, name, args) => scheduleComposeCall(c, node, args, name),
  },
  scheduleConcat: {
    prologue: direct(2, "pure", { fact: { kind: "schedule-concat" } }),
    handle: (c, node, name, args) => scheduleComposeCall(c, node, args, name),
  },
} satisfies Partial<Rows<PreludeCallName, BuiltinContext>>;
