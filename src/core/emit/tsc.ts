// The `tsc` oracle on the Effective side (plan sections 5.3 and 6.5, part
// A6b). Two pure functions:
//
// - `parseDenoCheck` reads the text that `deno check` prints on failure and
//   returns its TypeScript diagnostics.
// - `mapTscDiagnostic` maps one TypeScript diagnostic of a generated file back
//   to the Effective source, through the span table of that file.
//
// A diagnostic on a host assertion constant (`const UsersLive$host: ... =
// UsersLive;`) means that the host module disagrees with its declaration file.
// It maps to the code `host-boundary/001` on the imported name in the `.eff`
// import. A diagnostic inside a registered host module means the same thing,
// for example a layer of the declared service that lacks a method. It keeps
// its position in the host module.

import { type Diagnostic, makeDiagnostic } from "../diagnostics.ts";
import type { Span } from "../ir.ts";
import type { ProjectConfig } from "../project.ts";
import {
  hostAssertionAtOffset,
  mapOffset,
  offsetOfGenerated,
  type SpanTable,
} from "./spans.ts";

// ------------------------------------------------------------------ parsing

/** One TypeScript diagnostic from `deno check`. */
export interface TscDiagnostic {
  /** Root-relative with `/` separators when the file lies under the root, else the absolute path. */
  readonly file: string;
  /** One-based. */
  readonly line: number;
  /** One-based, in UTF-16 code units. */
  readonly column: number;
  /** The TypeScript code: 2375 for `TS2375`. */
  readonly code: number;
  /** The first line of the TypeScript message. */
  readonly message: string;
  /** The other lines of the message, the source line, and its underline. */
  readonly detail: string;
}

export interface DenoCheckOutput {
  readonly diagnostics: readonly TscDiagnostic[];
  /**
   * Lines that belong to no diagnostic and that are not progress lines: an
   * `error:` line for a resolution failure, for example. Empty when the output
   * holds only diagnostics.
   */
  readonly other: readonly string[];
}

const HEADER = /^TS(\d+) \[(?:ERROR|WARN)\]: (.*)$/;
const LOCATION = /^\s+at (file:\/\/\S+):(\d+):(\d+)$/;
const PROGRESS = /^(Check|Download|Resolving|Initialize) /;
const SUMMARY = /^error: Type checking failed\.$|^Found \d+ errors?\.$/;

function pathOfFileUrl(url: string): string {
  const path = url.slice("file://".length);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function relativeToRoot(file: string, root: string): string {
  const prefix = root.endsWith("/") ? root : root + "/";
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * Parses the output of `deno check` (stderr, without color codes). `root` is
 * the absolute project directory, as `deno check` prints it. A file under the
 * root gets a root-relative path. Text after the first location of a
 * diagnostic, such as a note about a related declaration, is dropped.
 */
export function parseDenoCheck(text: string, root: string): DenoCheckOutput {
  const diagnostics: TscDiagnostic[] = [];
  const other: string[] = [];
  type Open = {
    readonly code: number;
    readonly message: string;
    readonly detail: string[];
    location: { file: string; line: number; column: number } | undefined;
  };
  let open: Open | undefined;
  const close = (): void => {
    if (open === undefined) return;
    if (open.location === undefined) {
      other.push(`TS${open.code}: ${open.message}`);
    } else {
      diagnostics.push({
        file: relativeToRoot(open.location.file, root),
        line: open.location.line,
        column: open.location.column,
        code: open.code,
        message: open.message,
        detail: open.detail.join("\n"),
      });
    }
    open = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const header = HEADER.exec(raw);
    if (header !== null) {
      close();
      open = {
        code: Number(header[1]),
        message: header[2],
        detail: [],
        location: undefined,
      };
      continue;
    }
    if (open !== undefined) {
      if (SUMMARY.test(raw) || /^error: /.test(raw)) {
        close();
      } else {
        if (open.location !== undefined) continue;
        const location = LOCATION.exec(raw);
        if (location !== null) {
          open.location = {
            file: pathOfFileUrl(location[1]),
            line: Number(location[2]),
            column: Number(location[3]),
          };
        } else {
          open.detail.push(raw);
        }
        continue;
      }
    }
    if (raw.trim() === "" || PROGRESS.test(raw) || SUMMARY.test(raw)) continue;
    other.push(raw);
  }
  close();
  return { diagnostics, other };
}

// ------------------------------------------------------------------ mapping

/** A TypeScript diagnostic mapped to the Effective side. */
export type TscMapping =
  /** The diagnostic lies on a host assertion constant. */
  | {
    readonly tag: "host-boundary";
    readonly diagnostic: Diagnostic;
    readonly tsCode: number;
  }
  /**
   * The diagnostic lies inside a printed node. Correct generated code has no
   * such error, so it points at a defect of the emitter. The span is the
   * innermost source span. Print the code as `TS<tsCode>`.
   */
  | {
    readonly tag: "source";
    readonly span: Span;
    readonly tsCode: number;
    readonly message: string;
  }
  /**
   * The diagnostic lies in a registered host module, so the host module does
   * not fit the types that the generated code declares. The position is in the
   * host module. Print it with the code `host-boundary/001`.
   */
  | {
    readonly tag: "host-module";
    /** The registry key: `providers` for `host:providers`. */
    readonly key: string;
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly tsCode: number;
    readonly message: string;
  }
  /**
   * The diagnostic has no source span: its file has no span table and is not a
   * host module, or its position lies outside every record. The position is in
   * the generated file.
   */
  | {
    readonly tag: "generated";
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly tsCode: number;
    readonly message: string;
  };

/** The root-relative path of each host module to its registry key. */
export function hostModulePaths(
  config: ProjectConfig,
): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const [key, host] of config.host) paths.set(host.modulePath, key);
  return paths;
}

/**
 * Maps one TypeScript diagnostic. `tables` maps the root-relative path of a
 * generated file, such as `users.ts`, to its span table. `hosts` maps the
 * root-relative path of a host module to its registry key; see
 * `hostModulePaths`.
 */
export function mapTscDiagnostic(
  diagnostic: TscDiagnostic,
  tables: ReadonlyMap<string, SpanTable>,
  hosts: ReadonlyMap<string, string> = new Map(),
): TscMapping {
  const key = hosts.get(diagnostic.file);
  if (key !== undefined) {
    return {
      tag: "host-module",
      key,
      file: diagnostic.file,
      line: diagnostic.line,
      column: diagnostic.column,
      tsCode: diagnostic.code,
      message: diagnostic.message,
    };
  }
  const unmapped: TscMapping = {
    tag: "generated",
    file: diagnostic.file,
    line: diagnostic.line,
    column: diagnostic.column,
    tsCode: diagnostic.code,
    message: diagnostic.message,
  };
  const table = tables.get(diagnostic.file);
  if (table === undefined) return unmapped;
  const offset = offsetOfGenerated(table, diagnostic.line, diagnostic.column);
  if (offset === undefined) return unmapped;
  const assertion = hostAssertionAtOffset(table, offset);
  if (assertion !== undefined && assertion.importSpan !== undefined) {
    return {
      tag: "host-boundary",
      tsCode: diagnostic.code,
      diagnostic: makeDiagnostic(
        "host-boundary/001",
        `The host module "${assertion.key}" does not match its declaration file for ${assertion.local}: TS${diagnostic.code} ${diagnostic.message}`,
        assertion.importSpan,
      ),
    };
  }
  const span = mapOffset(table, offset);
  if (span === undefined) return unmapped;
  return {
    tag: "source",
    span,
    tsCode: diagnostic.code,
    message: diagnostic.message,
  };
}
