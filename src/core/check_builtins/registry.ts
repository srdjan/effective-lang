// The family rows of the prelude builtins. A new builtin in an existing family
// adds its row to that family file, so the body checker does not change. The
// body checker adds the rows of the builtins that call its private members.

import type { BuiltinContext } from "./context.ts";
import { CODEC_ROWS } from "./codec.ts";
import { COLLECTION_ROWS, type CollectionContext } from "./collections.ts";
import { EFFECT_ROWS, type EffectContext } from "./effect.ts";
import { FIBER_ROWS, type FiberContext } from "./fiber.ts";
import { LAYER_ROWS, type LayerContext } from "./layer.ts";
import { REF_ROWS } from "./ref.ts";
import type { PreludeCallName, Rows } from "./rows.ts";
import { SCHEDULE_ROWS } from "./schedule.ts";
import { SCHEMA_ROWS, type SchemaContext } from "./schema.ts";
import { SCOPE_ROWS, type ScopeContext } from "./scope.ts";
import { STREAM_ROWS, type StreamContext } from "./stream.ts";

/** The builtins whose rows stay in the body checker, because they call its private members. */
export type CoreRowName = "unbrand" | "Some";

/** The names of the rows in `BodyChecker`. The type above and this list must agree. */
export const CORE_ROW_NAMES: readonly CoreRowName[] = ["unbrand", "Some"];

/** Every operation that a family handler or prologue reads from the checker. */
export type FamilyContext =
  & BuiltinContext
  & CollectionContext
  & EffectContext
  & LayerContext
  & FiberContext
  & ScopeContext
  & StreamContext
  & SchemaContext;

/** The family row tables by family name, for the test of the key sets. */
export const FAMILY_ROW_TABLES = {
  codec: CODEC_ROWS,
  collections: COLLECTION_ROWS,
  effect: EFFECT_ROWS,
  fiber: FIBER_ROWS,
  layer: LAYER_ROWS,
  ref: REF_ROWS,
  schedule: SCHEDULE_ROWS,
  schema: SCHEMA_ROWS,
  scope: SCOPE_ROWS,
  stream: STREAM_ROWS,
} as const;

// A type annotation keeps the generic index of `preludeCall` valid. A
// `satisfies` clause on this table breaks it.
export const FAMILY_ROWS: Rows<
  Exclude<PreludeCallName, CoreRowName>,
  FamilyContext
> = {
  ...CODEC_ROWS,
  ...COLLECTION_ROWS,
  ...EFFECT_ROWS,
  ...FIBER_ROWS,
  ...LAYER_ROWS,
  ...REF_ROWS,
  ...SCHEDULE_ROWS,
  ...SCHEMA_ROWS,
  ...SCOPE_ROWS,
  ...STREAM_ROWS,
};
