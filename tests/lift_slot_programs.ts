// Source programs for the tests of the slot type of a pure function value that
// an effect-mode expression gives to an effect function slot (decision D6).
// `Gate.pick` is the effect of each block, so a test counts how often it runs.

const HEAD = `type Int = int
error Stop = {}
service Gate { pick(): Int fails Stop }
const pure = (n: Int): Int => n + 1
const other = (n: Int): Int => n + 2
`;

/** Form 1: a branch of an `if` whose block result is a pure function. */
export const BRANCH_PROGRAM = HEAD +
  `export const choose = (): ((n: Int) => Int fails Stop) fails Stop uses Gate.pick =>
  if (Gate.pick() > 0) { Gate.pick(); pure } else { other }
`;

/** Form 2: an arm of a `match` whose block result is a pure function. */
export const ARM_PROGRAM = HEAD +
  `export const choose = (): ((n: Int) => Int fails Stop) fails Stop uses Gate.pick =>
  match (Gate.pick()) { 0 => { Gate.pick(); pure }, _ => other }
`;

/**
 * Form 3: the body of an effect function whose declared result is a function
 * type. `chosen` and `viaConstant` read the result of `mk` in an effect
 * function slot.
 */
export const RESULT_PROGRAM = HEAD +
  `const mk = (): ((n: Int) => Int) fails Stop uses Gate.pick => { Gate.pick(); pure }
export const chosen = (): ((n: Int) => Int fails Stop) fails Stop uses Gate.pick => mk()
export const viaConstant = (): ((n: Int) => Int fails Stop) fails Stop uses Gate.pick => {
  const f = mk()
  f
}
export const declared = (): ((n: Int) => Int) fails Stop uses Gate.pick => { Gate.pick(); pure }
`;

/**
 * An effect function without a declared result. Its inferred result is a pure
 * function, and the callers read it in an effect function slot.
 */
export const INFERRED_PROGRAM = HEAD +
  `const mk = () => { Gate.pick(); pure }
export const chosen = (): ((n: Int) => Int fails Stop) fails Stop uses Gate.pick => mk()
export const viaConstant = (): ((n: Int) => Int fails Stop) fails Stop uses Gate.pick => {
  const f = mk()
  f
}
`;

export const LIFT_PROGRAMS: Readonly<Record<string, string>> = {
  branch: BRANCH_PROGRAM,
  arm: ARM_PROGRAM,
  result: RESULT_PROGRAM,
  inferred: INFERRED_PROGRAM,
};
