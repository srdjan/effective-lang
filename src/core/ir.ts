// Copied from /Users/srdjans/Code/effektive/public/typed-ir.ts (Phase A, part A1). Otherwise unchanged.
/** Proposed IR for the syntax port. */
export type TypeId = `type:${string}`;
export type ErrorId = `error:${string}`;
export type ServiceId = `service:${string}`;
export type CapabilityId = `cap:${string}`;
/** A reserved Effect runtime requirement, discharged by `scoped` or `provideScope`. */
export const SCOPE_CAPABILITY: CapabilityId = "cap:effect/Scope";
/** The target Schema parser failure; source code may handle but not construct it. */
export const SCHEMA_ERROR_ID: ErrorId = "error:effect/SchemaError";
export const SCHEMA_ISSUE_ID: ErrorId = "error:effect/SchemaIssue";
export type ValueId = `value:${string}`;
export type LocalId = `local:${string}`;
export type Execution = "pure" | "effect";

/** Offsets count UTF-16 code units. The end offset is exclusive. */
export interface Span {
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

/** These sets are closed. Serialization sorts IDs and removes duplicates. */
export interface Effects {
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
}

export interface Field {
  readonly name: string;
  readonly type: Type;
  readonly optional: boolean;
}

/** Function effects describe invocation. Constructing a closure remains pure. */
export interface FunctionType {
  readonly kind: "function";
  readonly execution: Execution;
  readonly parameters: readonly Type[];
  readonly borrows?: readonly boolean[];
  readonly result: Type;
  readonly effects: Effects;
}

export type Type =
  | { readonly kind: "primitive"; readonly name: "string" | "boolean" | "int" | "number" | "unit" | "never" | "unknown" }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "named"; readonly id: TypeId | ErrorId }
  | { readonly kind: "record"; readonly fields: readonly Field[] }
  | { readonly kind: "array"; readonly element: Type }
  | { readonly kind: "tuple"; readonly elements: readonly Type[] }
  | { readonly kind: "union"; readonly members: readonly Type[] }
  | { readonly kind: "option"; readonly element: Type }
  | { readonly kind: "ref"; readonly element: Type }
  | { readonly kind: "closeable-scope" }
  | { readonly kind: "retry-schedule"; readonly error: Type }
  | { readonly kind: "codec"; readonly decoded: Type; readonly encoded: Type }
  // Constructor defaults may coexist with one field-presence flag.
  | { readonly kind: "schema"; readonly decoded: Type; readonly encoded: Type; readonly decodeRequirements: readonly CapabilityId[]; readonly encodeRequirements: readonly CapabilityId[]; readonly optionalKey?: true; readonly encodedOptionalKey?: true; readonly decodedOptionalKey?: true; readonly makeInput?: Type; readonly constructorDefault?: true }
  | { readonly kind: "fiber"; readonly result: Type; readonly failures: readonly ErrorId[] }
  | { readonly kind: "effect"; readonly result: Type; readonly effects: Effects }
  | { readonly kind: "stream"; readonly element: Type; readonly effects: Effects }
  | { readonly kind: "schedule"; readonly output: Type; readonly input: Type; readonly effects: Effects }
  | { readonly kind: "sink"; readonly input: Type; readonly result: Type; readonly leftover?: Type; readonly effects: Effects }
  | FunctionType
  | {
      readonly kind: "provider";
      readonly provides: readonly CapabilityId[];
      readonly acquisition: {
        readonly execution: Execution;
        readonly effects: Effects;
      };
    };

export interface Parameter {
  readonly id: LocalId;
  readonly name: string;
  readonly type: Type;
  readonly borrow?: boolean;
  readonly span: Span;
}

export interface Annotation {
  readonly type: Type;
  /** Execution mode remains independent of unhandled failures and requirements. */
  readonly execution: Execution;
  /** Active effects for this evaluation, including effects of evaluated children. */
  readonly effects: Effects;
  readonly span: Span;
}

type Node<T> = Readonly<T> & Annotation;

