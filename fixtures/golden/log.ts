// Generated from log.eff by the Effective compiler. Do not edit.

import { Context, Effect, Schema } from "effect";

export const Message = Schema.String;
export type Message = typeof Message.Type;

export class ConsoleUnavailable
  extends Schema.TaggedError<ConsoleUnavailable>()(
    "log#ConsoleUnavailable",
    { message: Schema.String },
  ) {}

export class Console extends Context.Service<Console, {
  readonly print: (a: Message) => Effect.Effect<void, ConsoleUnavailable>;
}>()("log#Console") {}

export const log = (message: Message): Effect.Effect<
  void,
  ConsoleUnavailable,
  Console
> => Console.use(($s) => $s.print(message));
//# sourceMappingURL=log.ts.map
