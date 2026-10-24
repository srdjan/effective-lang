import { fieldHelperDeclarations } from "./fields.ts";
// The Effect-TS emitter (plan section 6, part A6a). `emitModule` turns one
// `ModuleIR` into the text of one TypeScript module. It reads only the IR and
// the project configuration. It is synchronous and pure: the caller writes files.

import type { Declaration, ModuleIR, Result, TypeDecl } from "../ir.ts";
import type { ProjectConfig } from "../project.ts";
import type { Span } from "../ir.ts";
import {
  bracketed,
  type Doc,
  hard,
  render,
  spanned,
  type SpanRecord,
} from "./doc.ts";
import {
  DeclarationEmitter,
  exportedIds,
  orderConstants,
  orderTypeLevel,
  recursiveGroups,
} from "./decls.ts";
import { EmitFailure, type ImportGroup, Scope } from "./scope.ts";
import { scopeRuntimeDeclaration } from "./explicit_scope.ts";

export interface EmitContext {
  /** The project configuration, for the paths of host modules. */
  readonly config: ProjectConfig;
}

/**
 * The generated range of one host assertion constant: the whole statement
 * `const UsersLive$host: Layer.Layer<Users> = UsersLive;`. A `deno check` error
 * on this range is a host-boundary error.
 */
export interface HostAssertionRecord {
  /** The name of the assertion constant: `UsersLive$host`. */
  readonly name: string;
  /** The name that the Effektive source binds in its import: `UsersLive`. */
  readonly local: string;
  /** The name that the host module exports. */
  readonly exported: string;
  /** The registry key: `providers` for `host:providers`. */
  readonly key: string;
  /** Offsets in UTF-16 code units of the generated text. The end is exclusive. */
  readonly start: number;
  readonly end: number;
}

export interface EmittedModule {
  readonly module: string;
  /** The generated file, relative to the project root: `users.ts` for `users.eff`. */
  readonly path: string;
  readonly text: string;
  /** Generated ranges of the printed declarations and expressions. `buildSpanTable` turns them into the span table. */
  readonly spans: readonly SpanRecord[];
  /** Generated ranges of the host assertion constants, in the order of the output. */
  readonly hostAssertions: readonly HostAssertionRecord[];
}

export type EmitError =
  | {
    readonly tag: "unsupported";
    readonly module: string;
    readonly message: string;
    readonly span?: Span;
  }
  | {
    readonly tag: "internal";
    readonly module: string;
    readonly message: string;
  };

function importLine(group: ImportGroup): Doc {
  const names = group.names.map((n) => {
    const base = n.exported === n.local
      ? n.exported
      : `${n.exported} as ${n.local}`;
    return n.typeOnly ? `type ${base}` : base;
  });
  return [
    "import ",
    bracketed("{", "}", names, true),
    ` from ${JSON.stringify(group.specifier)};`,
  ];
}

function blankSeparated(sections: readonly (readonly Doc[])[]): Doc {
  const nonEmpty = sections.filter((s) => s.length > 0);
  const out: Doc[] = [];
  nonEmpty.forEach((section, i) => {
    if (i > 0) out.push(hard, hard);
    section.forEach((item, j) => {
      if (j > 0) out.push(hard);
      out.push(item);
    });
  });
  return out;
}

/**
 * A `nominal` type with an untagged, non-opaque body has its identity in the
 * checker only. The emitter reads it as an alias of its base.
 */
function erased<D extends Declaration | TypeDecl>(d: D): D {
  return d.kind === "type" && d.definition.kind === "nominal" &&
      d.definition.tagged !== true && d.opaque !== true
    ? { ...d, definition: { kind: "alias", type: d.definition.base } }
    : d;
}

function normalized(ir: ModuleIR): ModuleIR {
  return {
    ...ir,
    imports: ir.imports.map((i) => ({ ...i, types: i.types.map(erased) })),
    declarations: ir.declarations.map(erased),
  };
}