export type Pattern =
  | { readonly kind: "wildcard"; readonly span: Span }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null; readonly span: Span }
  | { readonly kind: "none"; readonly span: Span }
  | { readonly kind: "some"; readonly binding: Parameter; readonly span: Span }
  | { readonly kind: "error"; readonly error: ErrorId; readonly binding: Parameter; readonly span: Span }
  | { readonly kind: "nominal"; readonly nominal: TypeId; readonly binding: Parameter; readonly span: Span }
  | { readonly kind: "tag"; readonly field: string; readonly value: string; readonly binding: Parameter | null; readonly span: Span };

export interface Arm {
  readonly pattern: Pattern;
  readonly body: Expr;
}

export interface Handler {
  readonly error: ErrorId;
  readonly binding: Parameter;
  readonly body: Expr;
  readonly span: Span;
}

export type Step =
  | { readonly kind: "bind"; readonly binding: Parameter; readonly value: Expr }
  | { readonly kind: "evaluate"; readonly value: Expr };

export type ClosureExpr = Node<{ kind: "closure"; parameters: readonly Parameter[]; body: Expr }>;

/** Calls and capability operations remain distinct after resolution. */
export type Expr =
  // A null value in the original literal node represents unit, emitted as undefined.
  | Node<{ kind: "literal"; value: string | number | boolean | null }>
  // Source null data is distinct from the existing unit marker.
  | Node<{ kind: "null" }>
  | Node<{ kind: "reference"; target: LocalId | ValueId }>
  | Node<{ kind: "record"; fields: readonly { readonly name: string; readonly value: Expr }[] }>
  | Node<{ kind: "array"; elements: readonly Expr[] }>
  | Node<{ kind: "tuple"; elements: readonly Expr[] }>
  | Node<{ kind: "get"; record: Expr; field: string }>
  | Node<{ kind: "update"; record: Expr; fields: readonly { readonly name: string; readonly value: Expr }[] }>
  | Node<{ kind: "nominal"; nominal: TypeId; value: Expr }>
  | Node<{ kind: "some"; value: Expr }>
  | Node<{ kind: "none" }>
  | Node<{ kind: "error"; error: ErrorId; fields: readonly { readonly name: string; readonly value: Expr }[] }>
  | ClosureExpr
  | Node<{ kind: "call"; callee: Expr; arguments: readonly Expr[] }>
  | Node<{ kind: "defer"; job: Expr }>
  | Node<{ kind: "run"; value: Expr }>
  | Node<{ kind: "scoped"; value: Expr }>
  | Node<{ kind: "fork-scoped"; job: Expr }>
  | Node<{ kind: "make-scope" }>
  | Node<{ kind: "provide-scope"; owner: Expr; job: Expr }>
  | Node<{ kind: "add-scope-finalizer"; owner: Expr; job: Expr }>
  | Node<{ kind: "close-scope"; owner: Expr }>
  | Node<{ kind: "with-resource"; acquire: ClosureExpr; use: ClosureExpr; release: ClosureExpr }>
  | Node<{ kind: "unfold"; seed: Expr; next: Expr }>
  | Node<{ kind: "map-effect"; stream: Expr; transform: Expr; concurrency: number | "unbounded" | undefined }>
  | Node<{ kind: "map-stream"; stream: Expr; transform: Expr }>
  | Node<{ kind: "map-groups"; stream: Expr; key: ClosureExpr; use: ClosureExpr; bufferSize: number }>
  | Node<{ kind: "scan-stream"; stream: Expr; seed: Expr; update: Expr }>
  | Node<{ kind: "map-accum-stream"; stream: Expr; seed: Expr; update: Expr }>
  | Node<{ kind: "fold-stream"; stream: Expr; seed: Expr; update: Expr }>
  | Node<{ kind: "fold-effect-stream"; stream: Expr; seed: Expr; update: Expr }>
  | Node<{ kind: "collect-stream"; stream: Expr }>
  | Node<{ kind: "head-stream"; stream: Expr }>
  | Node<{ kind: "last-stream"; stream: Expr }>
  | Node<{ kind: "drain-stream"; stream: Expr }>
  | Node<{ kind: "flat-map-streams"; stream: Expr; transform: Expr; concurrency: number | "unbounded" | undefined }>
  | Node<{ kind: "switch-map-streams"; stream: Expr; transform: Expr }>
  | Node<{ kind: "catch-stream"; stream: Expr; recover: Expr }>
  | Node<{ kind: "retry-stream"; stream: Expr; policy: Expr }>
  | Node<{ kind: "debounce-stream"; stream: Expr; delayMs: number }>
  | Node<{ kind: "throttle-stream"; stream: Expr; units: number; durationMs: number; strategy: "shape" | "enforce" }>
  | Node<{ kind: "take-stream"; stream: Expr; count: Expr }>
  | Node<{ kind: "drop-stream"; stream: Expr; count: Expr }>
  | Node<{ kind: "drop-while-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "filter-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "filter-effect-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "take-while-effect-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "take-until-effect-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "drop-while-effect-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "take-while-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "take-until-stream"; stream: Expr; predicate: Expr }>
  | Node<{ kind: "partition-all"; jobs: Expr; concurrency: number | "unbounded" | undefined }>
  | Node<{ kind: "validate-all"; jobs: Expr; onErrors: Expr; concurrency: number | "unbounded" | undefined }>
  | Node<{ kind: "all-results"; jobs: Expr; concurrency: number | "unbounded" | undefined }>
  | Node<{ kind: "sink-for-each"; consume: Expr }>
  | Node<{ kind: "take-sink"; count: number }>
  | Node<{ kind: "transduce-stream"; stream: Expr; sink: Expr }>
  | Node<{ kind: "aggregate-stream"; stream: Expr; sink: Expr }>
  | Node<{ kind: "aggregate-within-stream"; stream: Expr; sink: Expr; schedule: Expr }>
  | Node<{ kind: "schedule-from-step"; initial: Expr; decide: Expr }>
  | Node<{ kind: "schedule-recurs"; times: Expr }>
  | Node<{ kind: "schedule-spaced"; delayMillis: Expr }>
  | Node<{ kind: "schedule-map"; schedule: Expr; transform: Expr }>
  | Node<{ kind: "schedule-max"; left: Expr; right: Expr }>
  | Node<{ kind: "schedule-min"; left: Expr; right: Expr }>
  | Node<{ kind: "schedule-concat"; left: Expr; right: Expr }>
  | Node<{ kind: "run-stream"; stream: Expr; sink: Expr }>
  | Node<{ kind: "buffer-stream"; stream: Expr; capacity: number }>
  | Node<{ kind: "merge-streams"; left: Expr; right: Expr }>
  | Node<{ kind: "zip-streams"; left: Expr; right: Expr }>
  | Node<{ kind: "concat-streams"; left: Expr; right: Expr }>
  | Node<{ kind: "race"; left: Expr; right: Expr }>
  | Node<{ kind: "make-ref"; value: Expr }>
  | Node<{ kind: "get-ref"; ref: Expr }>
  | Node<{ kind: "set-ref"; ref: Expr; value: Expr }>
  | Node<{ kind: "update-ref"; ref: Expr; transform: Expr }>
  | Node<{ kind: "layer"; service: ServiceId; acquire: Expr }>
  | Node<{ kind: "merge-layers"; left: Expr; right: Expr }>
  | Node<{ kind: "retry-schedule"; step: Expr }>
  | Node<{ kind: "retry-with-schedule"; job: Expr; options: Expr }>
  | Node<{ kind: "codec"; decode: Expr; encode: Expr }>
  | Node<{ kind: "schema"; op: "identity" | "array" | "struct" | "optional-key" | "null-to-missing-key" | "option-from-optional-key" | "default-key" | "constructor-default" | "default-null-key" | "default-encoded-key" | "optional-transform" | "optional-from-required" | "union" | "transform" | "recursive" | "invalid" | "at" | "both"; arguments: readonly Expr[] }>
  | Node<{ kind: "schema-decode"; schema: Expr; input: Expr }>
  | Node<{ kind: "schema-encode"; schema: Expr; input: Expr }>
  | Node<{ kind: "schema-make"; schema: Expr; input: Expr }>
  | Node<{ kind: "decode"; codec: Expr; input: Expr }>
  | Node<{ kind: "encode"; codec: Expr; input: Expr }>
  | Node<{ kind: "with-fiber"; job: Expr; use: ClosureExpr }>
  | Node<{ kind: "join-fiber"; fiber: Expr }>
  | Node<{ kind: "interrupt-fiber"; fiber: Expr }>
  | Node<{ kind: "perform"; capability: CapabilityId; arguments: readonly Expr[] }>
  | Node<{ kind: "block"; steps: readonly Step[]; result: Expr }>
  | Node<{ kind: "if"; condition: Expr; then: Expr; else: Expr }>
  | Node<{ kind: "match"; subject: Expr; arms: readonly Arm[] }>
  | Node<{ kind: "fail"; error: Expr }>
  | Node<{ kind: "catch"; body: Expr; handlers: readonly Handler[] }>
  | Node<{ kind: "retry"; job: Expr; times: number }>
  | Node<{ kind: "provide"; provider: Expr; job: Expr }>
  | Node<{
      kind: "binary";
      operator: "+" | "-" | "*" | "/" | "===" | "!==" | "<" | "<=" | ">" | ">=" | "&&" | "||";
      left: Expr;
      right: Expr;
    }>;

export interface TypeDecl {
  readonly kind: "type";
  readonly id: TypeId;
  readonly name: string;
  readonly definition:
    | { readonly kind: "alias"; readonly type: Type }
    | {
      readonly kind: "nominal";
      readonly base: Type;
      readonly tagged?: true;
      readonly sealed?: true;
    };
  readonly opaque?: boolean;
  readonly span: Span;
}

export interface ErrorDecl {
  readonly kind: "error";
  readonly id: ErrorId;
  readonly name: string;
  readonly fields: readonly Field[];
  readonly span: Span;
}

export interface MethodDecl {
  readonly id: CapabilityId;
  readonly name: string;
  readonly type: FunctionType;
  readonly borrows?: readonly boolean[];
  readonly span: Span;
}

export interface ServiceDecl {
  readonly kind: "service";
  readonly id: ServiceId;
  readonly name: string;
  readonly methods: readonly MethodDecl[];
  readonly span: Span;
}

/** Which parts of a function contract are closed. A closed set bounds the body from above. An open set equals the body set. */
export interface WrittenParts {
  readonly result: boolean;
  readonly fails: boolean;
  readonly uses: boolean;
}

export interface FunctionDecl {
  readonly kind: "function";
  readonly id: ValueId;
  readonly name: string;
  readonly parameters: readonly Parameter[];
  /** The callable interface. Its effects can exceed the inferred body effects. */
  readonly type: FunctionType;
  readonly written: WrittenParts;
  readonly body: Expr;
  readonly span: Span;
}

export interface ConstantDecl {
  readonly kind: "constant";
  readonly id: ValueId;
  readonly name: string;
  readonly type: Type;
  readonly value: Expr;
  readonly span: Span;
}

export type Declaration = TypeDecl | ErrorDecl | ServiceDecl | FunctionDecl | ConstantDecl;
export type DeclarationId = TypeId | ErrorId | ServiceId | ValueId;

export interface Import {
  readonly module: string;
  /** These bindings select public names. Other declarations supply transitive type information. */
  readonly bindings: readonly { readonly name: string; readonly target: DeclarationId }[];
  readonly exports: readonly DeclarationId[];
  /** A module interface supplies these types before body checking. */
  readonly values: readonly { readonly id: ValueId; readonly name: string; readonly type: Type }[];
  readonly types: readonly TypeDecl[];
  readonly errors: readonly ErrorDecl[];
  readonly services: readonly ServiceDecl[];
}

export interface ModuleIR {
  readonly format: "light-functional-ir";
  readonly version: 5;
  readonly module: string;
  /** A validator also receives immutable source texts keyed by these identifiers. */
  readonly sources: readonly string[];
  readonly imports: readonly Import[];
  readonly declarations: readonly Declaration[];
  readonly exports: readonly DeclarationId[];
}

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly span: Span;
}

/** Expected compiler failures are data. */
export type Result<A, E> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

/** A future compiler can expose this boundary. No compiler is supplied here. */
export type Compile = (source: string, sourceId: string) => Result<ModuleIR, readonly Diagnostic[]>;
