// Recursive-descent parser. It never throws and never stops at the first error.
// It builds a lossless tree: every token becomes a leaf, and a missing token or
// construct becomes a zero-width Missing node. See docs/archive/plans/2026-10-16-phase-a.md
// section 5.1 for the grammar addendum and design section 6.4 for recovery.
//
// Newline handling. The parser keeps a flag `sig`. In a module, a block, or a
// service body, a newline token separates items and the parser leaves it in
// place. Inside parentheses, brackets, record braces, match arms, and catch
// handlers the flag is off and `kind()` consumes newline tokens on its own.
// Before `fails`, `uses`, `=>`, `|>`, `else`, and `catch` the parser looks past
// newlines (`la()`) and continues the item.
//
// Recovery. At a declaration keyword at the start of a line, a construct whose
// opening bracket has no match ends early (`kind()` reports a virtual Eof), so
// one broken declaration never swallows the next. Inside a list or block the
// parser skips junk up to a newline, a comma, or a closing bracket.

import {
  type Diagnostic,
  type DiagnosticCode,
  makeDiagnostic,
  normalizeDiagnostics,
} from "./diagnostics.ts";
import {
  describeTokenKind,
  isWord,
  lex,
  type Lexed,
  TokenKind,
} from "./lex.ts";
import type { ReadError, Result, SourceHost } from "./source.ts";
import {
  type FileMode,
  type NodeId,
  SyntaxKind,
  type SyntaxTree,
  TYPE_WORDS,
} from "./syntax.ts";

export interface ParseResult {
  readonly tree: SyntaxTree;
  /** Lexer and parser diagnostics, sorted and without duplicates. */
  readonly diagnostics: readonly Diagnostic[];
}

/** `.effi` files are host interface files. Every other path parses as `.eff`. */
export function fileModeOf(path: string): FileMode {
  return path.endsWith(".effi") ? "effi" : "eff";
}

export function parse(
  source: string,
  text: string,
  mode: FileMode = fileModeOf(source),
): ParseResult {
  const lexed = lex(source, text);
  const parser = new Parser(source, text, mode, lexed);
  const tree = parser.run();
  const diagnostics = normalizeDiagnostics([
    ...lexed.diagnostics,
    ...parser.diagnostics,
  ]);
  return { tree, diagnostics };
}

/** Reads a file through the host, then parses it. */
export function parseFromHost(
  host: SourceHost,
  path: string,
): Result<ParseResult, ReadError> {
  const read = host.readText(path);
  if (!read.ok) return read;
  return { ok: true, value: parse(path, read.value) };
}

type Group = { readonly sig: boolean; readonly unmatched: number };

/** Deepest nesting of expressions and types that the parser accepts. A parenthesis counts twice. */
const MAX_NESTING = 512;

const DECL_WORDS: ReadonlySet<string> = new Set([
  "type",
  "opaque",
  "error",
  "service",
  "provider",
]);

function isKeywordKind(k: TokenKind): boolean {
  return k >= TokenKind.KwImport && k <= TokenKind.KwNull;
}

function binaryPrecedence(k: TokenKind): number {
  switch (k) {
    case TokenKind.PipePipe:
      return 1;
    case TokenKind.AmpAmp:
      return 2;
    case TokenKind.EqEqEq:
    case TokenKind.BangEqEq:
      return 3;
    case TokenKind.Lt:
    case TokenKind.LtEq:
    case TokenKind.Gt:
    case TokenKind.GtEq:
      return 4;
    case TokenKind.Plus:
    case TokenKind.Minus:
      return 5;
    case TokenKind.Star:
    case TokenKind.Slash:
      return 6;
    default:
      return 0;
  }
}

/** For each opening bracket, the index of its closing token, or -1. */
function matchBrackets(kinds: Uint8Array, count: number): Int32Array {
  const match = new Int32Array(count).fill(-1);
  const parens: number[] = [];
  const braces: number[] = [];
  const brackets: number[] = [];
  for (let i = 0; i < count; i++) {
    switch (kinds[i]) {
      case TokenKind.LParen:
        parens.push(i);
        break;
      case TokenKind.LBrace:
        braces.push(i);
        break;
      case TokenKind.LBracket:
        brackets.push(i);
        break;
      case TokenKind.RParen: {
        const open = parens.pop();
        if (open !== undefined) match[open] = i;
        break;
      }
      case TokenKind.RBrace: {
        const open = braces.pop();
        if (open !== undefined) match[open] = i;
        break;
      }
      case TokenKind.RBracket: {
        const open = brackets.pop();
        if (open !== undefined) match[open] = i;
        break;
      }
    }
  }
  return match;
}

class Parser {
  readonly diagnostics: Diagnostic[] = [];

  private readonly kinds: Uint8Array;
  private readonly starts: Uint32Array;
  private readonly ends: Uint32Array;
  private readonly count: number;
  private readonly match: Int32Array;

  private pos = 0;
  private sig = true;
  private unmatched = 0;
  private depth = 0;
  private lastErrorPos = -1;
  private lastErrorStart = -1;
  private lastErrorEnd = -1;

  // Node storage.
  private readonly nodeKinds: number[] = [];
  private readonly nodeStarts: number[] = [];
  private readonly nodeEnds: number[] = [];
  private readonly nodeParents: number[] = [];
  private readonly nodeTokens: number[] = [];
  private readonly nodeChildStart: number[] = [];
  private readonly nodeChildEnd: number[] = [];
  private readonly flat: number[] = [];
  private readonly stack: NodeId[][] = [];

  constructor(
    private readonly source: string,
    private readonly text: string,
    private readonly mode: FileMode,
    private readonly lexed: Lexed,
  ) {
    this.kinds = lexed.kinds;
    this.starts = lexed.starts;
    this.ends = lexed.ends;
    this.count = lexed.count;
    this.match = matchBrackets(lexed.kinds, lexed.count);
  }