function build(source: ModuleIR, context: EmitContext): EmittedModule {
  const ir = normalized(source);
  const scope = new Scope(ir, context.config);
  const exported = exportedIds(ir);
  const emitter = new DeclarationEmitter(
    scope,
    exported,
    recursiveGroups(ir),
  );

  // An opaque type has no value: the host module declares it.
  const typeLevel = orderTypeLevel(ir).filter((d) =>
    !(d.kind === "type" && d.opaque === true)
  );
  const functions = ir.declarations.filter((d) => d.kind === "function");
  const constants = orderConstants(ir);
  const printed = (declarations: readonly (typeof ir.declarations)[number][]) =>
    declarations.map((d) => spanned(d.span, emitter.declaration(d)));
  // Declarations first: they decide which imports and helpers the module needs.
  const typeDocs = printed(typeLevel);
  const functionDocs = printed(functions);
  const constantDocs = printed(constants);

  // The host assertions come first: their check schemas register `$Int` and `$hostCheck`.
  const hostAssertions = emitter.hostAssertions();
  const helpers: Doc[][] = [];
  if (scope.usesIntSchema()) helpers.push([emitter.intSchemaDeclaration()]);
  if (scope.usesIntFunction()) helpers.push([emitter.intFunctionDeclaration()]);
  if (scope.usesUnmatched()) helpers.push([emitter.unmatchedDeclaration()]);
  if (scope.usesHostCheck()) helpers.push([emitter.hostCheckDeclaration()]);
  if (scope.usesScopeRuntime()) helpers.push([scopeRuntimeDeclaration(scope)]);

  helpers.push(fieldHelperDeclarations(scope));

  const effectNames = scope.effectImports().map((n) =>
    n.exported === n.local ? n.exported : `${n.exported} as ${n.local}`
  );
  const imports: Doc[] = [];
  if (effectNames.length > 0) {
    imports.push([
      "import ",
      bracketed("{", "}", effectNames, true),
      ' from "effect";',
    ]);
  }
  for (const group of scope.moduleImports()) imports.push(importLine(group));
  for (const group of scope.hostImports()) imports.push(importLine(group));

  const header: Doc =
    `// Generated from ${scope.source} by the Effektive compiler. Do not edit.`;
  const declarationDocs = [...typeDocs, ...functionDocs, ...constantDocs];
  // A companion module without a declaration would not be a module without this line.
  const moduleMarker: Doc[] =
    scope.source.endsWith(".effi") && declarationDocs.length === 0 &&
      imports.length === 0
      ? ["export {};"]
      : [];
  const doc = blankSeparated([
    [header],
    imports,
    ...helpers,
    hostAssertions,
    ...declarationDocs.map((d) => [d]),
    moduleMarker,
  ]);
  const mapName = `${scope.path.slice(scope.path.lastIndexOf("/") + 1)}.map`;
  const rendered = render([doc, hard, `//# sourceMappingURL=${mapName}`, hard]);
  const assertions: HostAssertionRecord[] = [];
  for (const mark of rendered.marks) {
    for (const host of scope.hosts.values()) {
      if (host.hostName !== mark.key) continue;
      assertions.push({
        name: host.hostName,
        local: host.local,
        exported: host.exported,
        key: host.key,
        start: mark.start,
        end: mark.end,
      });
    }
  }
  assertions.sort((a, b) => a.start - b.start);
  return {
    module: ir.module,
    path: scope.path,
    text: rendered.text,
    spans: rendered.spans,
    hostAssertions: assertions,
  };
}

/** Emits the TypeScript module for one module of the IR. */
export function emitModule(
  ir: ModuleIR,
  context: EmitContext,
): Result<EmittedModule, EmitError> {
  try {
    return { ok: true, value: build(ir, context) };
  } catch (e) {
    if (e instanceof EmitFailure) {
      const failure = e.failure;
      return {
        ok: false,
        error: failure.tag === "unsupported"
          ? failure.span === undefined
            ? {
              tag: "unsupported",
              module: ir.module,
              message: failure.message,
            }
            : {
              tag: "unsupported",
              module: ir.module,
              message: failure.message,
              span: failure.span,
            }
          : { tag: "internal", module: ir.module, message: failure.message },
      };
    }
    throw e;
  }
}
