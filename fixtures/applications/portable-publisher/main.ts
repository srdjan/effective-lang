import { Effect, Option } from "effect";
import { Key, Payload } from "./platform.ts";
import { publishArticle } from "./publisher.ts";
import { makeRunner } from "./runner.ts";

const runner = makeRunner();
const key = Key.make("articles/welcome");
await Effect.runPromise(runner.memory.control.set(
  key,
  Payload.make(JSON.stringify({
    kind: "draft",
    id: "welcome",
    revision: 0,
    title: "Portable publishing",
    body: "One source workflow",
  })),
  Option.none(),
));
const receipt = await runner.run(publishArticle("welcome"));
const stored = await Effect.runPromise(runner.memory.control.get(key));
const committed = Option.match(stored, {
  onNone: () => [],
  onSome: (entry) => [JSON.parse(entry.payload) as unknown],
});
console.log(
  JSON.stringify({ receipt, committed, active: runner.memory.active() }),
);