  run(): SyntaxTree {
    const root = this.parseModule();
    this.nodeStarts[root] = 0;
    this.nodeEnds[root] = this.text.length;
    return {
      source: this.source,
      text: this.text,
      mode: this.mode,
      lexed: this.lexed,
      root,
      count: this.nodeKinds.length,
      kinds: Uint8Array.from(this.nodeKinds),
      starts: Uint32Array.from(this.nodeStarts),
      ends: Uint32Array.from(this.nodeEnds),
      parents: Int32Array.from(this.nodeParents),
      tokens: Int32Array.from(this.nodeTokens),
      childStart: Uint32Array.from(this.nodeChildStart),
      childEnd: Uint32Array.from(this.nodeChildEnd),
      children: Uint32Array.from(this.flat),
    };
  }

  // ---------------------------------------------------------------- tree building

  private top(): NodeId[] {
    return this.stack[this.stack.length - 1];
  }

  private newNode(
    kind: SyntaxKind,
    start: number,
    end: number,
    token: number,
  ): NodeId {
    const id = this.nodeKinds.length;
    this.nodeKinds.push(kind);
    this.nodeStarts.push(start);
    this.nodeEnds.push(end);
    this.nodeParents.push(-1);
    this.nodeTokens.push(token);
    this.nodeChildStart.push(0);
    this.nodeChildEnd.push(0);
    return id;
  }

  private begin(): void {
    this.stack.push([]);
  }

  /** Finishes the open node and adds it to the node below it on the stack. */
  private end(kind: SyntaxKind): NodeId {
    const list = this.stack.pop();
    if (list === undefined) throw new Error("internal: end() without begin()");
    let start = -1;
    let stop = -1;
    let missingAt = -1;
    for (const child of list) {
      const ck = this.nodeKinds[child];
      if (ck === SyntaxKind.Missing) {
        if (missingAt < 0) missingAt = this.nodeStarts[child];
        continue;
      }
      if (
        ck === SyntaxKind.Token &&
        this.kinds[this.nodeTokens[child]] === TokenKind.Newline
      ) {
        continue;
      }
      if (start < 0) start = this.nodeStarts[child];
      stop = this.nodeEnds[child];
    }
    if (start < 0) {
      start = missingAt >= 0 ? missingAt : this.prevEnd();
      stop = start;
    }
    const id = this.newNode(kind, start, stop, -1);
    this.nodeChildStart[id] = this.flat.length;
    for (const child of list) {
      this.flat.push(child);
      this.nodeParents[child] = id;
    }
    this.nodeChildEnd[id] = this.flat.length;
    if (this.stack.length > 0) this.top().push(id);
    return id;
  }

  private checkpoint(): number {
    return this.top().length;
  }

  /** Makes the items added since `cp` the children of a new node. */
  private wrap(cp: number, kind: SyntaxKind): NodeId {
    const items = this.top().splice(cp);
    this.stack.push(items);
    return this.end(kind);
  }

  // ---------------------------------------------------------------- token access

  private leaf(): NodeId {
    const t = this.pos;
    const id = this.newNode(SyntaxKind.Token, this.starts[t], this.ends[t], t);
    this.top().push(id);
    this.pos++;
    return id;
  }

  private tok(): NodeId {
    if (this.kinds[this.pos] === TokenKind.Eof) {
      throw new Error("internal: consumed Eof token");
    }
    return this.leaf();
  }

  /**
   * Consumes newline tokens so that an item continues on the next line. It keeps
   * the newlines when a declaration starts on the next line: no expression or
   * type can start with a declaration keyword, so the item is incomplete.
   */
  private skipNl(): void {
    if (this.kinds[this.pos] !== TokenKind.Newline) return;
    const p = this.laPos();
    const k = this.kinds[p];
    if (
      k === TokenKind.KwConst || k === TokenKind.KwImport ||
      k === TokenKind.KwExport ||
      (this.isDeclarationWord(p) && this.kinds[p + 1] === TokenKind.Ident)
    ) {
      return;
    }
    while (this.kinds[this.pos] === TokenKind.Newline) this.leaf();
  }

  private skipSeps(): void {
    while (
      this.kinds[this.pos] === TokenKind.Newline ||
      this.kinds[this.pos] === TokenKind.Semicolon
    ) {
      this.leaf();
    }
  }

  /**
   * The current token kind. Outside significant-newline contexts it consumes
   * newline tokens first. Inside a construct whose opening bracket has no match,
   * a declaration keyword at the start of a line reads as Eof.
   */
  private kind(): TokenKind {
    if (!this.sig) {
      while (this.kinds[this.pos] === TokenKind.Newline) this.leaf();
    }
    if (this.unmatched > 0 && this.atDeclarationStart(false)) {
      return TokenKind.Eof;
    }
    return this.kinds[this.pos] as TokenKind;
  }

  private isRealEof(): boolean {
    return this.kinds[this.pos] === TokenKind.Eof;
  }

  /** Position of the next token that is not a newline, without consuming. */
  private laPos(): number {
    let p = this.pos;
    while (this.kinds[p] === TokenKind.Newline) p++;
    return p;
  }

  private la(): TokenKind {
    return this.kinds[this.laPos()] as TokenKind;
  }

  /** True when the token at `pos` starts a declaration and sits first on its line. */
  private atDeclarationStart(constAnyColumn: boolean): boolean {
    const p = this.pos;
    if (p === 0 || this.kinds[p - 1] !== TokenKind.Newline) return false;
    switch (this.kinds[p]) {
      case TokenKind.KwImport:
      case TokenKind.KwExport:
        return true;
      case TokenKind.KwConst:
        return constAnyColumn ||
          this.lexed.triviaEnd[p - 1] === this.lexed.triviaEnd[p];
      case TokenKind.Ident:
        return this.isDeclarationWord(p) &&
          this.kinds[p + 1] === TokenKind.Ident;
      default:
        return false;
    }
  }

