// Shared structural representation across emitted modules. Source cannot inspect
// these fields; aliases carry the same object and completion cell across roots.
import { type Doc, hard, join } from "./doc.ts";
import type { Scope } from "./scope.ts";

export function scopeRuntimeDeclaration(scope: Scope): Doc {
  const names = scope.scopeRuntime();
  const effect = scope.effect("Effect");
  const raw = scope.effect("Scope");
  const deferred = scope.effect("Deferred");
  const exit = scope.effect("Exit");
  return join(hard, [
    `type ${names.type} = {`,
    `  readonly scope: ${raw}.Closeable;`,
    `  readonly done: ${deferred}.Deferred<void>;`,
    "  started: boolean;",
    "};",
    `function ${names.make}(): ${effect}.Effect<${names.type}> {`,
    `  return ${effect}.gen(function* () {`,
    `    const scope = yield* ${raw}.make();`,
    `    const done = yield* ${deferred}.make<void>();`,
    "    return { scope, done, started: false };",
    "  });",
    "}",
    `function ${names.provide}<A, E, R>(`,
    `  owner: ${names.type},`,
    `  job: ${effect}.Effect<A, E, R>,`,
    ") {",
    `  return ${raw}.provide(job, owner.scope);`,
    "}",
    `function ${names.register}<R>(`,
    `  owner: ${names.type},`,
    `  job: ${effect}.Effect<void, never, R>,`,
    `): ${effect}.Effect<void, never, R> {`,
    `  return ${effect}.gen(function* () {`,
    `    const context = yield* ${effect}.context<R>();`,
    `    yield* ${raw}.addFinalizer(owner.scope, ${effect}.provideContext(job, context));`,
    "  });",
    "}",
    `function ${names.close}(owner: ${names.type}): ${effect}.Effect<void> {`,
    `  return ${effect}.uninterruptible(${effect}.suspend(() => {`,
    `    if (owner.started) return ${deferred}.await(owner.done);`,
    "    owner.started = true;",
    `    return ${effect}.exit(${raw}.close(owner.scope, ${exit}.void)).pipe(`,
    `      ${effect}.flatMap((outcome) => ${deferred}.done(owner.done, outcome)),`,
    `      ${effect}.andThen(${deferred}.await(owner.done)),`,
    "    );",
    "  }));",
    "}",
  ]);
}
