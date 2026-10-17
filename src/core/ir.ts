// Copied from /Users/srdjans/Code/effective/public/typed-ir.ts (Phase A, part A1). Otherwise unchanged.
/** Proposed IR for the syntax port. */
export type TypeId = `type:${string}`;
export type ErrorId = `error:${string}`;
export type ServiceId = `service:${string}`;
export type CapabilityId = `cap:${string}`;
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
  readonly result: Type;
  readonly effects: Effects;
}

export type Type =
  | { readonly kind: "primitive"; readonly name: "string" | "boolean" | "int" | "number" | "unit" | "never" | "unknown" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "named"; readonly id: TypeId | ErrorId }
  | { readonly kind: "record"; readonly fields: readonly Field[] }
  | { readonly kind: "array"; readonly element: Type }
  | { readonly kind: "tuple"; readonly elements: readonly Type[] }
  | { readonly kind: "union"; readonly members: readonly Type[] }
  | { readonly kind: "option"; readonly element: Type }
  | { readonly kind: "effect"; readonly result: Type; readonly effects: Effects }
  | { readonly kind: "stream"; readonly element: Type; readonly effects: Effects }
  | { readonly kind: "sink"; readonly input: Type; readonly result: Type; readonly effects: Effects }
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
  | { readonly kind: "literal"; readonly value: string | number | boolean; readonly span: Span }
  | { readonly kind: "none"; readonly span: Span }
  | { readonly kind: "some"; readonly binding: Parameter; readonly span: Span }
  | { readonly kind: "error"; readonly error: ErrorId; readonly binding: Parameter; readonly span: Span }
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

/** Calls and capability operations remain distinct after resolution. */
export type Expr =
  | Node<{ kind: "literal"; value: string | number | boolean | null }>
  | Node<{ kind: "reference"; target: LocalId | ValueId }>
  | Node<{ kind: "record"; fields: readonly { readonly name: string; readonly value: Expr }[] }>
  | Node<{ kind: "array"; elements: readonly Expr[] }>
  | Node<{ kind: "tuple"; elements: readonly Expr[] }>
  | Node<{ kind: "get"; record: Expr; field: string }>
  | Node<{ kind: "update"; record: Expr; fields: readonly { readonly name: string; readonly value: Expr }[] }>
  | Node<{ kind: "brand"; brand: TypeId; value: Expr }>
  | Node<{ kind: "unbrand"; value: Expr }>
  | Node<{ kind: "some"; value: Expr }>
  | Node<{ kind: "none" }>
  | Node<{ kind: "error"; error: ErrorId; fields: readonly { readonly name: string; readonly value: Expr }[] }>
  | Node<{ kind: "closure"; parameters: readonly Parameter[]; body: Expr }>
  | Node<{ kind: "call"; callee: Expr; arguments: readonly Expr[] }>
  | Node<{ kind: "defer"; job: Expr }>
  | Node<{ kind: "run"; value: Expr }>
  | Node<{ kind: "with-resource"; acquire: Expr; use: Expr; release: Expr; useBinding: LocalId; releaseBinding: LocalId }>
  | Node<{ kind: "unfold"; seed: Expr; next: Expr }>
  | Node<{ kind: "map-effect"; stream: Expr; transform: Expr }>
  | Node<{ kind: "sink-for-each"; consume: Expr }>
  | Node<{ kind: "run-stream"; stream: Expr; sink: Expr }>
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
    | { readonly kind: "brand"; readonly base: Type };
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
  readonly span: Span;
}

export interface ServiceDecl {
  readonly kind: "service";
  readonly id: ServiceId;
  readonly name: string;
  readonly methods: readonly MethodDecl[];
  readonly span: Span;
}

export interface FunctionDecl {
  readonly kind: "function";
  readonly id: ValueId;
  readonly name: string;
  readonly parameters: readonly Parameter[];
  /** The callable interface. Its effects can exceed the inferred body effects. */
  readonly type: FunctionType;
  readonly contract: "explicit" | "inferred";
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
  readonly version: 1;
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