  private isDeclarationWord(p: number): boolean {
    if (this.kinds[p] !== TokenKind.Ident) return false;
    const len = this.ends[p] - this.starts[p];
    if (len < 4 || len > 8) return false;
    return DECL_WORDS.has(this.text.slice(this.starts[p], this.ends[p]));
  }

  private isWordAt(p: number, word: string): boolean {
    return isWord(this.lexed, p, word);
  }

  /** True when `fails` or `uses` starts a clause here, possibly after newlines. */
  private clauseAhead(word: string): boolean {
    const p = this.laPos();
    return this.isWordAt(p, word) && this.kinds[p + 1] === TokenKind.Ident;
  }

  // ---------------------------------------------------------------- groups

  private open(inner: "sig" | "free"): Group {
    const index = this.pos;
    this.tok();
    const group: Group = {
      sig: this.sig,
      unmatched: this.match[index] < 0 ? 1 : 0,
    };
    this.sig = inner === "sig";
    this.unmatched += group.unmatched;
    return group;
  }

  private close(group: Group, closer: TokenKind, label: string): void {
    this.expect(closer, label);
    this.sig = group.sig;
    this.unmatched -= group.unmatched;
  }

  // ---------------------------------------------------------------- diagnostics

  private prevEnd(): number {
    let p = this.pos - 1;
    while (p >= 0 && this.kinds[p] === TokenKind.Newline) p--;
    return p < 0 ? 0 : this.ends[p];
  }

  private foundDescription(): string {
    const raw = this.kinds[this.pos] as TokenKind;
    if (raw === TokenKind.Eof) return "end of file";
    if (raw === TokenKind.Newline) return "end of line";
    if (this.unmatched > 0 && this.atDeclarationStart(false)) {
      return "the start of the next declaration";
    }
    if (
      raw === TokenKind.Ident || raw === TokenKind.Number ||
      raw === TokenKind.String || isKeywordKind(raw)
    ) {
      const t = this.text.slice(this.starts[this.pos], this.ends[this.pos]);
      return `\`${t.length > 24 ? t.slice(0, 24) + "..." : t}\``;
    }
    return describeTokenKind(raw);
  }

  /**
   * The span of a problem at the current token. A token is its own span, except
   * for a missing-token problem, where `atPreviousEnd` is true: if the token is
   * the last on its line or sits on a later line, the span is empty and ends the
   * last real token, so the problem shows where the text is incomplete.
   */
  private errorSpan(atPreviousEnd: boolean): { start: number; end: number } {
    const raw = this.kinds[this.pos];
    const afterNewline = this.pos > 0 &&
      this.kinds[this.pos - 1] === TokenKind.Newline;
    if (
      raw === TokenKind.Eof || raw === TokenKind.Newline ||
      (atPreviousEnd && afterNewline)
    ) {
      const at = this.prevEnd();
      return { start: at, end: at };
    }
    return { start: this.starts[this.pos], end: this.ends[this.pos] };
  }

  private report(
    code: DiagnosticCode,
    message: string,
    start: number,
    end: number,
  ): void {
    this.diagnostics.push(
      makeDiagnostic(code, message, { source: this.source, start, end }),
    );
  }

  /**
   * Reports a syntax problem at the current token, once. It stays silent when the
   * lexer already reported the token, or when an earlier problem has the same
   * token or the same span.
   */
  private problem(
    code: DiagnosticCode,
    message: string,
    atPreviousEnd: boolean,
  ): void {
    if (this.kinds[this.pos] === TokenKind.Unknown) return;
    const span = this.errorSpan(atPreviousEnd);
    if (
      this.lastErrorPos === this.pos ||
      (span.start === this.lastErrorStart && span.end === this.lastErrorEnd)
    ) {
      return;
    }
    this.lastErrorPos = this.pos;
    this.lastErrorStart = span.start;
    this.lastErrorEnd = span.end;
    this.report(code, message, span.start, span.end);
  }

  private expectedAt(label: string): void {
    this.problem(
      "syntax/008",
      `expected ${label}, found ${this.foundDescription()}`,
      true,
    );
  }

  private unexpectedAt(context: string): void {
    this.problem(
      "syntax/009",
      `unexpected ${this.foundDescription()}${context}`,
      false,
    );
  }

  /** Reports a missing token or construct and adds a zero-width Missing node. */
  private missing(label: string): void {
    this.expectedAt(label);
    const at = this.prevEnd();
    this.top().push(this.newNode(SyntaxKind.Missing, at, at, -1));
  }

  private expect(kind: TokenKind, label: string): boolean {
    if (this.kind() === kind) {
      this.tok();
      return true;
    }
    this.missing(label);
    return false;
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Skips junk into an Error node. Skips at least one token unless at Eof. Jumps
   * over balanced bracket groups. Stops before a token for which `stop` is true,
   * but only after the first token.
   */
  private skipJunk(stop: (k: TokenKind) => boolean, context: string): void {
    this.begin();
    let skipped = 0;
    while (true) {
      const k = this.kind();
      if (k === TokenKind.Eof) break;
      if (skipped > 0 && stop(k)) break;
      if (skipped === 0) this.unexpectedAt(context);
      const open = this.pos;
      const close = k === TokenKind.LParen || k === TokenKind.LBrace ||
          k === TokenKind.LBracket
        ? this.match[open]
        : -1;
      if (close >= 0) {
        while (this.pos <= close) this.leaf();
      } else {
        this.tok();
      }
      skipped++;
    }
    if (skipped === 0) {
      this.stack.pop();
    } else {
      this.end(SyntaxKind.Error);
    }
  }

  /**
   * Guards the recursive entry points. A construct nested deeper than the limit
   * is reported and skipped, so the recursion stays bounded and never overflows.
   * The skip covers one token or one balanced group, so the enclosing levels and
   * the later declarations still parse.
   */
  private enter(): boolean {
    if (this.depth >= MAX_NESTING) {
      this.skipJunk(() => true, "; nesting is too deep");
      return false;
    }
    this.depth++;
    return true;
  }

  private leave(): void {
    this.depth--;
  }

  /** Top-level recovery: skip to the next declaration keyword at the start of a line. */
  private recoverTop(): void {
    this.begin();
    let skipped = 0;
    while (true) {
      if (this.isRealEof()) break;
      if (skipped > 0 && this.atDeclarationStart(true)) break;
      if (skipped === 0) this.unexpectedAt("; expected a declaration");
      this.leaf();
      skipped++;
    }
    if (skipped === 0) {
      this.stack.pop();
    } else {
      this.end(SyntaxKind.Error);
    }
  }

  /** A comma-separated list. The opener is consumed. The caller consumes the closer. */
  private parseCommaList(closer: TokenKind, item: () => void): void {
    while (true) {
      const k = this.kind();
      if (k === closer || k === TokenKind.Eof) break;
      const startPos = this.pos;
      item();
      if (this.kind() === TokenKind.Comma) {
        this.tok();
        continue;
      }
      const k2 = this.kind();
      if (k2 === closer || k2 === TokenKind.Eof) break;
      this.missing("`,`");
      if (this.pos === startPos) {
        this.skipJunk(
          (x) =>
            x === TokenKind.Comma || x === TokenKind.RParen ||
            x === TokenKind.RBracket ||
            x === TokenKind.RBrace,
          "",
        );
      }
    }
  }

  /** Items separated by newlines or semicolons, up to `}`. Used for blocks and service bodies. */
  private parseSeparated(item: () => void): void {
    while (true) {
      this.skipSeps();
      const k = this.kind();
      if (k === TokenKind.RBrace || k === TokenKind.Eof) break;
      item();
      const k2 = this.kind();
      if (
        k2 === TokenKind.Newline || k2 === TokenKind.Semicolon ||
        k2 === TokenKind.RBrace ||
        k2 === TokenKind.Eof
      ) {
        continue;
      }
      this.expectedAt("end of line or `;`");
      this.skipJunk(
        (x) =>
          x === TokenKind.Newline || x === TokenKind.Semicolon ||
          x === TokenKind.RBrace,
        "",
      );
    }
  }

  // ---------------------------------------------------------------- module and declarations

  private parseModule(): NodeId {
    this.begin();
    while (true) {
      this.skipSeps();
      const k = this.kind();
      if (k === TokenKind.Eof) break;
      this.parseTopItem(k);
    }
    this.leaf(); // the Eof token
    return this.end(SyntaxKind.Module);
  }

  private parseTopItem(k: TokenKind): void {
    if (k === TokenKind.KwImport) {
      this.parseImport();
    } else if (
      k === TokenKind.KwExport || k === TokenKind.KwConst ||
      this.isDeclarationWord(this.pos)
    ) {
      this.parseDeclaration();
    } else {
      this.recoverTop();
      return;
    }
    const k2 = this.kind();
    if (
      k2 === TokenKind.Newline || k2 === TokenKind.Semicolon ||
      k2 === TokenKind.Eof
    ) return;
    if (this.atDeclarationStart(true)) return;
    this.expectedAt("end of line or `;`");
    this.recoverTop();
  }

  private parseImport(): void {
    this.begin();
    this.tok(); // import
    if (this.kind() === TokenKind.LBrace) {
      const group = this.open("free");
      this.parseCommaList(TokenKind.RBrace, () => this.parseName("binding"));
      this.close(group, TokenKind.RBrace, "`}`");
    } else {
      this.missing("`{`");
    }
    if (this.kind() === TokenKind.Ident && this.isWordAt(this.pos, "from")) {
      this.tok();
    } else {
      this.missing("`from`");
    }
    if (this.kind() === TokenKind.String) this.tok();
    else this.missing("a string");
    this.end(SyntaxKind.ImportDecl);
  }

  private parseDeclaration(): void {
    this.begin();
    if (this.kind() === TokenKind.KwExport) this.tok();
    const k = this.kind();
    let kind = SyntaxKind.Error;
    if (k === TokenKind.KwConst) {
      kind = SyntaxKind.ConstDecl;
      this.parseConstBody(true);
    } else if (k === TokenKind.Ident && this.isDeclarationWord(this.pos)) {
      const word = this.text.slice(this.starts[this.pos], this.ends[this.pos]);
      if (word === "type") {
        kind = SyntaxKind.TypeDecl;
        this.parseTypeBody();
      } else if (word === "opaque") {
        kind = SyntaxKind.TypeDecl;
        this.parseOpaqueTypeBody();
      } else if (word === "error") {
        kind = SyntaxKind.ErrorDecl;
        this.parseErrorBody();
      } else if (word === "service") {
        kind = SyntaxKind.ServiceDecl;
        this.parseServiceBody();
      } else {
        kind = SyntaxKind.ProviderDecl;
        this.parseProviderBody();
      }
    } else {
      this.missing("a declaration");
    }
    this.end(kind);
  }

  private parseConstBody(topLevel: boolean): void {
    if (topLevel && this.mode === "effi") {
      this.report(
        "syntax/012",
        "a host interface file cannot contain `const`",
        this.starts[this.pos],
        this.ends[this.pos],
      );
    }
    this.tok(); // const
    this.parseName("binding");
    if (this.kind() === TokenKind.Colon) {
      this.tok();
      this.skipNl();
      this.parseType();
    }
    if (this.kind() === TokenKind.Eq) {
      this.tok();
      this.skipNl();
    } else {
      this.missing("`=`");
    }
    this.parseExpr();
  }

  private parseTypeBody(): void {
    this.tok(); // type
    this.parseName("binding");
    if (this.kind() === TokenKind.Eq) {
      this.tok();
      this.skipNl();
    } else {
      this.missing("`=`");
    }
    this.parseType();
  }

  private parseOpaqueTypeBody(): void {
    if (this.mode !== "effi") {
      this.report(
        "syntax/012",
        "an opaque type belongs in a host interface file",
        this.starts[this.pos],
        this.ends[this.pos],
      );
    }
    this.tok(); // opaque
    if (this.kind() === TokenKind.Ident && this.isWordAt(this.pos, "type")) {
      this.tok();
    } else this.missing("`type`");
    this.parseName("binding");
  }

  private parseErrorBody(): void {
    this.tok(); // error
    this.parseName("binding");
    if (this.kind() === TokenKind.Eq) {
      this.tok();
      this.skipNl();
    } else {
      this.missing("`=`");
    }
    if (this.kind() === TokenKind.LBrace) this.parseRecordType();
    else this.missing("a record type");
  }

  private parseServiceBody(): void {
    this.tok(); // service
    this.parseName("binding");
    if (this.kind() === TokenKind.LBrace) {
      const group = this.open("sig");
      this.parseSeparated(() => this.parseServiceMethod());
      this.close(group, TokenKind.RBrace, "`}`");
    } else {
      this.missing("`{`");
    }
  }

  private parseServiceMethod(): void {
    this.begin();
    this.parseName("member");
    this.parseParamList();
    if (this.kind() === TokenKind.Colon) {
      this.tok();
      this.skipNl();
    } else {
      this.missing("`:`");
    }
    this.parseType();
    if (this.clauseAhead("fails")) this.parseFailsClause();
    this.end(SyntaxKind.ServiceMethod);
  }

  private parseProviderBody(): void {
    if (this.mode !== "effi") {
      this.report(
        "syntax/013",
        "a provider declaration is allowed only in a host interface file (.effi)",
        this.starts[this.pos],
        this.ends[this.pos],
      );
    }
    this.tok(); // provider
    this.parseName("binding");
    if (
      this.kind() === TokenKind.Ident && this.isWordAt(this.pos, "provides")
    ) {
      this.begin();
      this.tok();
      this.parseNameSet(true);
      this.end(SyntaxKind.ProvidesClause);
    } else {
      this.missing("`provides`");
    }
    this.parseEffects();
  }

  private parseEffects(): void {
    if (this.clauseAhead("fails")) this.parseFailsClause();
    if (this.clauseAhead("uses")) this.parseUsesClause();
  }

  private parseFailsClause(): void {
    this.skipNl();
    this.begin();
    this.tok(); // fails
    this.parseNameSet(false);
    this.end(SyntaxKind.FailsClause);
  }

  private parseUsesClause(): void {
    this.skipNl();
    this.begin();
    this.tok(); // uses
    this.parseNameSet(true);
    this.end(SyntaxKind.UsesClause);
  }

  /** `Name ("|" Name)*`. Names are qualified (`A.b`) when `qualified` is true. */
  private parseNameSet(qualified: boolean): void {
    while (true) {
      if (qualified) this.parseQualifiedName();
      else this.parseName("member");
      if (this.kind() !== TokenKind.Pipe) break;
      this.tok();
      this.skipNl();
    }
  }

  private parseQualifiedName(): void {
    this.begin();
    this.parseName("member");
    while (this.kind() === TokenKind.Dot) {
      this.tok();
      this.parseName("member");
    }
    this.end(SyntaxKind.QualifiedName);
  }

  /** A Name node. A keyword in a name position is taken as the name and reported. */
  private parseName(role: "binding" | "member" | "type"): void {
    this.begin();
    const k = this.kind();
    if (k === TokenKind.Ident) {
      if (role === "binding" && this.isWordAt(this.pos, "void")) {
        this.report(
          "syntax/007",
          "`void` is a reserved word and cannot be a name",
          this.starts[this.pos],
          this.ends[this.pos],
        );
      }
      this.tok();
    } else if (isKeywordKind(k)) {
      this.expectedAt("a name");
      this.tok();
    } else {
      this.missing("a name");
    }
    this.end(SyntaxKind.Name);
  }

  private parseParamList(): void {
    this.begin();
    if (this.kind() === TokenKind.LParen) {
      const group = this.open("free");
      this.parseCommaList(TokenKind.RParen, () => this.parseParam());
      this.close(group, TokenKind.RParen, "`)`");
    } else {
      this.missing("`(`");
    }
    this.end(SyntaxKind.ParamList);
  }

  private parseParam(): void {
    this.begin();
    if (
      this.kind() === TokenKind.Ident && this.isWordAt(this.pos, "borrow") &&
      this.kinds[this.pos + 1] === TokenKind.Ident
    ) {
      this.tok();
    }
    this.parseName("binding");
    if (this.kind() === TokenKind.Colon) {
      this.tok();
      this.skipNl();
      this.parseType();
    }
    this.end(SyntaxKind.Param);
  }

  // ---------------------------------------------------------------- types

  private parseType(): void {
    const cp = this.checkpoint();
    this.parsePostfixType();
    if (this.kind() !== TokenKind.Pipe) return;
    while (this.kind() === TokenKind.Pipe) {
      this.tok();
      this.skipNl();
      this.parsePostfixType();
    }
    this.wrap(cp, SyntaxKind.UnionType);
  }

  private parsePostfixType(): void {
    const cp = this.checkpoint();
    this.parsePrimaryType();
    while (
      this.kind() === TokenKind.LBracket &&
      this.kinds[this.pos + 1] === TokenKind.RBracket
    ) {
      this.tok();
      this.tok();
      this.wrap(cp, SyntaxKind.ArrayType);
    }
  }

  private parsePrimaryType(): void {
    if (!this.enter()) return;
    this.parsePrimaryTypeInner();
    this.leave();
  }

  private parsePrimaryTypeInner(): void {
    const k = this.kind();
    switch (k) {
      case TokenKind.Ident: {
        const name = this.text.slice(
          this.starts[this.pos],
          this.ends[this.pos],
        );
        const word = TYPE_WORDS.get(name);
        if (word !== undefined && this.kinds[this.pos + 1] === TokenKind.Lt) {
          const isSchema = word.schema !== undefined;
          this.begin();
          this.tok();
          const group = this.open("free");
          if (name === "Layer") {
            this.begin();
            this.parseNameSet(true);
            this.end(SyntaxKind.ProvidesClause);
          } else this.parseType();
          if (name === "Sink") {
            if (this.kind() === TokenKind.Comma) this.tok();
            else this.missing("`,`");
            this.parseType();
          } else if (name === "Schedule" && this.kind() === TokenKind.Comma) {
            this.tok();
            this.parseType();
          } else if (isSchema && this.kind() === TokenKind.Comma) {
            this.tok();
            this.parseType();
          }
          if (isSchema && this.kind() === TokenKind.Comma) {
            this.tok();
            this.begin();
            this.parseNameSet(true);
            this.end(SyntaxKind.UsesClause);
            if (this.kind() === TokenKind.Comma) {
              this.tok();
              this.begin();
              this.parseNameSet(true);
              this.end(SyntaxKind.UsesClause);
              if (this.kind() === TokenKind.Comma) {
                this.tok();
                this.parseType();
              }
            }
          } else if (!isSchema && this.kind() === TokenKind.Comma) {
            this.tok();
            this.begin();
            this.parseNameSet(false);
            this.end(SyntaxKind.FailsClause);
            if (this.kind() === TokenKind.Comma) {
              this.tok();
              this.begin();
              this.parseNameSet(true);
              this.end(SyntaxKind.UsesClause);
              if (name === "Sink" && this.kind() === TokenKind.Comma) {
                this.tok();
                this.parseType();
              }
            }
          }
          this.close(group, TokenKind.Gt, "`>`");
          this.end(word.kind);
          return;
        }
        this.begin();
        this.parseName("type");
        if (this.kind() === TokenKind.Lt) {
          this.begin();
          const group = this.open("free");
          this.parseCommaList(TokenKind.Gt, () => this.parseType());
          this.close(group, TokenKind.Gt, "`>`");
          this.end(SyntaxKind.TypeArgs);
        }
        this.end(SyntaxKind.NamedType);
        return;
      }
      case TokenKind.String:
      case TokenKind.Number:
      case TokenKind.KwTrue:
      case TokenKind.KwFalse:
      case TokenKind.KwNull:
        this.begin();
        this.tok();
        this.end(SyntaxKind.LiteralType);
        return;
      case TokenKind.LBrace:
        this.parseRecordType();
        return;
      case TokenKind.LBracket: {
        this.begin();
        const group = this.open("free");
        this.parseCommaList(TokenKind.RBracket, () => this.parseType());
        this.close(group, TokenKind.RBracket, "`]`");
        this.end(SyntaxKind.TupleType);
        return;
      }
      case TokenKind.LParen:
        if (this.parenFollowedBy(this.pos, false)) {
          this.begin();
          this.parseParamList();
          if (this.la() === TokenKind.Arrow) {
            this.skipNl();
            this.tok();
          } else {
            this.missing("`=>`");
          }
          this.skipNl();
          this.parseType();
          this.parseEffects();
          this.end(SyntaxKind.FunctionType);
        } else {
          this.begin();
          const group = this.open("free");
          this.parseType();
          this.close(group, TokenKind.RParen, "`)`");
          this.end(SyntaxKind.ParenType);
        }
        return;
      default:
        this.missing("a type");
    }
  }

  private parseRecordType(): void {
    this.begin();
    const group = this.open("free");
    this.parseCommaList(TokenKind.RBrace, () => {
      this.begin();
      this.parseName("member");
      if (this.kind() === TokenKind.Question) this.tok();
      if (this.kind() === TokenKind.Colon) {
        this.tok();
        this.skipNl();
      } else {
        this.missing("`:`");
      }
      this.parseType();
      this.end(SyntaxKind.FieldType);
    });
    this.close(group, TokenKind.RBrace, "`}`");
    this.end(SyntaxKind.RecordType);
  }

  /**
   * True when the `(` at `p` has a match and the next token after newlines is
   * `=>`, or `:` when `allowColon` is true.
   */
  private parenFollowedBy(p: number, allowColon: boolean): boolean {
    const m = this.match[p];
    if (m < 0) return false;
    let q = m + 1;
    while (this.kinds[q] === TokenKind.Newline) q++;
    const k = this.kinds[q];
    return k === TokenKind.Arrow || (allowColon && k === TokenKind.Colon);
  }

  // ---------------------------------------------------------------- expressions

  /** Full expression: a pipeline of binary expressions. */
  private parseExpr(): void {
    if (!this.enter()) return;
    this.parseExprInner();
    this.leave();
  }

  private parseExprInner(): void {
    const cp = this.checkpoint();
    this.parseBinary(1);
    while (this.la() === TokenKind.PipeGt) {
      this.skipNl();
      this.tok(); // |>
      this.skipNl();
      this.begin();
      if (this.kind() === TokenKind.Ident) {
        this.parseQualifiedName();
        if (this.kind() === TokenKind.LParen) this.parseArgList();
      } else {
        this.missing("a pipeline stage");
      }
      this.end(SyntaxKind.PipeStage);
      this.wrap(cp, SyntaxKind.PipeExpr);
    }
  }

  private parseBinary(minPrecedence: number): void {
    const cp = this.checkpoint();
    this.parsePostfix();
    while (true) {
      const k = this.kind();
      const p = binaryPrecedence(k);
      if (p === 0 || p < minPrecedence) break;
      this.tok();
      this.skipNl();
      this.parseBinary(p + 1);
      this.wrap(cp, SyntaxKind.BinaryExpr);
    }
  }

  private parsePostfix(): void {
    const cp = this.checkpoint();
    this.parsePrimary();
    while (true) {
      const k = this.kind();
      if (k === TokenKind.LParen) {
        this.parseArgList();
        this.wrap(cp, SyntaxKind.CallExpr);
      } else if (k === TokenKind.Dot) {
        this.tok();
        this.parseName("member");
        this.wrap(cp, SyntaxKind.FieldExpr);
      } else {
        break;
      }
    }
  }

  private parseArgList(): void {
    this.begin();
    const group = this.open("free");
    this.parseCommaList(TokenKind.RParen, () => this.parseExpr());
    this.close(group, TokenKind.RParen, "`)`");
    this.end(SyntaxKind.ArgList);
  }

  private parsePrimary(): void {
    if (!this.enter()) return;
    this.parsePrimaryInner();
    this.leave();
  }

  private parsePrimaryInner(): void {
    const k = this.kind();
    switch (k) {
      case TokenKind.Number:
      case TokenKind.String:
      case TokenKind.KwTrue:
      case TokenKind.KwFalse:
      case TokenKind.KwNull:
        this.begin();
        this.tok();
        this.end(SyntaxKind.LiteralExpr);
        return;
      case TokenKind.Ident:
        this.begin();
        if (this.isWordAt(this.pos, "void")) {
          this.report(
            "syntax/007",
            "`void` is a reserved word and cannot be a name",
            this.starts[this.pos],
            this.ends[this.pos],
          );
        }
        this.tok();
        this.end(SyntaxKind.NameExpr);
        return;
      case TokenKind.LParen:
        if (this.parenFollowedBy(this.pos, true)) {
          this.parseArrow();
        } else {
          this.begin();
          const group = this.open("free");
          this.parseExpr();
          this.close(group, TokenKind.RParen, "`)`");
          this.end(SyntaxKind.ParenExpr);
        }
        return;
      case TokenKind.LBrace:
        this.parseRecordExpr();
        return;
      case TokenKind.LBracket: {
        this.begin();
        const group = this.open("free");
        this.parseCommaList(TokenKind.RBracket, () => this.parseExpr());
        this.close(group, TokenKind.RBracket, "`]`");
        this.end(SyntaxKind.ListExpr);
        return;
      }
      case TokenKind.KwMatch:
        this.parseMatch();
        return;
      case TokenKind.KwIf:
        this.parseIf();
        return;
      case TokenKind.KwTry:
        this.parseTry();
        return;
      case TokenKind.Minus:
      case TokenKind.Plus:
      case TokenKind.Bang: {
        this.begin();
        const hint = k === TokenKind.Minus
          ? "; write `0 - x` for a negative value"
          : k === TokenKind.Bang
          ? "; write `x === false` for a negation"
          : "";
        this.report(
          "syntax/010",
          `unary operator ${describeTokenKind(k)} is not supported${hint}`,
          this.starts[this.pos],
          this.ends[this.pos],
        );
        this.tok();
        this.parsePostfix();
        this.end(SyntaxKind.Error);
        return;
      }
      default:
        this.missing("an expression");
    }
  }

  private parseArrow(): void {
    this.begin();
    this.parseParamList();
    if (this.la() === TokenKind.Colon) {
      this.skipNl();
      this.tok();
      this.skipNl();
      this.parseType();
      this.parseEffects();
    }
    if (this.la() === TokenKind.Arrow) {
      this.skipNl();
      this.tok();
    } else {
      this.missing("`=>`");
    }
    this.skipNl();
    this.parseBody();
    this.end(SyntaxKind.ArrowExpr);
  }

  /** After `=>`: a brace opens a block. Anything else is an expression. */
  private parseBody(): void {
    if (this.kind() === TokenKind.LBrace) this.parseBlock();
    else this.parseExpr();
  }

  private parseBlock(): void {
    this.begin();
    const group = this.open("sig");
    this.parseSeparated(() => {
      if (this.kind() === TokenKind.KwConst) {
        this.begin();
        this.parseConstBody(false);
        this.end(SyntaxKind.ConstDecl);
      } else {
        this.parseExpr();
      }
    });
    this.close(group, TokenKind.RBrace, "`}`");
    this.end(SyntaxKind.Block);
  }

  private parseBlockExpected(): void {
    if (this.kind() === TokenKind.LBrace) this.parseBlock();
    else this.missing("`{`");
  }

  private parseRecordExpr(): void {
    this.begin();
    const group = this.open("free");
    let index = 0;
    this.parseCommaList(TokenKind.RBrace, () => {
      const k = this.kind();
      if (k === TokenKind.DotDotDot) {
        if (index > 0) {
          this.report(
            "syntax/014",
            "a spread must be the first field and appear only once",
            this.starts[this.pos],
            this.ends[this.pos],
          );
        }
        this.begin();
        this.tok();
        this.parseExpr();
        this.end(SyntaxKind.SpreadField);
      } else if (k === TokenKind.Ident) {
        this.begin();
        if (this.kinds[this.pos + 1] === TokenKind.Colon) {
          this.parseName("member");
          this.tok();
          this.skipNl();
          this.parseExpr();
          this.end(SyntaxKind.RecordField);
        } else {
          this.parseName("binding");
          this.end(SyntaxKind.ShorthandField);
        }
      } else {
        this.missing("a field name");
      }
      index++;
    });
    this.close(group, TokenKind.RBrace, "`}`");
    this.end(SyntaxKind.RecordExpr);
  }

  private parseIf(): void {
    if (!this.enter()) return;
    this.parseIfInner();
    this.leave();
  }

  private parseIfInner(): void {
    this.begin();
    this.tok(); // if
    if (this.kind() === TokenKind.LParen) {
      const group = this.open("free");
      this.parseExpr();
      this.close(group, TokenKind.RParen, "`)`");
    } else {
      this.missing("`(`");
    }
    this.parseBlockExpected();
    if (this.la() === TokenKind.KwElse) {
      this.skipNl();
      this.tok();
      if (this.kind() === TokenKind.KwIf) this.parseIf();
      else this.parseBlockExpected();
    } else {
      this.missing("`else`");
    }
    this.end(SyntaxKind.IfExpr);
  }

  private parseMatch(): void {
    this.begin();
    this.tok(); // match
    this.parseExpr();
    if (this.kind() === TokenKind.LBrace) {
      const group = this.open("free");
      this.parseCommaList(TokenKind.RBrace, () => this.parseArm());
      this.close(group, TokenKind.RBrace, "`}`");
    } else {
      this.missing("`{`");
    }
    this.end(SyntaxKind.MatchExpr);
  }

  private parseArm(): void {
    this.begin();
    this.parsePattern();
    if (this.kind() === TokenKind.Arrow) {
      this.tok();
      this.skipNl();
    } else {
      this.missing("`=>`");
    }
    this.parseBody();
    this.end(SyntaxKind.MatchArm);
  }

  private parseTry(): void {
    this.begin();
    this.tok(); // try
    this.parseBlockExpected();
    if (this.la() === TokenKind.KwCatch) {
      this.skipNl();
      this.begin();
      this.tok(); // catch
      if (this.kind() === TokenKind.LBrace) {
        const group = this.open("free");
        this.parseCommaList(TokenKind.RBrace, () => this.parseHandler());
        this.close(group, TokenKind.RBrace, "`}`");
      } else {
        this.missing("`{`");
      }
      this.end(SyntaxKind.CatchClause);
    } else {
      this.missing("`catch`");
    }
    this.end(SyntaxKind.TryExpr);
  }

  private parseHandler(): void {
    this.begin();
    this.parseName("member");
    if (this.kind() === TokenKind.LParen) {
      const group = this.open("free");
      this.parseName("binding");
      this.close(group, TokenKind.RParen, "`)`");
    } else {
      this.missing("`(`");
    }
    if (this.kind() === TokenKind.Arrow) {
      this.tok();
      this.skipNl();
    } else {
      this.missing("`=>`");
    }
    this.parseBody();
    this.end(SyntaxKind.Handler);
  }

  // ---------------------------------------------------------------- patterns

  private isLiteralKind(k: TokenKind): boolean {
    return k === TokenKind.String || k === TokenKind.Number ||
      k === TokenKind.KwTrue ||
      k === TokenKind.KwFalse || k === TokenKind.KwNull;
  }

  private invalidPattern(message: string): void {
    this.problem("syntax/011", message, false);
  }

  private parsePattern(): void {
    const k = this.kind();
    if (k === TokenKind.Ident) {
      this.begin();
      if (this.isWordAt(this.pos, "_")) {
        this.tok();
        this.end(SyntaxKind.WildcardPattern);
      } else if (this.kinds[this.pos + 1] === TokenKind.LParen) {
        this.parseName("member");
        const group = this.open("free");
        if (
          this.kind() === TokenKind.Ident &&
          this.kinds[this.pos + 1] === TokenKind.RParen
        ) {
          this.parseName("binding");
        } else if (this.kind() !== TokenKind.RParen) {
          this.invalidPattern(
            "nested patterns are not supported; bind one name",
          );
          this.skipJunk((x) => x === TokenKind.RParen, "");
        } else {
          this.missing("a name");
        }
        this.close(group, TokenKind.RParen, "`)`");
        this.end(SyntaxKind.CtorPattern);
      } else {
        this.parseName("member");
        this.end(SyntaxKind.NamePattern);
      }
    } else if (this.isLiteralKind(k)) {
      this.begin();
      this.tok();
      this.end(SyntaxKind.LiteralPattern);
    } else if (k === TokenKind.LBrace) {
      this.begin();
      const group = this.open("free");
      this.parseCommaList(TokenKind.RBrace, () => this.parsePatternField());
      this.close(group, TokenKind.RBrace, "`}`");
      this.end(SyntaxKind.RecordPattern);
    } else {
      this.invalidPattern(
        `expected a pattern, found ${this.foundDescription()}`,
      );
      const at = this.prevEnd();
      this.top().push(this.newNode(SyntaxKind.Missing, at, at, -1));
    }
  }

  private parsePatternField(): void {
    const k = this.kind();
    if (k === TokenKind.DotDotDot) {
      this.begin();
      this.tok();
      this.parseName("binding");
      this.end(SyntaxKind.SpreadPattern);
    } else if (k === TokenKind.Ident) {
      this.begin();
      this.parseName("member");
      if (this.kind() === TokenKind.Colon) {
        this.tok();
        this.skipNl();
      } else {
        this.missing("`:`");
      }
      if (this.isLiteralKind(this.kind())) {
        this.begin();
        this.tok();
        this.end(SyntaxKind.LiteralPattern);
      } else {
        this.invalidPattern("a field in a record pattern must match a literal");
        this.skipJunk(
          (x) => x === TokenKind.Comma || x === TokenKind.RBrace,
          "",
        );
      }
      this.end(SyntaxKind.PatternField);
    } else {
      this.invalidPattern(
        `expected a field name or a spread, found ${this.foundDescription()}`,
      );
      const at = this.prevEnd();
      this.top().push(this.newNode(SyntaxKind.Missing, at, at, -1));
    }
  }
}
